// `shelf retrieve --batch <file>` — run the single-book retrieve once per line.
//
// Each line runs as its own `shelf retrieve` child process, one after another
// (never in parallel, to stay polite to the source). The child process keeps
// the single-book command's contract intact: its stdout JSON is the result,
// its exit code is the outcome, and its stderr is forwarded as progress.
// One book failing never stops the rest.
//
// Batch file format: one book per line. Blank lines and lines starting with
// `#` are skipped. A line is either an ISBN (any text after it is a label and
// is ignored) or `Title | Author`.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../paths.mjs';
import { EXIT } from '../output.mjs';

const ISBN_RE = /^(?:\d{9}[\dX]|\d{13})$/i;

/**
 * Parse batch text into entries. Each entry is `{ input, isbn }`,
 * `{ input, title, author }`, or `{ input, error }` for a line that is
 * neither an ISBN nor `Title | Author`.
 *
 * @param {string} text
 */
export function parseBatch(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const input = raw.trim();
    if (!input || input.startsWith('#')) continue;
    if (input.includes('|')) {
      const [title, ...rest] = input.split('|');
      const author = rest.join('|').trim();
      if (title.trim() && author) {
        entries.push({ input, title: title.trim(), author });
        continue;
      }
    } else {
      const first = input.split(/\s+/)[0].replace(/-/g, '');
      if (ISBN_RE.test(first)) {
        entries.push({ input, isbn: first.toUpperCase() });
        continue;
      }
    }
    entries.push({ input, error: 'line is neither an ISBN nor "Title | Author"' });
  }
  return entries;
}

/**
 * Run each entry through `retrieveOne` sequentially and collect a batch
 * result. `retrieveOne(entry, opts)` resolves to
 * `{ exitCode, result, error }` — `result` is the single-book stdout JSON,
 * `error` the single-book structured error (`{ code, message, ... }`).
 *
 * Each result row is `{ input, status, picked, destination, reused,
 * convertedFrom, error }`, with null for whatever the single-book run did not
 * report.
 *
 * @returns {Promise<{ output: { results: any[], summary: { delivered: number, failed: number } }, exitCode: number }>}
 */
export async function runBatch(entries, opts, retrieveOne, log = () => {}) {
  const results = [];
  let succeeded = 0;
  let firstFailureCode = null;
  for (const [i, entry] of entries.entries()) {
    log(`batch: [${i + 1}/${entries.length}] ${entry.input}`);
    let outcome;
    if (entry.error) {
      outcome = { exitCode: EXIT.USAGE, result: null, error: { message: entry.error } };
    } else {
      try {
        outcome = await retrieveOne(entry, opts);
      } catch (err) {
        outcome = { exitCode: EXIT.NETWORK, result: null, error: { message: err?.message || String(err) } };
      }
    }
    const row = toResultRow(entry.input, outcome);
    if (row.status === 'delivered' || row.status === 'dry-run') {
      succeeded++;
    } else if (firstFailureCode == null) {
      firstFailureCode = outcome.exitCode || EXIT.NETWORK;
    }
    log(`batch: [${i + 1}/${entries.length}] ${row.status}${row.error ? ` — ${row.error}` : ''}`);
    results.push(row);
  }
  return {
    output: { results, summary: { delivered: succeeded, failed: results.length - succeeded } },
    exitCode: succeeded > 0 ? EXIT.OK : (firstFailureCode ?? EXIT.USAGE),
  };
}

function toResultRow(input, { exitCode, result, error }) {
  let status;
  if (exitCode === EXIT.OK) status = result?.dryRun ? 'dry-run' : 'delivered';
  else if (exitCode === EXIT.NO_DATA) status = 'no-match';
  else status = 'error';
  const p = result?.picked;
  return {
    input,
    status,
    picked: p
      ? {
          title: p.title ?? null,
          format: result.format ?? p.format ?? null,
          sizeBytes: result.sizeBytes ?? p.sizeBytes ?? null,
          sourceId: p.sourceId ?? null,
        }
      : null,
    destination: result?.destination ?? null,
    reused: result?.reused ?? null, // true when an identical file was already at the destination
    convertedFrom: result?.convertedFrom ?? null, // 'epub' | 'mobi' when the book was converted to AZW3
    error: exitCode === EXIT.OK ? null : error?.message || `retrieve exited ${exitCode}`,
  };
}

/** Read the batch file, or stdin when the path is `-`. */
export async function readBatchSource(path) {
  if (path === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(path, 'utf8');
}

/** Flags passed through from the batch invocation to each single-book run. */
export function singleBookArgs(entry, opts) {
  const args = ['--json', 'retrieve'];
  if (entry.isbn) args.push('--isbn', entry.isbn);
  else args.push('--title', entry.title, '--author', entry.author);
  if (opts.ext) args.push('--ext', String(opts.ext));
  if (opts.english) args.push('--english');
  if (opts.maxMb != null && opts.maxMb !== '') args.push('--max-mb', String(opts.maxMb));
  if (opts.dest) args.push('--dest', String(opts.dest));
  if (opts.dryRun) args.push('--dry-run');
  if (opts.source) args.push('--source', String(opts.source));
  return args;
}

/**
 * The real single-book runner: `node shelf.mjs retrieve ...` as a child
 * process. Child stderr is forwarded to ours as progress; its last JSON
 * line is read back as the structured error on failure.
 */
export function spawnRetrieveOne(entry, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'shelf.mjs'), ...singleBookArgs(entry, opts)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on('error', (err) => resolve({ exitCode: EXIT.NETWORK, result: null, error: { message: err.message } }));
    child.on('close', (code) => {
      const exitCode = code ?? EXIT.NETWORK;
      let result = null;
      if (exitCode === EXIT.OK) {
        try {
          result = JSON.parse(stdout);
        } catch {
          // A success with unreadable output still counts as delivered; the
          // row just carries no pick details.
        }
      }
      resolve({ exitCode, result, error: exitCode === EXIT.OK ? null : lastJsonError(stderr) });
    });
  });
}

function lastJsonError(stderr) {
  const lines = stderr.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.error) return parsed.error;
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}
