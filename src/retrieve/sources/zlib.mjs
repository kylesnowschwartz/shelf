// Source backend: z-lib via a binary-first transport with a browser fallback.
//
//   search()   → shells out to the `zlib` Go binary (heartleo fork, --json,
//                v0.0.5+). The HTML page endpoint z-lib uses for search is
//                lenient on client fingerprints — a headless Go client gets
//                clean JSON back, fast.
//
//   download() → tries the SAME binary first (`zlib download <id> --json`).
//                v0.0.5 fixed the long-standing HTTP 204 bug: the binary now
//                resolves the real `/dl/` URL from the page's inline script
//                instead of the decoy href, so the Go HTTP client downloads
//                directly — no browser needed. See heartleo/zlib issue #4.
//
//                On ANY binary failure except a genuine SOURCE_NOT_FOUND, it
//                falls back to a persistent Playwright Chromium session
//                (playwright-driver.mjs). The two paths authenticate against
//                INDEPENDENT session stores — the binary uses
//                ~/.config/zlib/session.json (refreshed by `zlib login`); the
//                browser uses its own persistent profile (refreshed by
//                `shelf zlib-login`). A download only truly fails when BOTH
//                sessions are dead, which is the only time the caller sees
//                SOURCE_AUTH_REQUIRED.
//
// This file is the ONLY place in shelf that knows about z-lib. Everything
// upstream sees opaque `sourceId` strings ("zlib:r9bkkbjyzB") and generic
// fields. Adding a second source means adding a sibling file under sources/
// and routing on the `sourceId` prefix; nothing above changes.
//
// Binary discovery (search path) is layered:
//   1) $SHELF_RETRIEVE_BIN if set (explicit override)
//   2) ~/Code/my-projects/zlib/zlib if it exists (Kyle's dev layout)
//   3) `zlib` on PATH (e.g. after `go install` or a symlink)
//
// Source-specific failure modes are translated to a stable error vocabulary
// (SOURCE_AUTH_REQUIRED, SOURCE_NOT_FOUND, SOURCE_UNAVAILABLE) so error
// messages never leak the backend's identity to higher layers.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { downloadViaBrowser, PlaywrightDriverError } from '../playwright-driver.mjs';

export const SOURCE_NAME = 'zlib';

export class SourceError extends Error {
  constructor(code, message, { cause, stderr } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code; // SOURCE_AUTH_REQUIRED | SOURCE_NOT_FOUND | SOURCE_UNAVAILABLE | SOURCE_BIN_MISSING
    if (cause) this.cause = cause;
    if (stderr) this.stderr = stderr;
  }
}

/**
 * Resolve the path to the zlib binary. Pure function, no spawning — callers
 * that want to verify the binary is runnable should do so themselves.
 *
 * @param {{ env?: Record<string,string>, home?: string }} [overrides] — for tests.
 */
export function resolveBinary({ env = process.env, home = homedir() } = {}) {
  const override = env.SHELF_RETRIEVE_BIN;
  if (override) return override;
  const devPath = join(home, 'Code', 'my-projects', 'zlib', 'zlib');
  if (existsSync(devPath)) return devPath;
  return 'zlib'; // last-ditch: trust PATH
}

/**
 * Run the zlib binary and capture its stdout/stderr/exit code.
 * Treats every non-zero exit as an error the caller must interpret.
 *
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runBinary(bin, args, { env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, signal });
    } catch (err) {
      // ENOENT etc. — binary not found at the resolved path
      if (err.code === 'ENOENT') {
        return reject(
          new SourceError(
            'SOURCE_BIN_MISSING',
            `binary not found at ${bin}; set SHELF_RETRIEVE_BIN or symlink it onto PATH`,
            { cause: err },
          ),
        );
      }
      return reject(err);
    }
    const out = [];
    const errOut = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => errOut.push(chunk));
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        return reject(
          new SourceError(
            'SOURCE_BIN_MISSING',
            `binary not found at ${bin}; set SHELF_RETRIEVE_BIN or symlink it onto PATH`,
            { cause: err },
          ),
        );
      }
      reject(err);
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(errOut).toString('utf8');
      if (code === 0) return resolve({ stdout, stderr });
      reject(classifyExit(code, stderr, { stdout }));
    });
  });
}

// Classify a non-zero exit into the generic error vocabulary. The stderr
// inspection looks for stable substrings that heartleo's `formatCLIError`
// produces (see internal/cli/root.go). Invoked by both search() and the
// binary download path: download failures the binary emits ("no download URL
// available", "download failed: HTTP 204", redirect overflow) have no
// dedicated branch here, so they fall through to the SOURCE_UNAVAILABLE
// default — which is exactly what makes download() fall back to the browser.
function classifyExit(code, stderr, { stdout = '' } = {}) {
  const blob = `${stderr}\n${stdout}`.toLowerCase();
  if (blob.includes('not logged in') || blob.includes('session expired')) {
    return new SourceError('SOURCE_AUTH_REQUIRED', 'source requires authentication; log in to the backend separately', { stderr });
  }
  if (blob.includes('no results found')) {
    return new SourceError('SOURCE_NOT_FOUND', 'source returned no matching book', { stderr });
  }
  if (blob.includes('network request failed') || blob.includes('challenge')) {
    return new SourceError('SOURCE_UNAVAILABLE', 'source temporarily unavailable; retry later', { stderr });
  }
  return new SourceError('SOURCE_UNAVAILABLE', `source exited with code ${code}`, { stderr });
}

// Build the free-text query string from caller-provided fields. ISBN wins
// when present (most precise); otherwise `${title} ${author}`. The source
// backend treats the query as opaque text — the binary's search endpoint
// does its own matching against title / author / ISBN columns.
function buildQuery({ isbn, title, author }) {
  if (isbn) return String(isbn).trim();
  if (title && author) return `${String(title).trim()} ${String(author).trim()}`;
  throw new SourceError('SOURCE_BIN_MISSING', 'search requires either --isbn or both --title and --author');
}

/**
 * Search the source for a book matching the given identifiers. Translates
 * the source-specific response into the generic Candidate shape.
 *
 * @param {{
 *   isbn?: string,
 *   title?: string,
 *   author?: string,
 *   extensions?: string[],
 *   count?: number,
 *   signal?: AbortSignal,
 *   bin?: string,    // override for tests
 *   env?: object,    // override for tests
 * }} opts
 * @returns {Promise<{ candidates: Candidate[], page: number, totalPages: number }>}
 */
export async function search(opts = {}) {
  const bin = opts.bin ?? resolveBinary({ env: opts.env });
  const query = buildQuery(opts);
  const args = ['search', query, '--json'];
  if (Array.isArray(opts.extensions)) {
    for (const ext of opts.extensions) {
      args.push('--ext', String(ext).toLowerCase());
    }
  }
  if (Number.isInteger(opts.count) && opts.count > 0) {
    args.push('--count', String(opts.count));
  }

  const { stdout } = await runBinary(bin, args, { env: opts.env, signal: opts.signal });
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (err) {
    throw new SourceError('SOURCE_UNAVAILABLE', 'source emitted invalid JSON', { cause: err });
  }
  const books = Array.isArray(payload.books) ? payload.books : [];
  return {
    candidates: books.map(toCandidate),
    // Preserve 0 from the source (legit "no pages") instead of falling through
    // to 1 via `|| 1`. Default to 1 only when the field is missing/non-numeric.
    page: Number.isFinite(Number(payload.page)) ? Number(payload.page) : 1,
    totalPages: Number.isFinite(Number(payload.total_pages)) ? Number(payload.total_pages) : 1,
  };
}

/**
 * Download a previously-found candidate by its opaque sourceId.
 *
 * Tries the zlib binary first; falls back to the persistent Playwright session
 * on any binary failure except SOURCE_NOT_FOUND (a genuine "no copy exists" —
 * the browser can't conjure one either). The two transports authenticate
 * against independent sessions, so the fallback covers the case where the
 * binary's session has expired but the browser's has not. The destination
 * directory must already exist. Returns the absolute path to the written file,
 * tagged with the `transport` that delivered it.
 *
 * @param {{
 *   sourceId: string,                // 'zlib:<book-id>'
 *   destDir: string,
 *   signal?: AbortSignal,
 *   bin?: string,                    // zlib binary override (tests)
 *   env?: object,                    // env override (tests)
 *   pwBin?: string,                  // playwright-cli override (tests)
 *   pwRunner?: Function,             // DI seam: bypass spawn (tests)
 *   pwSessionName?: string,          // default 'zlib'
 * }} opts
 * @returns {Promise<{ path: string, sizeBytes: number|null, format: string|null, name: string|null, transport: 'binary'|'browser' }>}
 */
export async function download(opts = {}) {
  if (!opts.sourceId) throw new SourceError('SOURCE_BIN_MISSING', 'download requires sourceId');
  if (!opts.destDir) throw new SourceError('SOURCE_BIN_MISSING', 'download requires destDir');
  const id = parseSourceId(opts.sourceId);

  try {
    return await downloadViaBinary({ id, destDir: opts.destDir, bin: opts.bin, env: opts.env, signal: opts.signal });
  } catch (err) {
    // A genuine "no copy exists" won't be cured by switching transports, and
    // the binary's precise reason is worth preserving — don't fall back.
    if (err instanceof SourceError && err.code === 'SOURCE_NOT_FOUND') throw err;
    // Every other binary failure (HTTP 204, transport, auth, missing binary)
    // → try the browser, whose independent session may still be alive.
    return await downloadViaBrowserSession(id, opts);
  }
}

/**
 * Primary download path: the zlib binary's own `download --json`. Reuses the
 * runBinary + classifyExit plumbing search() uses, so binary failures arrive
 * as SourceErrors the caller can branch on.
 */
async function downloadViaBinary({ id, destDir, bin, env, signal }) {
  const resolvedBin = bin ?? resolveBinary({ env });
  const args = ['download', id, '--json', '--dir', destDir];
  const { stdout } = await runBinary(resolvedBin, args, { env, signal });
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (err) {
    throw new SourceError('SOURCE_UNAVAILABLE', 'source emitted invalid JSON on download', { cause: err });
  }
  if (!payload || typeof payload.path !== 'string' || !payload.path) {
    throw new SourceError('SOURCE_UNAVAILABLE', 'source download produced no file path');
  }
  return {
    path: payload.path,
    sizeBytes: Number.isFinite(Number(payload.size)) ? Number(payload.size) : null,
    format: extractFormat(payload.path),
    // The binary's JSON `name` is already the clean book title — no marketing
    // suffix to strip (unlike the browser's suggestedFilename below).
    name: payload.name || null,
    transport: 'binary',
  };
}

/**
 * Fallback download path: drive the persistent Playwright session. Translates
 * the browser driver's error vocabulary into SourceErrors so the caller sees a
 * uniform contract regardless of which transport ran.
 */
async function downloadViaBrowserSession(id, opts) {
  let result;
  try {
    result = await downloadViaBrowser({
      bookId: id,
      destDir: opts.destDir,
      sessionName: opts.pwSessionName,
      bin: opts.pwBin,
      runner: opts.pwRunner,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof PlaywrightDriverError) {
      throw translateDriverError(err);
    }
    throw err;
  }

  return {
    path: result.path,
    sizeBytes: result.sizeBytes,
    format: extractFormat(result.path),
    // `name` lets --source-id callers derive a delivery title without having
    // gone through search first. The browser driver's `suggestedFilename`
    // includes z-lib's marketing suffix (" (z-library.sk, 1lib.sk, ...)");
    // strip it back to the title proper.
    name: titleFromSuggestedFilename(result.suggestedFilename),
    transport: 'browser',
  };
}

/**
 * Translate a browser-driver failure into a SourceError so the generic
 * error vocabulary stays the same regardless of which transport ran.
 */
function translateDriverError(err) {
  switch (err.code) {
    case 'PW_AUTH_REQUIRED':
      return new SourceError('SOURCE_AUTH_REQUIRED', err.message, { cause: err });
    case 'PW_NOT_INSTALLED':
      return new SourceError(
        'SOURCE_BIN_MISSING',
        'playwright-cli not found on PATH; install it and re-run',
        { cause: err },
      );
    case 'PW_BOOK_UNAVAILABLE':
      // The book page loaded but the file is not deliverable (DMCA, region
      // block, account-tier gate). Preserve the precise reason — the agent's
      // recovery action depends on it (try a different edition? give up?).
      return new SourceError('SOURCE_NOT_FOUND', err.message, { cause: err });
    case 'PW_DOWNLOAD_FAILED':
    case 'PW_UNAVAILABLE':
    default:
      return new SourceError('SOURCE_UNAVAILABLE', err.message, { cause: err });
  }
}

/**
 * Strip z-lib's marketing suffix from a downloaded filename to recover the
 * delivery title. "Hatchet (Gary Paulsen) (z-library.sk, 1lib.sk, z-lib.sk).azw3"
 * → "Hatchet (Gary Paulsen)". Returns null when the input lacks the suffix
 * (then the caller falls back to user-supplied --title).
 */
export function titleFromSuggestedFilename(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  // Drop trailing extension.
  const stem = filename.replace(/\.[a-zA-Z0-9]+$/, '');
  // Drop the z-lib marketing parenthetical anywhere in the name.
  const cleaned = stem.replace(/\s*\(z-library\.sk[^)]*\)\s*/i, '').trim();
  return cleaned || null;
}

// ─── helpers (exported for testing) ──────────────────────────────────────

/**
 * Translate one zlib Book into a generic Candidate. Field names use the
 * source-agnostic vocabulary the orchestrator depends on; the only
 * source-specific value is the namespaced `sourceId`.
 */
export function toCandidate(book) {
  return {
    sourceId: `${SOURCE_NAME}:${bookIdFromUrl(book.url) || book.id || ''}`,
    title: book.name ?? '',
    authors: Array.isArray(book.authors) ? book.authors : [],
    year: parseYear(book.year),
    format: book.extension ? String(book.extension).toLowerCase() : null,
    sizeBytes: parseSize(book.size),
    sizeText: book.size ?? null,
    language: book.language ?? null,
    rating: parseRating(book.rating),
    publisher: book.publisher ?? null,
    // Source-populated signals captured for ranking. `quality` is z-lib's own
    // 0–5 quality score (often 0 in practice, but a strong signal when set).
    // `isbn` is useful for deduping editions and cross-referencing the shelf.
    isbn: book.isbn || null,
    quality: parseRating(book.quality),
    cover: book.cover || null,
  };
}

/**
 * Extract the path-segment id from a z-lib book URL. The binary's
 * `download <id>` command consumes this URL-segment id (e.g. "r9bkkbjyzB"),
 * NOT the numeric `Book.id` attribute (e.g. "19179031") — they're different,
 * and using the wrong one yields a 404 / empty download URL. Mirrors
 * heartleo's bookIDFromURL in internal/cli/search.go.
 */
export function bookIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/book\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** "1965" → 1965; "" / "0" / null → null */
export function parseYear(y) {
  if (y == null || y === '' || y === '0') return null;
  const n = Number(y);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse zlib's human-readable size string into bytes. Heartleo prints whatever
 * z-library returns — usually "1 MB", "850 KB", "1.5 MB", "12 mb". Best-effort:
 * unknown unit → null, unrecognized format → null.
 */
export function parseSize(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|b)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit];
  return Math.round(n * mult);
}

/** "5/5" → 5; "4.5/5" → 4.5; "" → null */
export function parseRating(r) {
  if (!r || typeof r !== 'string') return null;
  const m = r.match(/^(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 'zlib:abc123' → 'abc123'. Rejects anything that doesn't start with our prefix. */
export function parseSourceId(sourceId) {
  const prefix = `${SOURCE_NAME}:`;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(prefix)) {
    throw new SourceError('SOURCE_BIN_MISSING', `sourceId must start with "${prefix}", got "${sourceId}"`);
  }
  const id = sourceId.slice(prefix.length);
  if (!id) throw new SourceError('SOURCE_BIN_MISSING', `sourceId has empty id: "${sourceId}"`);
  return id;
}

/** '/some/dir/title.epub' → 'epub'; no extension → null */
export function extractFormat(path) {
  if (typeof path !== 'string') return null;
  const m = path.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : null;
}
