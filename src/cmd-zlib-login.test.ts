// Tests for `shelf zlib-login`. The real spawn path is exercised manually;
// here we DI a fake runner that lets the test control when "login completes"
// (i.e. when `remix_userid` shows up in the cookie probe).

import { describe, it, expect } from 'vitest';
import { extractUserId, pollForLogin } from './cmd-zlib-login.mjs';

describe('extractUserId', () => {
  it("parses the user id out of playwright-cli's cookie-get line", () => {
    expect(
      extractUserId('remix_userid=12345678 (domain: .z-lib.sk, path: /, httpOnly: false)'),
    ).toBe('12345678');
  });
  it('returns null when the cookie is absent', () => {
    expect(extractUserId('### Result\nnone\n')).toBeNull();
  });
  it('returns null on non-string input', () => {
    expect(extractUserId(undefined as unknown as string)).toBeNull();
  });
});

describe('pollForLogin', () => {
  /**
   * Build a runner that returns no-cookie until the Nth poll, then returns
   * the cookie. Lets us assert the loop both waits and exits on detection.
   */
  function runnerThatLoginsOn(targetPoll: number) {
    let calls = 0;
    return {
      runner: async (_bin: string, _args: string[]) => {
        calls += 1;
        if (calls < targetPoll) {
          return { stdout: '', stderr: '' };
        }
        return { stdout: 'remix_userid=12345678 (domain: .z-lib.sk, path: /)', stderr: '' };
      },
      get calls() {
        return calls;
      },
    };
  }

  it('returns the user id on the poll where the cookie first appears', async () => {
    const r = runnerThatLoginsOn(3);
    const id = await pollForLogin({
      bin: 'pw',
      sessionName: 'zlib',
      runner: r.runner,
      timeoutMs: 1000,
      intervalMs: 10,
    });
    expect(id).toBe('12345678');
    expect(r.calls).toBe(3);
  });

  it('returns null when the deadline passes without a login', async () => {
    const runner = async () => ({ stdout: '', stderr: '' });
    const id = await pollForLogin({
      bin: 'pw',
      sessionName: 'zlib',
      runner,
      timeoutMs: 50,
      intervalMs: 10,
    });
    expect(id).toBeNull();
  });

  it('swallows transient runner failures and keeps polling', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      if (calls === 1) throw new Error('snapshot race');
      return { stdout: 'remix_userid=42', stderr: '' };
    };
    const id = await pollForLogin({
      bin: 'pw',
      sessionName: 'zlib',
      runner,
      timeoutMs: 1000,
      intervalMs: 10,
    });
    expect(id).toBe('42');
    expect(calls).toBe(2);
  });

  it('exits early when the abort signal fires', async () => {
    const ac = new AbortController();
    const runner = async () => {
      setTimeout(() => ac.abort(), 5);
      return { stdout: '', stderr: '' };
    };
    const id = await pollForLogin({
      bin: 'pw',
      sessionName: 'zlib',
      runner,
      timeoutMs: 1000,
      intervalMs: 10,
      signal: ac.signal,
    });
    expect(id).toBeNull();
  });
});
