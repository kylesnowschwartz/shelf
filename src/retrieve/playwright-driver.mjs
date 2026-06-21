// Browser-driven download path for the z-lib source backend.
//
// Wraps `playwright-cli` to drive a real Chromium session through z-lib's
// download UI, capture Playwright's `download` event, and write the file to a
// staging directory the orchestrator owns. The shelf orchestrator never sees
// this file — it sees the same `source.download` interface as before, with the
// bytes arriving via a real browser instead of a Go HTTP client.
//
// Why a real browser: z-lib's `/dl/<token>` endpoint serves files only to
// service-worker-initiated fetches with browser-class TLS and full
// Cloudflare-required header set. Driving the actual UI bypasses every
// fingerprinting layer because the request *is* a real browser. The full
// debugging history lives in the dry-run summary; the upshot is: the cheapest
// solution that works is the right one.
//
// Lifecycle (the persistent profile is the load-bearing piece):
//   - Session name "zlib", persistent profile (Chrome user-data-dir survives
//     between runs, so login cookies persist for ~30 days)
//   - `shelf zlib-login` opens the session headed, polls cookies, saves state
//   - `shelf retrieve` opens the same session headless, reuses the profile,
//     drives the download, closes
//
// Error vocabulary (translated to SourceError in zlib.mjs):
//   PW_NOT_INSTALLED    — playwright-cli binary missing on PATH
//   PW_AUTH_REQUIRED    — session cookies absent or expired
//   PW_BOOK_UNAVAILABLE — page loaded but the book is not downloadable
//                         (DMCA takedown, region block, structural change)
//   PW_DOWNLOAD_FAILED  — Playwright reported `download.failure() != null`
//   PW_UNAVAILABLE      — generic spawn / parse / navigation failure

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

const SESSION_NAME = 'zlib';
const BOOK_URL_BASE = 'https://z-lib.sk/book/';
const DEFAULT_BIN = 'playwright-cli';
const DOWNLOAD_TIMEOUT_MS = 60_000;

export class PlaywrightDriverError extends Error {
  constructor(code, message, { cause, stderr } = {}) {
    super(message);
    this.name = 'PlaywrightDriverError';
    this.code = code;
    if (cause) this.cause = cause;
    if (stderr) this.stderr = stderr;
  }
}

/**
 * Drive `playwright-cli` through z-lib's download UI for one book.
 *
 * The session must already exist and be authenticated. Run `shelf zlib-login`
 * to create it. Auth is checked up-front (cookie probe) so we fail fast with
 * a clear message instead of waiting for the download timeout.
 *
 * @param {{
 *   bookId: string,         // z-lib URL path-segment id (e.g. "r9bkkbjyzB"); NOT the numeric Book.id
 *   destDir: string,        // existing directory to save into
 *   sessionName?: string,   // playwright-cli session name; defaults to "zlib"
 *   bin?: string,           // playwright-cli binary; defaults to PATH lookup
 *   runner?: (bin: string, args: string[], opts?: object) => Promise<{stdout: string, stderr: string}>,
 *                           // DI seam for tests; bypasses spawn entirely
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{
 *   path: string,             // absolute path of the saved file
 *   sizeBytes: number,
 *   suggestedFilename: string,
 *   elapsedMs: number,
 * }>}
 */
export async function downloadViaBrowser(opts) {
  if (!opts || !opts.bookId) {
    throw new PlaywrightDriverError('PW_UNAVAILABLE', 'downloadViaBrowser requires bookId');
  }
  if (!opts.destDir) {
    throw new PlaywrightDriverError('PW_UNAVAILABLE', 'downloadViaBrowser requires destDir');
  }

  const session = opts.sessionName ?? SESSION_NAME;
  const bin = opts.bin ?? DEFAULT_BIN;
  const runner = opts.runner ?? defaultRunner;
  const runOpts = { signal: opts.signal };
  // 1. Auth probe. Fail fast with a useful error if cookies are missing —
  //    waiting 60s for the download timeout would be a worse experience.
  const cookieProbe = await callRunner(runner, bin, [`-s=${session}`, 'cookie-get', 'remix_userid'], runOpts);
  if (!/remix_userid=\S+/.test(cookieProbe.stdout)) {
    throw new PlaywrightDriverError(
      'PW_AUTH_REQUIRED',
      'no z-lib session cookie; run `npm run shelf -- zlib-login` to sign in',
    );
  }

  // 2. Navigate to the book detail page. `callRunner` translates an
  //    `### Error` block (e.g. net::ERR_ABORTED on a stale URL) into a
  //    PW_UNAVAILABLE failure even though playwright-cli itself exits 0.
  await callRunner(runner, bin, [`-s=${session}`, 'goto', `${BOOK_URL_BASE}${opts.bookId}`], runOpts);

  // 3. Run the download script. It first probes for the download link; if
  //    absent, it reports `unavailable` with a precise reason (catches DMCA
  //    banners and structural changes). Otherwise it clicks + waits for the
  //    download event. A TimeoutError on the download wait is the auth-
  //    expired signal (cookies present but the click did not produce a file).
  const code = downloadScript(opts.destDir);
  const result = await callRunner(runner, bin, [`-s=${session}`, 'run-code', code], runOpts);
  const parsed = parseResultBlock(result.stdout);

  if (parsed.unavailable) {
    throw new PlaywrightDriverError(
      'PW_BOOK_UNAVAILABLE',
      parsed.reason || 'book not available for download on this source',
    );
  }
  if (parsed.authExpired) {
    throw new PlaywrightDriverError(
      'PW_AUTH_REQUIRED',
      'session cookies present but download timed out (likely expired); run `npm run shelf -- zlib-login`',
    );
  }
  if (parsed.failure) {
    throw new PlaywrightDriverError('PW_DOWNLOAD_FAILED', `download failed: ${parsed.failure}`);
  }
  if (!parsed.path) {
    throw new PlaywrightDriverError('PW_UNAVAILABLE', 'driver returned no file path');
  }

  // 4. Size comes from Node (not from inside the browser script) so the
  //    contract is a single trusted measurement and the script stays simple.
  const sizeBytes = (await stat(parsed.path)).size;
  return {
    path: parsed.path,
    sizeBytes,
    suggestedFilename: parsed.suggestedFilename,
    elapsedMs: parsed.elapsedMs,
  };
}

/**
 * Wrapper around the injected runner that ALSO interprets `### Error` blocks
 * in playwright-cli's stdout as failures. The CLI emits these on navigation
 * errors (e.g. `net::ERR_ABORTED` on a stale URL) but still exits 0, so a
 * caller checking only the exit code would silently proceed against a page
 * that never loaded. Pure runner stays the transport; this layer interprets.
 */
async function callRunner(runner, bin, args, runOpts) {
  const result = await runner(bin, args, runOpts);
  const errMsg = extractErrorBlock(result.stdout);
  if (errMsg) {
    throw new PlaywrightDriverError('PW_UNAVAILABLE', `playwright-cli reported error: ${errMsg}`);
  }
  return result;
}

/**
 * Pull the first line of the `### Error\n` block from playwright-cli output,
 * if present. Returns null when there's no error block.
 *
 * Pure function (exported for testing).
 */
export function extractErrorBlock(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = stdout.match(/### Error\n([^\n]+)/);
  return m ? m[1].trim() : null;
}

/**
 * Build the JS source `playwright-cli run-code` evaluates inside the browser
 * context. Returns a string the script will JSON-serialize back to stdout via
 * playwright-cli's `### Result` block.
 *
 * Pure function (exported for testing).
 */
export function downloadScript(destDir) {
  const dirLiteral = JSON.stringify(destDir);
  return `async page => {
  // Probe for the download link FIRST. If it isn't there, the book is not
  // downloadable (DMCA banner, region block, account-tier gate); clicking and
  // waiting 60s for a download event would be the wrong way to find out.
  const dlLink = await page.$('a[href^="/dl/"]');
  if (!dlLink) {
    const dmca = await page.evaluate(() => {
      const text = document.body && document.body.innerText || '';
      const m = text.match(/This book isn't available for download[^\\n]*/);
      return m ? m[0].trim() : null;
    });
    return {
      unavailable: true,
      reason: dmca || 'no download button on book page (possibly DMCA, region block, or stale URL)',
    };
  }
  const start = Date.now();
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: ${DOWNLOAD_TIMEOUT_MS} }),
      dlLink.click()
    ]);
    const suggestedFilename = download.suggestedFilename();
    const path = ${dirLiteral} + '/' + suggestedFilename;
    await download.saveAs(path);
    const elapsedMs = Date.now() - start;
    const failure = await download.failure();
    return { path, suggestedFilename, elapsedMs, failure };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { authExpired: true, error: err.message };
    }
    throw err;
  }
}`;
}

/**
 * Extract the JSON payload from playwright-cli's markdown output. The CLI
 * emits sections delimited by `### Heading\n`; the result block is the JSON
 * between `### Result` and the next `###` (or EOF).
 *
 * Pure function (exported for testing).
 */
export function parseResultBlock(stdout) {
  if (typeof stdout !== 'string') {
    throw new PlaywrightDriverError('PW_UNAVAILABLE', 'parseResultBlock requires a string');
  }
  const m = stdout.match(/### Result\n([\s\S]*?)(?:\n### |\n###\n|$)/);
  if (!m) {
    throw new PlaywrightDriverError('PW_UNAVAILABLE', 'no `### Result` block in playwright-cli output');
  }
  const body = m[1].trim();
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new PlaywrightDriverError(
      'PW_UNAVAILABLE',
      `cannot parse Result JSON: ${err.message}`,
      { cause: err },
    );
  }
}

// ─── default runner ──────────────────────────────────────────────────────────

function defaultRunner(bin, args, { env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, signal });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return reject(
          new PlaywrightDriverError('PW_NOT_INSTALLED', `${bin} not found on PATH`, { cause: err }),
        );
      }
      return reject(err);
    }
    const out = [];
    const errOut = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => errOut.push(chunk));
    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        return reject(
          new PlaywrightDriverError('PW_NOT_INSTALLED', `${bin} not found on PATH`, { cause: err }),
        );
      }
      reject(err);
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(errOut).toString('utf8');
      if (code === 0) return resolve({ stdout, stderr });
      reject(
        new PlaywrightDriverError('PW_UNAVAILABLE', `playwright-cli exited with code ${code}`, { stderr }),
      );
    });
  });
}
