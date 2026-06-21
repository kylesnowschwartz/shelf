// Tests for the playwright-cli wrapper. We don't drive a real browser here;
// we DI a fake runner that returns the markdown shapes playwright-cli actually
// emits. The integration end of the contract — that playwright-cli speaks
// this exact format — is verified by the manual run-through in the session
// summary (Hatchet, AZW3, 428,796 bytes).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  downloadViaBrowser,
  downloadScript,
  parseResultBlock,
  extractErrorBlock,
  PlaywrightDriverError,
} from './playwright-driver.mjs';

// ─── parseResultBlock ─────────────────────────────────────────────────────────

describe('parseResultBlock', () => {
  it('extracts the JSON between `### Result` and the next section', () => {
    const stdout = [
      '### Result',
      '{"path":"/tmp/x.azw3","sizeBytes":1234,"failure":null}',
      '### Ran Playwright code',
      '```js',
      '...',
      '```',
    ].join('\n');
    expect(parseResultBlock(stdout)).toEqual({
      path: '/tmp/x.azw3',
      sizeBytes: 1234,
      failure: null,
    });
  });

  it('parses a Result block with no following section (EOF terminator)', () => {
    const stdout = '### Result\n{"path":"/p"}\n';
    expect(parseResultBlock(stdout)).toEqual({ path: '/p' });
  });

  it('throws PW_UNAVAILABLE when the Result block is missing', () => {
    expect(() => parseResultBlock('### Snapshot\nnope\n')).toThrow(PlaywrightDriverError);
    try {
      parseResultBlock('### Snapshot\nnope\n');
    } catch (err: any) {
      expect(err.code).toBe('PW_UNAVAILABLE');
    }
  });

  it('throws PW_UNAVAILABLE when the Result body is not valid JSON', () => {
    expect(() => parseResultBlock('### Result\nnot-json\n### Other\n')).toThrow(PlaywrightDriverError);
  });

  it('throws PW_UNAVAILABLE when given a non-string', () => {
    expect(() => parseResultBlock(undefined as unknown as string)).toThrow(PlaywrightDriverError);
  });
});

// ─── extractErrorBlock ──────────────────────────────────────────────────────────────────

describe('extractErrorBlock', () => {
  it('extracts the first line of an `### Error\\n...` block', () => {
    const stdout = '### Error\nError: page.goto: net::ERR_ABORTED at https://x\nCall log:\n  - foo\n';
    expect(extractErrorBlock(stdout)).toBe('Error: page.goto: net::ERR_ABORTED at https://x');
  });
  it('returns null when there is no error block', () => {
    expect(extractErrorBlock('### Page\nfine\n')).toBeNull();
  });
  it('returns null on non-string input', () => {
    expect(extractErrorBlock(undefined as unknown as string)).toBeNull();
  });
});

// ─── downloadScript ─────────────────────────────────────────────────────────────────────

describe('downloadScript', () => {
  it('embeds the dest dir as a JSON-quoted string literal', () => {
    const src = downloadScript('/tmp/foo bar');
    // JSON.stringify wraps in quotes and escapes — guards against spaces /
    // shell-meaningful characters in the dir path.
    expect(src).toContain('"/tmp/foo bar"');
    expect(src).toContain("page.waitForEvent('download'");
  });

  it('probes for the download link before clicking, so a missing button is reported as unavailable not auth-expired', () => {
    const src = downloadScript('/x');
    // The probe must come first — if it doesn't, a missing-button case
    // would fall through to the click + wait branch and be misreported.
    const probeIdx = src.indexOf("page.$('a[href^=\"/dl/\"]')");
    const clickIdx = src.indexOf('dlLink.click()');
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(clickIdx).toBeGreaterThan(probeIdx);
    expect(src).toContain('unavailable: true');
    expect(src).toContain("This book isn't available for download");
  });

  it('returns a clean TimeoutError signal as `authExpired` (not a thrown exception)', () => {
    // We don't execute the script here — just assert the branch exists, so a
    // refactor that removes it gets caught by the test.
    const src = downloadScript('/x');
    expect(src).toContain('authExpired: true');
    expect(src).toContain("err.name === 'TimeoutError'");
  });
});

// ─── downloadViaBrowser ───────────────────────────────────────────────────────

/**
 * Build a fake runner that dispatches on the third argv (the subcommand).
 * Mirrors the real playwright-cli's output shapes.
 */
function fakeRunner(
  responses: Partial<{
    cookieGet: string;
    runCodeResult: object | string; // object → wrapped in ### Result; string → raw stdout
    gotoOk: boolean;
  }>,
) {
  return async (_bin: string, args: string[]) => {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === 'cookie-get') {
      return { stdout: responses.cookieGet ?? '', stderr: '' };
    }
    if (sub === 'goto') {
      if (responses.gotoOk === false) {
        throw new PlaywrightDriverError('PW_UNAVAILABLE', 'goto failed');
      }
      return { stdout: '### Page\nfake\n', stderr: '' };
    }
    if (sub === 'run-code') {
      if (typeof responses.runCodeResult === 'string') {
        return { stdout: responses.runCodeResult, stderr: '' };
      }
      const json = JSON.stringify(responses.runCodeResult ?? {});
      return {
        stdout: `### Result\n${json}\n### Ran Playwright code\n`,
        stderr: '',
      };
    }
    throw new Error(`fake runner: unhandled args ${JSON.stringify(args)}`);
  };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shelf-pwdriver-test-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('downloadViaBrowser', () => {
  it('returns path + size + suggestedFilename on the happy path', async () => {
    // Create a real file at the script-reported path so the size-stat succeeds.
    const reportedPath = join(tmpRoot, 'hatchet.azw3');
    writeFileSync(reportedPath, Buffer.alloc(428796, 0)); // matches real Hatchet size

    const runner = fakeRunner({
      cookieGet: 'remix_userid=12345678 (domain: .z-lib.sk, path: /)',
      runCodeResult: {
        path: reportedPath,
        suggestedFilename: 'hatchet.azw3',
        elapsedMs: 2621,
        failure: null,
      },
    });

    const result = await downloadViaBrowser({
      bookId: 'r9bkkbjyzB',
      destDir: tmpRoot,
      runner,
    });
    expect(result).toEqual({
      path: reportedPath,
      sizeBytes: 428796,
      suggestedFilename: 'hatchet.azw3',
      elapsedMs: 2621,
    });
  });

  it('throws PW_AUTH_REQUIRED when remix_userid is absent', async () => {
    const runner = fakeRunner({
      cookieGet: '', // empty → no remix_userid
    });
    await expect(
      downloadViaBrowser({ bookId: 'r9bkkbjyzB', destDir: tmpRoot, runner }),
    ).rejects.toMatchObject({ code: 'PW_AUTH_REQUIRED' });
  });

  it('throws PW_AUTH_REQUIRED when the script reports a download timeout (auth expired mid-flight)', async () => {
    const runner = fakeRunner({
      cookieGet: 'remix_userid=12345678',
      runCodeResult: { authExpired: true, error: 'Timeout 60000ms exceeded' },
    });
    await expect(
      downloadViaBrowser({ bookId: 'r9bkkbjyzB', destDir: tmpRoot, runner }),
    ).rejects.toMatchObject({ code: 'PW_AUTH_REQUIRED' });
  });

  it('throws PW_DOWNLOAD_FAILED when Playwright reports download.failure()', async () => {
    const runner = fakeRunner({
      cookieGet: 'remix_userid=12345678',
      runCodeResult: {
        path: '/will/not/be/stat',
        suggestedFilename: 'x.azw3',
        elapsedMs: 100,
        failure: 'net::ERR_ABORTED',
      },
    });
    await expect(
      downloadViaBrowser({ bookId: 'r9bkkbjyzB', destDir: tmpRoot, runner }),
    ).rejects.toMatchObject({ code: 'PW_DOWNLOAD_FAILED' });
  });

  it('throws PW_UNAVAILABLE when the script returns no path (defensive guard)', async () => {
    const runner = fakeRunner({
      cookieGet: 'remix_userid=12345678',
      runCodeResult: { suggestedFilename: 'x.azw3', failure: null },
    });
    await expect(
      downloadViaBrowser({ bookId: 'r9bkkbjyzB', destDir: tmpRoot, runner }),
    ).rejects.toMatchObject({ code: 'PW_UNAVAILABLE' });
  });

  it('throws PW_UNAVAILABLE when the runner emits malformed playwright-cli output', async () => {
    const runner = fakeRunner({
      cookieGet: 'remix_userid=12345678',
      runCodeResult: '### Page\nno result here\n',
    });
    await expect(
      downloadViaBrowser({ bookId: 'r9bkkbjyzB', destDir: tmpRoot, runner }),
    ).rejects.toMatchObject({ code: 'PW_UNAVAILABLE' });
  });

  it('throws PW_BOOK_UNAVAILABLE with the DMCA reason when the script reports `unavailable`', async () => {
    const runner = fakeRunner({
      cookieGet: 'remix_userid=12345678',
      runCodeResult: {
        unavailable: true,
        reason: "This book isn't available for download due to the complaint of the copyright holder Macmillan",
      },
    });
    await expect(
      downloadViaBrowser({ bookId: 'pqxgMr3aze', destDir: tmpRoot, runner }),
    ).rejects.toMatchObject({
      code: 'PW_BOOK_UNAVAILABLE',
      message: expect.stringContaining('complaint of the copyright holder'),
    });
  });

  it('throws PW_UNAVAILABLE when playwright-cli emits an `### Error` block on goto (e.g. ERR_ABORTED)', async () => {
    // playwright-cli exits 0 even on navigation failure; the driver MUST detect
    // the error block in stdout or it would silently run the click script
    // against a page that never loaded — misclassifying "stale URL" as
    // "auth expired" downstream.
    const runner = async (_bin: string, args: string[]) => {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub === 'cookie-get') {
        return { stdout: 'remix_userid=12345678 (domain: .z-lib.sk)', stderr: '' };
      }
      if (sub === 'goto') {
        return {
          stdout: '### Error\nError: page.goto: net::ERR_ABORTED at https://z-lib.sk/book/x\nCall log:\n  - foo\n',
          stderr: '',
        };
      }
      throw new Error('runner reached past goto');
    };
    await expect(
      downloadViaBrowser({ bookId: 'M9p27vGnrq', destDir: tmpRoot, runner }),
    ).rejects.toMatchObject({
      code: 'PW_UNAVAILABLE',
      message: expect.stringContaining('ERR_ABORTED'),
    });
  });

  it('rejects calls missing bookId or destDir before spawning anything', async () => {
    await expect(
      downloadViaBrowser({ destDir: tmpRoot, runner: fakeRunner({}) } as any),
    ).rejects.toThrow(PlaywrightDriverError);
    await expect(
      downloadViaBrowser({ bookId: 'x', runner: fakeRunner({}) } as any),
    ).rejects.toThrow(PlaywrightDriverError);
  });

  it('translates ENOENT from the default runner into PW_NOT_INSTALLED', async () => {
    // No `runner` injected — exercise the real spawn path with an impossible binary.
    await expect(
      downloadViaBrowser({
        bookId: 'r9bkkbjyzB',
        destDir: tmpRoot,
        bin: '/nope/playwright-cli-does-not-exist',
      }),
    ).rejects.toMatchObject({ code: 'PW_NOT_INSTALLED' });
  });
});
