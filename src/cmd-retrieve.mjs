// `shelf retrieve` — source a book file and deliver it.
//
// This is the orchestrator. It owns the deterministic mechanics: build the
// query, apply hard filters, pick the best edition by format → size, download
// into a tmp dir, convert an EPUB or MOBI to AZW3 when a mounted Kindle has no
// AZW3 copy to receive, hand off to deliver(). Judgment about edition quality stays
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
import { deliver, decideDestination } from './retrieve/deliver.mjs';
import { lookupIsbn, lookupIsbnGoogle } from './sources.mjs';
import { convertFile, findConverter, CONVERTER_MISSING_MESSAGE } from './cmd-convert.mjs';

// Format preference order. AZW3 is Amazon's native format and renders
// reliably on every Kindle, so it leads. EPUB ranks next for non-Kindle
// destinations, and is the preferred format to convert to AZW3 for a mounted
// Kindle. MOBI is the legacy Amazon format. PDF is the fallback because reflow
// on a Kindle is poor. Any format not in this map gets pushed to the end.
const FORMAT_RANK = { azw3: 0, epub: 1, mobi: 2, pdf: 3 };
const formatRank = (f) => FORMAT_RANK[String(f || '').toLowerCase()] ?? 99;

// Below this size, the file is almost certainly a sample or excerpt, not the
// full book. Above the max, the file is likely a low-quality OCR scan or an
// audiobook ZIP. Both heuristics are conservative — overrideable via flags.
const MIN_BYTES = 50 * 1024; // 50 KB

const SOURCES = { zlib };

export async function run(opts /*, command */) {
  // ─── batch mode: one single-book retrieve per line ─────────────────────
  if (opts.batch != null) {
    await runBatchMode(opts);
    return;
  }

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

  const formats = resolveFormats({ ext: opts.ext, dest: opts.dest });
  if (formats.error) fail(EXIT.USAGE, formats.error);
  const extensions = formats.extensions;
  const maxBytes = parseMaxMb(opts.maxMb);

  // ─── 2–3. search + filter ───────────────────────────────────────────────
  const query = { isbn, title, author, maxBytes, english: !!opts.english };
  let found = await findCandidates(source, { ...query, extensions });
  // No AZW3 for a Kindle delivery: look for an EPUB or MOBI to convert.
  let convert = false;
  if (found.failure?.code === EXIT.NO_DATA && formats.convertFrom) {
    log(`source: no AZW3 copy found; looking for ${formats.convertFrom.join(' or ')} to convert`);
    const fallback = await findCandidates(source, { ...query, extensions: formats.convertFrom });
    if (fallback.failure) {
      fallback.failure.message = `no AZW3 copy, and no EPUB or MOBI to convert: ${fallback.failure.message}`;
    } else {
      convert = true;
    }
    found = fallback;
  }
  if (found.failure) fail(found.failure.code, found.failure.message, found.failure.extra);
  const { ranked, matchedBy, omitted } = found;

  // ─── 4. pick + dry-run early exit ───────────────────────────────────────
  const picked = ranked[0];
  const alternatives = ranked.slice(1);

  if (opts.dryRun) {
    log('dry run: not downloading');
    const willConvert = convert ? { convertTo: 'azw3' } : {};
    emit({ ...compactCandidates(ranked), matchedBy, omitted, ...willConvert, dryRun: true }, opts);
    return;
  }

  // Check for Calibre before downloading, so a missing converter costs no download.
  let converter;
  if (convert) {
    converter = await findConverter(opts.finder ?? {});
    if (!converter) {
      fail(
        EXIT.USAGE,
        `${CONVERTER_MISSING_MESSAGE} No AZW3 copy exists, so the ${picked.format || 'EPUB or MOBI'} copy must be ` +
          'converted; nothing was downloaded or delivered.',
      );
    }
  }

  // ─── 5. download ────────────────────────────────────────────────────────
  const stagingDir = await mkdtemp(join(tmpdir(), 'shelf-retrieve-'));
  let downloaded;
  try {
    log(`source: downloading ${picked.sourceId}`);
    downloaded = await withSourceRetry(() => source.download({ sourceId: picked.sourceId, destDir: stagingDir }));
    log(`source: downloaded via ${downloaded.transport}`);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    handleSourceError(err);
  }

  // ─── 6. convert (EPUB/MOBI bound for the Kindle) + deliver ──────────────
  let sourcePath = downloaded.path;
  let deliverFormat = picked.format || downloaded.format || 'epub';
  let convertedFrom;
  if (convert) {
    const fromFormat = String(downloaded.format || picked.format || 'file').toLowerCase();
    let conversion;
    try {
      log(`converting ${fromFormat} to azw3`);
      conversion = await convertFile({ input: downloaded.path, to: 'azw3', converter, runner: opts.runner });
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      fail(err.exitCode ?? EXIT.NETWORK, `${err.message}. The ${fromFormat} file was not delivered.`, {
        convertFrom: fromFormat,
      });
    }
    sourcePath = conversion.output;
    deliverFormat = 'azw3';
    if (conversion.converted) convertedFrom = fromFormat;
  }
  await refuseEpubOnKindle(deliverFormat, opts.dest, stagingDir);
  let delivered;
  try {
    delivered = await deliver({
      sourcePath,
      title: picked.title || title || isbn || 'book',
      format: deliverFormat,
      dest: opts.dest,
    });
  } finally {
    // Removes the downloaded file, including an EPUB or MOBI that was converted.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  // ─── 7. emit ────────────────────────────────────────────────────────────
  emit(
    {
      picked,
      matchedBy, // 'isbn' | 'title' — which search found the candidates
      destination: delivered.destination,
      mounted: delivered.mounted,
      kind: delivered.kind, // 'kindle' | 'downloads' | 'override'
      format: delivered.format,
      ...(convertedFrom ? { convertedFrom } : {}), // 'epub' | 'mobi' — the downloaded format, converted to AZW3
      sizeBytes: delivered.sizeBytes,
      reused: delivered.reused, // true when an identical file was already at the destination
      transport: downloaded.transport, // 'binary' | 'browser' — which path delivered
      alternatives,
      omitted,
    },
    opts,
  );
}

/**
 * Search the source and narrow the result to ranked candidates: the title
 * gate, then the hard filters (`rejectReason`), then `rankIndexedCandidates`.
 * Returns { ranked, matchedBy, omitted } with at least one ranked candidate,
 * or { failure: { code, message, extra } } describing why none survived.
 * A source that throws exits through `handleSourceError`.
 */
async function findCandidates(source, { isbn, title, author, extensions, maxBytes, english }) {
  const formatNote = extensions.length ? ` (${extensions.join(', ')})` : '';
  log(`source: searching${isbn ? ` by isbn ${isbn}` : ` for "${title}" by ${author}"`}${formatNote}`);
  let result;
  let matchedBy;
  // The book the title gate checks candidates against: the --title/--author
  // request, or the title and author an unmatched ISBN resolved to.
  let requested = title ? { title, author } : null;
  try {
    const found = await withSourceRetry(() =>
      searchWithIsbnFallback(source, {
        isbn,
        title,
        author,
        extensions: extensions.length ? extensions : undefined,
      }),
    );
    if (found.unresolved) {
      if (found.lookupUnreachable) {
        return {
          failure: {
            code: EXIT.NETWORK,
            message: `source has no copy with isbn ${isbn}, and ${found.unresolved}; retry later`,
            extra: { sourceCode: 'ISBN_LOOKUP_UNAVAILABLE' },
          },
        };
      }
      return { failure: { code: EXIT.NO_DATA, message: `source has no copy with isbn ${isbn}, and ${found.unresolved}` } };
    }
    ({ result, matchedBy } = found);
    if (found.requested) requested = found.requested;
  } catch (err) {
    handleSourceError(err);
  }

  if (!result.candidates.length) {
    return { failure: { code: EXIT.NO_DATA, message: 'source returned no candidates for that query' } };
  }

  // Title gate first: ranking never sees a different book by the same author.
  const filtered = [];
  const omitted = [];
  let matched = result.candidates;
  if (requested) {
    matched = [];
    for (const c of result.candidates) {
      const reason = mismatchReason(c, requested);
      if (reason) omitted.push({ candidate: c, reason });
      else matched.push(c);
    }
    if (!matched.length) {
      return {
        failure: {
          code: EXIT.NO_DATA,
          message: 'no candidate matches the requested title and author',
          extra: { matchCode: 'NO_MATCH', requested, omitted },
        },
      };
    }
  }
  for (const c of matched) {
    const reason = rejectReason(c, { extensions, maxBytes, english });
    if (reason) omitted.push({ candidate: c, reason });
    else filtered.push(c);
  }

  if (!filtered.length) {
    // Show the agent what got dropped so it can offer the user a way back.
    return {
      failure: {
        code: EXIT.NO_DATA,
        message: 'all candidates were filtered out — adjust --ext / --max-mb / --english',
        extra: { omitted },
      },
    };
  }

  // Preserve source order as the tiebreaker (z-lib's relevance ranking
  // already does most of the work; we want to override only on strong
  // signals like format and quality, not on size).
  const indexed = filtered.map((c, i) => ({ c, i }));
  indexed.sort(rankIndexedCandidates);
  return { ranked: indexed.map((x) => x.c), matchedBy, omitted };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function parseList(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// Kyle's Kindle displays only AZW3 files copied over USB; sideloaded EPUB and
// MOBI files do not appear. When no AZW3 exists, retrieve converts an EPUB or
// MOBI (EPUB preferred, by FORMAT_RANK) to AZW3 before delivery.
const KINDLE_DEFAULT_EXTENSIONS = ['azw3'];
const KINDLE_CONVERTIBLE_EXTENSIONS = ['epub', 'mobi'];
const KINDLE_UNREADABLE_FORMATS = new Set(['epub', 'mobi']);
const KINDLE_FORMAT_REFUSAL =
  'EPUB and MOBI files do not display on the Kindle; pass --dest <dir> to save the file, ' +
  'then run `shelf convert <file> --replace` to make an AZW3, or choose --ext azw3';

/**
 * Resolve the format filter for this run. When delivery is headed to a
 * mounted Kindle (same detection as deliver.mjs) and --ext is absent, the
 * filter defaults to azw3, and `convertFrom` names the formats to search for
 * and convert when no AZW3 copy exists. An explicit --ext that includes epub
 * or mobi is refused for Kindle delivery. With --dest set or no Kindle
 * mounted, --ext passes through unchanged (empty = every format).
 *
 * @param {{ ext?: string, dest?: string, env?: Record<string, string|undefined>, mountDefault?: string }} [opts]
 * @returns {{ extensions: string[], kindle: boolean, convertFrom?: string[], error?: string }}
 */
export function resolveFormats({ ext, dest, env, mountDefault } = {}) {
  const extensions = parseList(ext);
  const kindle = decideDestination({ destOverride: dest, env, mountDefault }).kind === 'kindle';
  if (!kindle) return { extensions, kindle };
  if (!extensions.length) {
    return { extensions: [...KINDLE_DEFAULT_EXTENSIONS], kindle, convertFrom: [...KINDLE_CONVERTIBLE_EXTENSIONS] };
  }
  if (extensions.some((e) => KINDLE_UNREADABLE_FORMATS.has(e))) return { extensions, kindle, error: KINDLE_FORMAT_REFUSAL };
  return { extensions, kindle };
}

/**
 * Error message when a file of `format` would land on the Kindle as an EPUB or MOBI,
 * else null. Covers paths where the format is only known after download
 * (--source-id, or a candidate whose format the search left blank).
 *
 * @param {{ format?: string, dest?: string, env?: Record<string, string|undefined>, mountDefault?: string }} opts
 * @returns {string|null}
 */
export function kindleFormatError({ format, dest, env, mountDefault } = {}) {
  if (!KINDLE_UNREADABLE_FORMATS.has(String(format || '').toLowerCase())) return null;
  const kindle = decideDestination({ destOverride: dest, env, mountDefault }).kind === 'kindle';
  return kindle ? KINDLE_FORMAT_REFUSAL : null;
}

async function refuseEpubOnKindle(format, dest, stagingDir) {
  const error = kindleFormatError({ format, dest });
  if (!error) return;
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  fail(EXIT.USAGE, error);
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
 * A numbered series prefix: a series name containing a letter, then a one- or
 * two-digit number set off by a space ("Slough House 4: ", "Slough House, Book
 * 4 - ", "Series #2: ") or a hyphen ("DCC-02. "), then ":", "." or a dash.
 * Titles that begin with or are a bare number ("2001: A Space Odyssey",
 * "1984: A Novel", "Fahrenheit 451: A Novel", "Catch-22: A Novel") do not
 * match, so their number stays part of the title.
 */
const SERIES_PREFIX_RE =
  /^[^:]{0,60}?[a-z][^:]*?(?:[\s,]+(?:book\s+|#)?\d{1,2}(?:\.\d+)?\s*(?:[:.]|\s[-–—])|-\d{1,2}\.)\s+/;

/** Lower case with diacritics removed. */
const foldCase = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** Words only: "&" spelled out, apostrophes dropped, other punctuation turned into spaces. */
const wordsOnly = (t) =>
  t
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Reduce a book title to its comparable core: lower case, diacritics and
 * punctuation removed, a leading article dropped, trailing parentheticals
 * ("London Rules (Slough House 5)"), a numbered series prefix
 * ("Slough House 4: Spook Street", "DCC-02. ...") and a subtitle after ":" or
 * " - " stripped.
 *
 * @param {string} s
 * @returns {string}
 */
export function normalizeTitle(s) {
  return titleCore(s, { stripSeries: true });
}

function titleCore(s, { stripSeries }) {
  let t = foldCase(s);
  let prev;
  do {
    prev = t;
    t = t.replace(/\s*[([][^()[\]]*[)\]]\s*$/, '').trim();
  } while (t !== prev);
  if (stripSeries) t = t.replace(SERIES_PREFIX_RE, '');
  t = t.split(/\s*:\s*|\s+[-–—]\s+/)[0];
  return wordsOnly(t).replace(/^(?:the|a|an)\s+/, '');
}

/**
 * The full title as words: lower case, diacritics and punctuation removed,
 * nothing else dropped. Two titles that agree here name the same book even
 * when `normalizeTitle` reduces them differently.
 *
 * @param {string} s
 * @returns {string}
 */
export function plainTitle(s) {
  return wordsOnly(foldCase(s));
}

/**
 * True when a candidate title names the requested title. Both sides go
 * through the same reductions, and the titles match when any one agrees:
 * the `normalizeTitle` core, the same core with any series prefix kept (so
 * "Agent 6: A Novel" matches "Agent 6"), or the full `plainTitle`.
 *
 * @param {string} candidateTitle
 * @param {string} requestedTitle
 * @returns {boolean}
 */
export function titlesMatch(candidateTitle, requestedTitle) {
  return (
    normalizeTitle(candidateTitle) === normalizeTitle(requestedTitle) ||
    titleCore(candidateTitle, { stripSeries: false }) === titleCore(requestedTitle, { stripSeries: false }) ||
    plainTitle(candidateTitle) === plainTitle(requestedTitle)
  );
}

/** Lower-case word tokens of a person's name, diacritics removed. */
function nameTokens(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Why a candidate is not the requested book, or null when it is. The title
 * must pass `titlesMatch`. When an author is given and the
 * candidate lists authors, the requested surname (last name token) must
 * appear in one of them; a candidate with no author data passes on title.
 *
 * @param {{ title?: string, authors?: string[] }} c
 * @param {{ title: string, author?: string }} req
 * @returns {string|null}
 */
export function mismatchReason(c, { title, author } = {}) {
  if (!titlesMatch(c.title, title)) {
    return `title "${c.title}" does not match "${title}"`;
  }
  const surname = nameTokens(author).at(-1);
  const authors = Array.isArray(c.authors) ? c.authors : [];
  if (surname && authors.length && !authors.some((a) => nameTokens(a).includes(surname))) {
    return `author ${authors.join(', ')} does not match "${author}"`;
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

// Backoff before each extra attempt when the source reports a transient
// outage. Two retries cover the observed case: a first call that fails with
// SOURCE_UNAVAILABLE and an identical call seconds later that succeeds.
const SOURCE_RETRY_DELAYS_MS = [2000, 5000];
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a source call, retrying only when it throws a SourceError with code
 * SOURCE_UNAVAILABLE. Auth, not-found, and missing-binary errors are not
 * transient and propagate on the first throw. After the last retry the final
 * error propagates unchanged.
 */
export async function withSourceRetry(call, { delaysMs = SOURCE_RETRY_DELAYS_MS, sleep = realSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const transient = err && err.name === 'SourceError' && err.code === 'SOURCE_UNAVAILABLE';
      if (!transient || attempt >= delaysMs.length) throw err;
      const wait = delaysMs[attempt];
      log(`source: unavailable — retrying in ${wait}ms (try ${attempt + 1}/${delaysMs.length})`);
      await sleep(wait);
    }
  }
}


// Default number of alternatives shown in --dry-run output.
const DRY_RUN_ALTERNATIVES = 8;

/**
 * Normalised title for edition grouping: lowercase, bracketed asides
 * ("(Slough House #1)") dropped, a leading numbered series prefix
 * ("Slough House 1 - ", "Series #2: ") dropped, punctuation stripped.
 */
export function editionTitleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/^\p{L}[^:]*?\s#?\d+(?:\.\d+)?\s*[:\-–—.]\s+/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Words that do not distinguish one publisher family from another.
const PUBLISHER_NOISE = new Set(['the', 'a', 'an', 'and', 'publishing', 'publishers', 'publisher', 'books', 'press', 'inc', 'ltd', 'llc', 'co', 'group', 'house', 'uk', 'us', 'usa']);

/**
 * Publisher family: the first distinguishing word of the publisher name, so
 * "Hachette UK" and "Hachette Book Group" share the family "hachette".
 * Telegram handles ("@x") and missing publishers map to ''.
 */
export function publisherFamily(publisher) {
  const p = String(publisher || '').trim();
  if (!p || p.startsWith('@')) return '';
  const words = p.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !PUBLISHER_NOISE.has(w));
  return words[0] || '';
}

/**
 * Compact a ranked candidate list for --dry-run output. Candidates that are
 * the same edition (same normalised title, publisher family, year and format)
 * collapse into one entry: the best-ranked copy keeps its fields and gains
 * `copies` and `otherSourceIds` (the remaining copies in rank order).
 * The first entry is `picked`; at most `limit` further entries are
 * `alternatives`, and `omittedCount` reports how many were cut (present only
 * when some were).
 *
 * @param {any[]} ranked candidates, best first
 * @param {{ limit?: number }} [opts]
 * @returns {{ picked: any, alternatives: any[], omittedCount?: number }}
 */
export function compactCandidates(ranked, { limit = DRY_RUN_ALTERNATIVES } = {}) {
  const groups = new Map();
  for (const c of ranked) {
    const key = [editionTitleKey(c.title), publisherFamily(c.publisher), c.year ?? '', String(c.format || '').toLowerCase()].join('|');
    const group = groups.get(key);
    if (group) group.otherSourceIds.push(c.sourceId);
    else groups.set(key, { ...c, copies: 1, otherSourceIds: [] });
  }
  const entries = [...groups.values()].map((e) => ({ ...e, copies: 1 + e.otherSourceIds.length }));
  const [picked, ...rest] = entries;
  const result = { picked, alternatives: rest.slice(0, limit) };
  if (rest.length > limit) result.omittedCount = rest.length - limit;
  return result;
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

// ─── isbn → title fallback ────────────────────────────────────────────────

/** ISBN digits only (plus a trailing X check digit), uppercased. */
const normalizeIsbn = (s) => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();

/**
 * True when a candidate's isbn field names the requested ISBN. The field can
 * carry several ISBNs separated by commas or spaces, so each is compared.
 */
export function candidateHasIsbn(c, isbn) {
  const want = normalizeIsbn(isbn);
  if (!want || !c?.isbn) return false;
  return String(c.isbn)
    .split(/[\s,;]+/)
    .some((x) => normalizeIsbn(x) === want);
}

/**
 * The services that resolve an ISBN to a title and author, asked in order
 * until one has a record. Both are keyless.
 */
export const ISBN_LOOKUPS = [
  { name: 'Open Library', lookup: lookupIsbn },
  { name: 'Google Books', lookup: lookupIsbnGoogle },
];

/**
 * Resolve an ISBN to { title, author } by asking each lookup service in turn.
 * Returns { resolved } from the first service with a record. Otherwise returns
 * { unresolved: reason, lookupUnreachable }: `lookupUnreachable` is true when
 * any service threw (network failure, server errors after retries), because
 * an unanswered lookup cannot show that the book has no record; it is false
 * only when every service answered with no record.
 *
 * @param {string} isbn
 * @param {{ name: string, lookup: (isbn: string) => Promise<{ title: string, author: string } | null> }[]} lookups
 */
export async function resolveIsbn(isbn, lookups = ISBN_LOOKUPS) {
  const noRecord = [];
  const failed = [];
  for (const { name, lookup } of lookups) {
    try {
      const resolved = await lookup(isbn);
      if (resolved) return { resolved };
      noRecord.push(name);
      log(`source: ${name} has no title and author for isbn ${isbn}`);
    } catch (err) {
      failed.push(`${name}: ${err.message}`);
      log(`source: ${name} lookup for isbn ${isbn} failed (${err.message})`);
    }
  }
  if (failed.length) {
    const also = noRecord.length ? `; ${noRecord.join(' and ')} had no record` : '';
    return {
      unresolved: `the ISBN lookup service could not be reached (${failed.join('; ')})${also}`,
      lookupUnreachable: true,
    };
  }
  return { unresolved: `${noRecord.join(' and ')} have no title and author for it`, lookupUnreachable: false };
}

/**
 * Search the source, falling back from ISBN to title + author. A print ISBN
 * often finds nothing at a source that stocks only the ebook editions, which
 * carry different ISBNs. When the ISBN search returns no candidate carrying
 * the requested ISBN, the ISBN is resolved to a title and author (the
 * caller's --title/--author when both are given, otherwise `resolveIsbn`) and
 * the source is searched again by those.
 *
 * Returns { result, matchedBy: 'isbn' | 'title', requested? }. `requested` is the
 * title and author the fallback searched for. Returns
 * { unresolved: reason, lookupUnreachable } when the fallback could not find a
 * title and author for the ISBN (see `resolveIsbn`).
 *
 * @param {{ search: Function }} source
 * @param {{ isbn?: string, title?: string, author?: string, extensions?: string[] }} query
 * @param {{ lookups?: typeof ISBN_LOOKUPS }} [deps]
 */
export async function searchWithIsbnFallback(source, { isbn, title, author, extensions }, { lookups = ISBN_LOOKUPS } = {}) {
  if (!isbn) {
    return { result: await source.search({ title, author, extensions }), matchedBy: 'title' };
  }
  const byIsbn = await source.search({ isbn, extensions });
  if (byIsbn.candidates.some((c) => candidateHasIsbn(c, isbn))) {
    return { result: byIsbn, matchedBy: 'isbn' };
  }

  let resolved = title && author ? { title, author } : null;
  if (!resolved) {
    log(`source: no candidate carries isbn ${isbn}; resolving it to a title and author`);
    const lookedUp = await resolveIsbn(isbn, lookups);
    if (!lookedUp.resolved) return lookedUp;
    resolved = lookedUp.resolved;
  }
  log(`source: searching for "${resolved.title}" by ${resolved.author}`);
  const byTitle = await source.search({ title: resolved.title, author: resolved.author, extensions });
  return { result: byTitle, matchedBy: 'title', requested: resolved };
}

// ─── batch mode ───────────────────────────────────────────────────────────

/**
 * The flags that name a single book. `--batch` names many, so it cannot be
 * combined with any of them. Returns the conflicting flag names.
 */
export function batchConflicts(opts) {
  const named = { isbn: '--isbn', title: '--title', sourceId: '--source-id' };
  return Object.keys(named)
    .filter((k) => opts[k] != null && opts[k] !== '')
    .map((k) => named[k]);
}

async function runBatchMode(opts) {
  const conflicts = batchConflicts(opts);
  if (conflicts.length) {
    fail(EXIT.USAGE, `--batch cannot be combined with ${conflicts.join(', ')}`);
  }
  const { parseBatch, runBatch, readBatchSource, spawnRetrieveOne } = await import('./retrieve/batch.mjs');
  let text;
  try {
    text = await readBatchSource(opts.batch);
  } catch (err) {
    fail(EXIT.USAGE, `cannot read --batch ${opts.batch}: ${err.message}`);
  }
  const entries = parseBatch(text);
  if (!entries.length) fail(EXIT.USAGE, '--batch input has no book lines');
  const { output, exitCode } = await runBatch(entries, opts, spawnRetrieveOne, log);
  emit(output, opts);
  process.exitCode = exitCode;
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
    downloaded = await withSourceRetry(() => source.download({ sourceId: opts.sourceId, destDir: stagingDir }));
    log(`source: downloaded via ${downloaded.transport}`);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    handleSourceError(err);
  }
  await refuseEpubOnKindle(downloaded.format || 'epub', opts.dest, stagingDir);
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
      reused: delivered.reused, // true when an identical file was already at the destination
      transport: downloaded.transport, // 'binary' | 'browser' — which path delivered
      bypassed: true,
    },
    opts,
  );
}
