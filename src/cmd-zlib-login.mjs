// `shelf zlib-login` — interactive sign-in for the z-lib browser session.
//
// One-shot lifecycle:
//   1. Open a headed playwright-cli session named "zlib" with a persistent
//      profile (`--persistent`). The Chrome user-data-dir survives between
//      runs, so cookies live in the profile itself; the saved state file is
//      a portable belt-and-suspenders backup.
//   2. Poll the session's cookies on a slow tick. When `remix_userid` appears
//      we know the user has finished logging in.
//   3. Save state to `.cache/zlib-state.json` (gitignored), close the browser
//      so we don't leave a window hanging, and emit a JSON success result.
//
// Why this exists separately from `retrieve`:
//   - The browser must be HEADED for the human to log in. The retrieve path
//     opens it HEADLESS for actual downloads. Mixing modes in one command
//     would force a re-open mid-flow.
//   - Login is rare (cookies last ~30 days); retrieve is the hot path.
//   - Splitting keeps the agent's logic for "auth expired → tell user to
//     re-login" cleanly separated from the download mechanics.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { log, emit, fail, EXIT } from './output.mjs';
import { ZLIB_STATE_FILE } from './paths.mjs';

const SESSION_NAME = 'zlib';
const LOGIN_URL = 'https://z-lib.sk/';
const DEFAULT_TIMEOUT_S = 300; // 5 minutes
const POLL_INTERVAL_MS = 2000;
const DEFAULT_BIN = 'playwright-cli';

export async function run(opts /*, command */) {
  const bin = opts.bin ?? DEFAULT_BIN;
  const sessionName = opts.session ?? SESSION_NAME;
  const stateFile = opts.stateFile ?? ZLIB_STATE_FILE;
  const timeoutMs = (parsePositiveInt(opts.timeout) ?? DEFAULT_TIMEOUT_S) * 1000;
  const runner = opts.runner ?? defaultRunner;

  await mkdir(dirname(stateFile), { recursive: true });

  log('opening headed browser; sign in to z-lib in the window that just appeared');

  // Open the session headed + persistent. The url positional makes
  // playwright-cli land on the login page immediately.
  try {
    await runner(bin, [`-s=${sessionName}`, 'open', LOGIN_URL, '--headed', '--persistent']);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail(EXIT.USAGE, 'playwright-cli not found on PATH; install it and re-run');
    }
    fail(EXIT.NETWORK, `could not open browser: ${err.message}`);
  }

  // Poll for the login cookie. Slow tick — humans take seconds to type,
  // hitting the cookie endpoint every 100ms would be wasteful and noisy.
  const userId = await pollForLogin({
    bin,
    sessionName,
    runner,
    timeoutMs,
    intervalMs: POLL_INTERVAL_MS,
    signal: opts.signal,
  });

  if (!userId) {
    // Closing on timeout so we don't leave the browser window hanging.
    await runner(bin, [`-s=${sessionName}`, 'close']).catch(() => {});
    fail(EXIT.USAGE, `login did not complete within ${Math.round(timeoutMs / 1000)}s; re-run \`shelf zlib-login\``);
  }

  log(`detected login (userid ${userId}); saving state to ${stateFile}`);
  await runner(bin, [`-s=${sessionName}`, 'state-save', stateFile]);
  await runner(bin, [`-s=${sessionName}`, 'close']).catch(() => {});

  emit(
    {
      userId,
      stateFile,
      sessionName,
      message: 'signed in; subsequent `shelf retrieve` calls will reuse this session',
    },
    opts,
  );
}

// ─── helpers (exported for testing) ──────────────────────────────────────────

/**
 * Poll the session's cookies until `remix_userid` appears or the deadline
 * expires. Returns the user id string on success, null on timeout.
 *
 * @param {{
 *   bin: string,
 *   sessionName: string,
 *   runner: Function,
 *   timeoutMs: number,
 *   intervalMs: number,
 *   signal?: AbortSignal,
 * }} opts
 */
export async function pollForLogin({ bin, sessionName, runner, timeoutMs, intervalMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return null;
    let stdout;
    try {
      const result = await runner(bin, [`-s=${sessionName}`, 'cookie-get', 'remix_userid']);
      stdout = result.stdout;
    } catch {
      // Transient runner failures shouldn't abort the poll — the user might
      // still be typing while a snapshot raced. Just try again on the next tick.
      stdout = '';
    }
    const userId = extractUserId(stdout);
    if (userId) return userId;
    await sleep(intervalMs, signal);
  }
  return null;
}

/**
 * Parse `remix_userid=12345678 (domain: .z-lib.sk, ...)` → "12345678".
 * Returns null when the cookie is absent or the line shape doesn't match.
 */
export function extractUserId(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = stdout.match(/remix_userid=([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function parsePositiveInt(s) {
  if (s == null || s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve(undefined);
      });
    }
  });
}

function defaultRunner(bin, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args);
    } catch (err) {
      return reject(err);
    }
    const out = [];
    const errOut = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => errOut.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(errOut).toString('utf8');
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`playwright-cli exited with code ${code}\n${stderr}`);
      err.code = 'PW_EXIT';
      reject(err);
    });
  });
}
