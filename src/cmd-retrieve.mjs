// `shelf retrieve` — source a book file and deliver it.
//
// This is the orchestrator. It owns the deterministic mechanics: build the
// query, apply hard filters, pick the best edition by format → size, download
// into a tmp dir, hand off to deliver(). Judgment about edition quality stays
// in the calling agent's prompt; the CLI gives it a sensible default pick
// plus the full candidate list so the agent can override with --source-id
// later if it wants to.
//
// Output contract — same as the rest of shelf:
//   stdout: one JSON object (the result) on success, nothing on failure
//   stderr: log lines + structured error JSON on failure
//   exit:   0 ok · 2 usage · 3 no-data · 5 source/network failure
//
// This file is the only place that picks a source backend. Today the only
// backend is `./retrieve/sources/zlib.mjs`; a second one would be added
// alongside and selected by --source (currently a no-op flag, here for
// forward-compat without leaking source identity through the interface).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, emit, fail, EXIT } from './output.mjs';
import * as zlib from './retrieve/sources/zlib.mjs';
import { deliver } from './retrieve/deliver.mjs';

// Format preference order. AZW3 is Amazon's native format and renders
// reliably on every Kindle, so it leads; modern Kindles read EPUB natively
// too. MOBI is the legacy Amazon format. PDF is the fallback because reflow
// on a Kindle is poor. Any format not in this map gets pushed to the end.
const FORMAT_RANK = { azw3: 0, epub: 1, mobi: 2, pdf: 3 };
const formatRank = (f) => FORMAT_RANK[String(f || '').toLowerCase()] ?? 99;

// Below this size, the file is almost certainly a sample or excerpt, not the
// full book. Above the max, the file is likely a low-quality OCR scan or an
// audiobook ZIP. Both heuristics are conservative — overrideable via flags.
const MIN_BYTES = 50 * 1024; // 50 KB

const SOURCES = { zlib };

export async function run(opts /*, command */) {
  // ─── 1. validate input ──────────────────────────────────────────────────
  const sourceName = (opts.source || 'zlib').toLowerCase();
  const source = SOURCES[sourceName];
  if (!source) {
    fail(EXIT.USAGE, `unknown --source "${sourceName}" (valid: ${Object.keys(SOURCES).join(', ')})`);
  }

  // ─── source-id bypass: skip search + rank entirely ─────────────────────
  // The skill (or a careful human) uses --source-id when the heuristic
  // picker is wrong for a particular case. Runs BEFORE isbn/title validation
  // because the source-id supplies its own identity; we don't need a query.
  if (opts.sourceId) {
    await runSourceIdBypass(source, opts);
    return;
  }

  const isbn = opts.isbn?.trim();
  const title = opts.title?.trim();
  const author = opts.author?.trim();
  if (!isbn && !(title && author)) {
    fail(EXIT.USAGE, 'retrieve requires either --isbn or both --title and --author (or --source-id for a direct fetch)');
  }

  const extensions = parseList(opts.ext);
  const maxBytes = parseMaxMb(opts.maxMb);

  // ─── 2. search ──────────────────────────────────────────────────────────
  log(`source: searching${isbn ? ` by isbn ${isbn}` : ` for "${title}" by ${author}"`}`);
  let result;
  try {
    result = await source.search({
      isbn,
      title,
      author,
      extensions: extensions.length ? extensions : undefined,
    });
  } catch (err) {
    handleSourceError(err);
  }

  if (!result.candidates.length) {
    fail(EXIT.NO_DATA, 'source returned no candidates for that query');
  }

  // ─── 3. filter ──────────────────────────────────────────────────────────
  const filtered = [];
  const omitted = [];
  for (const c of result.candidates) {
    const reason = rejectReason(c, { extensions, maxBytes, english: !!opts.english });
    if (reason) omitted.push({ candidate: c, reason });
    else filtered.push(c);
  }

  if (!filtered.length) {
    // Show the agent what got dropped so it can offer the user a way back.
    fail(EXIT.NO_DATA, 'all candidates were filtered out — adjust --ext / --max-mb / --english', { omitted });
  }

  // ─── 4. pick + dry-run early exit ───────────────────────────────────────
  // Preserve source order as the tiebreaker (z-lib's relevance ranking
  // already does most of the work; we want to override only on strong
  // signals like format and quality, not on size).
  const indexed = filtered.map((c, i) => ({ c, i }));
  indexed.sort(rankIndexedCandidates);
  const ranked = indexed.map((x) => x.c);
  const picked = ranked[0];
  const alternatives = ranked.slice(1);

  if (opts.dryRun) {
    log('dry run: not downloading');
    emit({ picked, alternatives, omitted, dryRun: true }, opts);
    return;
  }

  // ─── 5. download ────────────────────────────────────────────────────────
  const stagingDir = await mkdtemp(join(tmpdir(), 'shelf-retrieve-'));
  let downloaded;
  try {
    log(`source: downloading ${picked.sourceId}`);
    downloaded = await source.download({ sourceId: picked.sourceId, destDir: stagingDir });
    log(`source: downloaded via ${downloaded.transport}`);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    handleSourceError(err);
  }

  // ─── 6. deliver ─────────────────────────────────────────────────────────
  let delivered;
  try {
    delivered = await deliver({
      sourcePath: downloaded.path,
      title: picked.title || title || isbn || 'book',
      format: picked.format || downloaded.format || 'epub',
      dest: opts.dest,
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  // ─── 7. emit ────────────────────────────────────────────────────────────
  emit(
    {
      picked,
      destination: delivered.destination,
      mounted: delivered.mounted,
      kind: delivered.kind, // 'kindle' | 'downloads' | 'override'
      format: delivered.format,
      sizeBytes: delivered.sizeBytes,
      transport: downloaded.transport, // 'binary' | 'browser' — which path delivered
      alternatives,
      omitted,
    },
    opts,
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────

function parseList(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function parseMaxMb(s) {
  if (s == null || s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1024 * 1024);
}

/**
 * Reasons a candidate fails a hard filter. Returns a human-legible string
 * (consumed by the agent to explain "I dropped X because Y") or null if the
 * candidate passes. Order matches user mental model: extension > language >
 * size > sample-likely.
 *
 * @param {any} c
 * @param {{ extensions?: string[], maxBytes?: number|null, english?: boolean }} [opts]
 * @returns {string|null}
 */
export function rejectReason(c, { extensions = [], maxBytes = null, english = false } = {}) {
  if (extensions.length && c.format && !extensions.includes(c.format)) {
    return `format ${c.format} not in --ext ${extensions.join(',')}`;
  }
  if (english && c.language && !/english/i.test(c.language)) {
    return `language ${c.language} (not English)`;
  }
  if (maxBytes != null && c.sizeBytes != null && c.sizeBytes > maxBytes) {
    return `size ${(c.sizeBytes / 1024 / 1024).toFixed(1)} MB exceeds --max-mb`;
  }
  if (c.sizeBytes != null && c.sizeBytes < MIN_BYTES) {
    return `size ${c.sizeBytes} bytes — likely a sample, not a full book`;
  }
  return null;
}

/**
 * Composite quality signal extracted from search-result metadata. Scaled
 * roughly 0–10. Designed to override z-lib's source order only when we have
 * STRONG evidence (real rating, real publisher); source order is the tiebreaker
 * so weakly-signaled candidates keep z-lib's own relevance ranking, which
 * empirically picks the right edition for well-indexed titles.
 *
 * Signal weights:
 *   rating (×1.5)         user signal, 0–7.5 — the strongest available
 *   z-lib quality (×0.5) z-lib's own 0–5 score, often 0 but real when set
 *   real publisher       +1 if non-null and not a Telegram-handle ("@x")
 *   plausible year       +0.5 if 1900…now+2 (filters out year:101, year:1800)
 */
export function qualityScore(c) {
  let s = 0;
  if (typeof c.rating === 'number' && c.rating > 0) s += c.rating * 1.5;
  if (typeof c.quality === 'number' && c.quality > 0) s += c.quality * 0.5;
  if (c.publisher && !/^@/.test(String(c.publisher))) s += 1;
  const thisYear = new Date().getFullYear();
  if (typeof c.year === 'number' && c.year >= 1900 && c.year <= thisYear + 2) s += 0.5;
  return s;
}

/**
 * Indexed-pair ranker. Takes `{c, i}` where `i` is the candidate's position
 * in the source's original result list, so we can fall back to source order
 * as the final tiebreaker. Ordering: format-rank asc → quality-score desc →
 * source-index asc.
 */
export function rankIndexedCandidates(a, b) {
  const fa = formatRank(a.c.format);
  const fb = formatRank(b.c.format);
  if (fa !== fb) return fa - fb;
  const qa = qualityScore(a.c);
  const qb = qualityScore(b.c);
  if (qa !== qb) return qb - qa;
  return a.i - b.i;
}

/**
 * Convert a SourceError into one of our documented exit codes. Identity of
 * the source backend never leaks into the user-facing error message — only
 * the generic code does, plus whatever the source put in the message.
 */
function handleSourceError(err) {
  if (err && err.name === 'SourceError') {
    const map = {
      SOURCE_AUTH_REQUIRED: [EXIT.NETWORK, 'source requires authentication; run the backend login flow first'],
      SOURCE_NOT_FOUND: [EXIT.NO_DATA, 'source could not find a matching copy'],
      SOURCE_UNAVAILABLE: [EXIT.NETWORK, 'source temporarily unavailable; retry later'],
      SOURCE_BIN_MISSING: [EXIT.USAGE, err.message],
    };
    const [code, message] = map[err.code] || [EXIT.NETWORK, err.message];
    // Preserve the source-specific message as `sourceMessage`. The mapped
    // `message` is the generic agent-facing rephrasing ("source could not
    // find a matching copy"); the original carries the precise reason (e.g.
    // the DMCA takedown text) the agent needs to give the user a useful next
    // step. Only emit it when it adds information beyond the generic.
    const extra = { sourceCode: err.code };
    if (err.message && err.message !== message) {
      extra.sourceMessage = err.message;
    }
    fail(code, message, extra);
  }
  throw err;
}

// ─── source-id bypass ─────────────────────────────────────────────────────

/**
 * Skip search + rank entirely; go directly to download with an explicit
 * sourceId. The skill (or a human who just inspected --dry-run output)
 * uses this when the heuristic picker is wrong for a particular case.
 * The delivery title falls back to whatever the source returned (the
 * binary's Book.name) or --title if the caller supplied one; failing both,
 * the sourceId itself slug-renames the file.
 */
async function runSourceIdBypass(source, opts) {
  const stagingDir = await mkdtemp(join(tmpdir(), 'shelf-retrieve-'));
  let downloaded;
  try {
    log(`source: downloading explicit ${opts.sourceId}`);
    downloaded = await source.download({ sourceId: opts.sourceId, destDir: stagingDir });
    log(`source: downloaded via ${downloaded.transport}`);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    handleSourceError(err);
  }
  let delivered;
  try {
    delivered = await deliver({
      sourcePath: downloaded.path,
      title: opts.title || downloaded.name || opts.sourceId,
      format: downloaded.format || 'epub',
      dest: opts.dest,
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  emit(
    {
      picked: {
        sourceId: opts.sourceId,
        title: downloaded.name || opts.title || null,
        format: downloaded.format,
        sizeBytes: downloaded.sizeBytes,
      },
      destination: delivered.destination,
      mounted: delivered.mounted,
      kind: delivered.kind,
      format: delivered.format,
      sizeBytes: delivered.sizeBytes,
      transport: downloaded.transport, // 'binary' | 'browser' — which path delivered
      bypassed: true,
    },
    opts,
  );
}
