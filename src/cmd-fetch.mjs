// `shelf fetch` — assemble a pool of UNREAD candidate books from the reader's
// own taste signals: more by authors they read (familiar) + top-rated books in
// the sub-genres they gravitate to (discovery). Open Library is primary; Google
// Books is best-effort. Deduped against the read shelf and against itself.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BOOKS_JSON, CACHE, CANDIDATES_JSON } from './paths.mjs';
import { log, emit, fail, EXIT, color } from './output.mjs';
import { byAuthor, bySubject, googleBySubject } from './sources.mjs';
import { dedupKey, slugify, asciiRatio, isJuvenile, hasForeignSubjectTag } from './util.mjs';

// English-edition guard. Open Library's `language=eng` param does not reliably
// exclude foreign-titled works, so we filter here: drop a candidate whose
// edition languages are known and lack English, whose subjects class it in a
// non-English literature ("Polish Fantasy fiction" — catches Latin-script
// translations like "Krew elfów" that the ASCII test waves through), or whose
// title is mostly non-Latin script (Japanese manga, Cyrillic/Greek editions).
const isEnglish = (c) => {
  if (Array.isArray(c.languages) && c.languages.length && !c.languages.includes('eng')) return false;
  if (hasForeignSubjectTag(c.subjects)) return false;
  return asciiRatio(c.t) >= 0.7;
};

// Children's/juvenile guard. The title embedding can't tell a kids' "Far West"
// adventure from a literary western, so filter on the catalog's own juvenile
// tags — but ONLY for authors the reader doesn't already read, so a read
// author's YA/middle-grade (Maas, Sanderson, Paulsen) is never collateral
// damage. Books kept this way are still tagged `audience` at build time so the
// agent knows they're YA.
const isAgeAppropriate = (c, readAuthors) => {
  if (!isJuvenile(c.subjects)) return true;
  return readAuthors.has(c.a.toLowerCase());
};

export async function run(opts) {
  const limit = Number(opts.limit) || 400;
  const sources = String(opts.source).split(',').map((s) => s.trim());
  const useGoogle = sources.includes('googlebooks');
  const useOL = sources.includes('openlibrary');

  const books = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));

  // What the reader has already read — exclude these from candidates.
  const readKeys = new Set(books.map((b) => dedupKey(b.t, b.a)));
  const readIsbns = new Set(books.map((b) => b.isbn).filter(Boolean));

  // Taste signals, most-read first so the strongest signals query first.
  const authors = [...new Set(books.map((b) => b.a))];
  const readAuthors = new Set(books.map((b) => b.a.toLowerCase()));
  const subjCount = new Map();
  for (const b of books) for (const s of b.s || []) subjCount.set(s, (subjCount.get(s) || 0) + 1);
  const subjects = [...subjCount.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);

  log(color.bold(`shelf fetch`) + ` — ${authors.length} authors, ${subjects.length} sub-genres`);
  if (opts.dryRun) log(color.dim('  (dry run — nothing will be written)'));

  // One bucket per query, so round-robin selection preserves breadth instead of
  // letting one prolific author or huge subject dominate the pool.
  const buckets = [];
  if (useOL) {
    log('  ↳ Open Library: by author…');
    for (const a of authors) buckets.push(await byAuthor(a, 6));
    log('  ↳ Open Library: by sub-genre…');
    for (const s of subjects) buckets.push(await bySubject(s, 10));
  }
  if (useGoogle) {
    log('  ↳ Google Books: by sub-genre (best-effort)…');
    for (const s of subjects.slice(0, 12)) buckets.push(await googleBySubject(s, 10));
  }

  // Round-robin flatten + dedupe. First occurrence of a dedupKey wins; later
  // hits just append their source label so provenance isn't lost.
  const chosen = new Map(); // dedupKey -> candidate
  let added = true;
  for (let i = 0; added && chosen.size < limit; i++) {
    added = false;
    for (const bucket of buckets) {
      if (chosen.size >= limit) break;
      const cand = bucket[i];
      if (!cand) continue;
      added = true;
      if (!isEnglish(cand)) continue; // drop foreign-language / non-Latin editions
      if (!isAgeAppropriate(cand, readAuthors)) continue; // drop kids' books from unread authors
      const key = dedupKey(cand.t, cand.a);
      if (readKeys.has(key)) continue; // already read
      if (cand.isbn && readIsbns.has(cand.isbn)) continue;
      const existing = chosen.get(key);
      if (existing) {
        if (!existing.sources.includes(cand.source)) existing.sources.push(cand.source);
        continue;
      }
      chosen.set(key, {
        t: cand.t,
        a: cand.a,
        year: cand.year,
        isbn: cand.isbn,
        pages: cand.pages,
        subjects: cand.subjects,
        firstSentence: cand.firstSentence,
        sources: [cand.source],
      });
    }
  }

  // Stable slug ids (suffix on collision), then sort by id for a deterministic file.
  const usedIds = new Set();
  const candidates = [...chosen.values()]
    .map((c) => {
      let id = slugify(`${c.t}-${c.a.split(/\s+/).pop()}`);
      let n = 2;
      const base = id;
      while (usedIds.has(id)) id = `${base}-${n++}`;
      usedIds.add(id);
      return { id, ...c };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const summary = {
    candidates: candidates.length,
    authorsQueried: useOL ? authors.length : 0,
    subjectsQueried: useOL ? subjects.length : 0,
    googleUsed: useGoogle,
    withIsbn: candidates.filter((c) => c.isbn).length,
    withPages: candidates.filter((c) => c.pages).length,
  };

  if (candidates.length === 0) fail(EXIT.NO_DATA, 'no candidates found — all queries returned read or duplicate books');

  if (!opts.dryRun) {
    await mkdir(CACHE, { recursive: true });
    await writeFile(CANDIDATES_JSON, JSON.stringify(candidates, null, 2) + '\n');
    log(color.accent(`  ✓ wrote ${candidates.length} candidates → .cache/candidates.json`));
  } else {
    log(color.dim(`  would write ${candidates.length} candidates`));
  }

  emit(summary, opts, (s, plain) =>
    plain
      ? `${s.candidates} candidates ${s.withIsbn} isbn ${s.withPages} pages`
      : `candidates: ${s.candidates}  (isbn ${s.withIsbn}, pages ${s.withPages})  google=${s.googleUsed}`,
  );
}
