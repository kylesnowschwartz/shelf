// `shelf fetch` — assemble a pool of UNREAD candidate books from the reader's
// own taste signals: more by authors they read (familiar) + top-rated books in
// the sub-genres they gravitate to (discovery). Deduped against the read shelf
// and against itself.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BOOKS_JSON, CACHE, CANDIDATES_JSON } from './paths.mjs';
import { log, emit, fail, EXIT, color } from './output.mjs';
import { byAuthor, bySubject, googleBySubject } from './sources.mjs';
import { mapWithConcurrency } from './concurrency.mjs';
import { cleanTitle, dedupKey, slugify, asciiRatio, isJuvenile, hasForeignSubjectTag } from './util.mjs';

// Searches overlap because each one spends its time waiting on a remote index,
// not on local work. The per-host pacing in http.mjs sets the request RATE;
// this bounds how many sit open at once, which matters because Open Library
// answers a sorted search in seconds, not milliseconds, and sheds load with a
// 503 when too many are in flight at once.
const QUERY_CONCURRENCY = 4;

// The reader's own sub-genre tags (`data/books.json`'s `s` array) are personal
// vocabulary coined for the read shelf, not Open Library's subject taxonomy —
// `subject:"Nordic Noir"` matches only a handful of works, so `sort=rating`
// has almost nothing to rank and surfaces obscure, low-quality editions ahead
// of anything good. Mapping a narrow tag to the broad OL subject it is really
// a flavor of gives `sort=rating` a large enough pool to be worth sorting.
// A tag absent from this map queries Open Library under its own name.
const SUBJECT_MAP = {
  'nordic noir': ['thriller', 'crime'],
  'serial-killer thriller': ['thriller', 'crime'],
  'action thriller': ['thriller'],
  'psychological thriller': ['thriller'],
  'sci-fi thriller': ['thriller', 'science fiction'],
  'spy thriller': ['thriller'],
  'techno-thriller': ['thriller'],
  romantasy: ['fantasy'],
  'portal fantasy': ['fantasy'],
  grimdark: ['fantasy'],
  'dark fantasy': ['fantasy'],
  'epic fantasy': ['fantasy'],
  'classic fantasy': ['fantasy'],
  'literary fantasy': ['fantasy'],
  'hard magic': ['fantasy'],
  'sword & sorcery': ['fantasy'],
  'heist fantasy': ['fantasy'],
  'space opera': ['science fiction'],
  'hard sf': ['science fiction'],
  'philosophical sf': ['science fiction'],
  cyberpunk: ['science fiction'],
  'post-apocalyptic': ['science fiction'],
  'supernatural horror': ['horror'],
  'vampire horror': ['horror'],
  'classic mystery': ['mystery'],
  detective: ['mystery'],
};

/** Broadens narrow reader tags to Open Library subjects, deduplicated so two tags mapping to the same subject cost one query. */
export const broadenSubjects = (tags) => {
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    for (const subject of SUBJECT_MAP[tag.toLowerCase()] || [tag]) {
      const key = subject.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(subject);
    }
  }
  return out;
};

// Quality floors, checked as an OR: a candidate clears the gate if ANY signal
// meets its floor. An AND would delete legitimate recent releases (too new for
// many editions or ratings yet) or niche-but-good books (few want-to-reads).
// Open Library's search index doesn't carry these fields for every work — a
// candidate with no signal present at all is unproven, not low-quality, so it
// is kept; the gate only drops a candidate whose present signals are all
// below their floor.
const QUALITY_FLOORS = { editionCount: 3, ratingsCount: 5, wantToReadCount: 25 };

const hasQualitySignal = (c) =>
  (c.editionCount !== undefined && c.editionCount >= QUALITY_FLOORS.editionCount) ||
  (c.ratingsCount !== undefined && c.ratingsCount >= QUALITY_FLOORS.ratingsCount) ||
  (c.wantToReadCount !== undefined && c.wantToReadCount >= QUALITY_FLOORS.wantToReadCount);

const allSignalsAbsent = (c) =>
  c.editionCount === undefined && c.ratingsCount === undefined && c.wantToReadCount === undefined;

/** Passes with no quality data at all (unproven, not disqualified), any signal at or above its floor, or an author already on the read shelf. */
export const passesQualityGate = (c, readAuthors) =>
  allSignalsAbsent(c) || hasQualitySignal(c) || readAuthors.has(c.a.toLowerCase());

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

// Self-publishing imprint screen. Google Books is the only source that
// supplies `publisher`, and its relevance ordering surfaces a fair amount of
// self-published filler alongside traditionally published work — these
// imprint names are the self-publishing platform itself, not evidence about
// any one book, so the screen only fires on an exact-ish name match. Most
// volumes omit `publisher` entirely, and its absence is not evidence of
// self-publishing, so a missing field passes through unscreened.
const SELF_PUBLISHING_IMPRINTS = [
  'independently published',
  'createspace',
  'lulu',
  'draft2digital',
  'smashwords',
  'blurb',
  'xlibris',
  'authorhouse',
  'iuniverse',
];

export const isSelfPublished = (c) => Boolean(c.publisher) && SELF_PUBLISHING_IMPRINTS.includes(c.publisher.toLowerCase());

// Collected-edition screen. A catalog carries records that stand for a bundle
// rather than a book — "Works (Carrie / Night Shift / 'Salem's Lot)" — and
// they rank well because every title inside them contributes signal. There is
// nothing to recommend: the reader cannot be pointed at "Works", and the
// individual novels are already candidates in their own right. The label is
// what identifies them, so the test is on the title with any parenthetical
// contents removed.
const COLLECTED_EDITION_TITLES = new Set([
  'works',
  'novels',
  'omnibus',
  'collected works',
  'complete works',
  'the complete novels',
  'collected novels',
  'selected works',
]);

export const isCollectedEdition = (c) => COLLECTED_EDITION_TITLES.has(cleanTitle(c.t).toLowerCase());

// Read-shelf screen. A translated work can reach the pool under its
// original-language title, which never matches the English title on the read
// shelf, so the English edition's title and ISBN are checked as well.
export const isAlreadyRead = (c, readKeys, readIsbns) =>
  readKeys.has(dedupKey(c.t, c.a)) ||
  (Boolean(c.editionTitle) && readKeys.has(dedupKey(c.editionTitle, c.a))) ||
  (Boolean(c.isbn) && readIsbns.has(c.isbn));

export async function run(opts) {
  const limit = Number(opts.limit) || 400;
  const sources = String(opts.source).split(',').map((s) => s.trim());
  const useOL = sources.includes('openlibrary');
  const hasGoogleKey = Boolean(process.env.GOOGLE_BOOKS_API_KEY);
  const useGoogle = sources.includes('googlebooks') && hasGoogleKey;

  const books = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));

  // What the reader has already read — exclude these from candidates.
  const readKeys = new Set(books.map((b) => dedupKey(b.t, b.a)));
  const readIsbns = new Set(books.map((b) => b.isbn).filter(Boolean));

  // Taste signals, most-read first so the strongest signals query first.
  const authors = [...new Set(books.map((b) => b.a))];
  const readAuthors = new Set(books.map((b) => b.a.toLowerCase()));
  const subjCount = new Map();
  for (const b of books) for (const s of b.s || []) subjCount.set(s, (subjCount.get(s) || 0) + 1);
  const subjects = broadenSubjects([...subjCount.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s));

  log(color.bold(`shelf fetch`) + ` — ${authors.length} authors, ${subjects.length} sub-genres`);
  if (opts.dryRun) log(color.dim('  (dry run — nothing will be written)'));

  // One bucket per query, so round-robin selection preserves breadth instead of
  // letting one prolific author or huge subject dominate the pool. Buckets come
  // back in plan order however the queries interleave, so the pool a given
  // shelf produces doesn't depend on which search answered first.
  //
  // A query that exhausts its retries costs its own bucket and nothing more —
  // the pool is a breadth sample, and losing one author or subject from it
  // beats losing every other query's work.
  const failedQueries = [];
  const collect = async ({ label, query }) => {
    try {
      return await query();
    } catch (err) {
      failedQueries.push(label);
      log(color.dim(`    ✗ ${label} — ${err.message}`));
      return [];
    }
  };

  const plan = [];
  if (useOL) {
    for (const a of authors) plan.push({ label: `author:${a}`, query: () => byAuthor(a, 6) });
    for (const s of subjects) plan.push({ label: `subject:${s}`, query: () => bySubject(s, 10) });
  }
  if (sources.includes('googlebooks') && !hasGoogleKey) {
    log(color.dim('  ↳ Google Books: skipped — no GOOGLE_BOOKS_API_KEY set'));
  }
  if (useGoogle) {
    for (const s of subjects.slice(0, 12)) {
      plan.push({ label: `google:subject:${s}`, query: () => googleBySubject(s, 10) });
    }
  }

  log(`  ↳ ${plan.length} queries, ${QUERY_CONCURRENCY} at a time…`);
  const buckets = await mapWithConcurrency(plan, QUERY_CONCURRENCY, collect);
  if (failedQueries.length) {
    log(color.dim(`  ⚠ ${failedQueries.length} of ${plan.length} queries failed — pool is that much narrower`));
  }

  // Round-robin flatten + dedupe. First occurrence of a dedupKey wins; later
  // hits just append their source label so provenance isn't lost.
  const chosen = new Map(); // dedupKey -> candidate
  let droppedByQuality = 0;
  let droppedBySelfPublishing = 0;
  let droppedAsCollectedEdition = 0;
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
      if (isSelfPublished(cand)) {
        droppedBySelfPublishing++;
        continue; // drop known self-publishing imprints
      }
      if (isCollectedEdition(cand)) {
        droppedAsCollectedEdition++;
        continue; // drop bundle records that name no single book
      }
      if (!passesQualityGate(cand, readAuthors)) {
        droppedByQuality++;
        continue; // drop low-signal self-published filler
      }
      if (isAlreadyRead(cand, readKeys, readIsbns)) continue;
      const key = dedupKey(cand.t, cand.a);
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
        ratingsCount: cand.ratingsCount,
        ratingsAverage: cand.ratingsAverage,
        editionCount: cand.editionCount,
        wantToReadCount: cand.wantToReadCount,
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
    googleBooksUsed: useGoogle,
    failedQueries: failedQueries.length,
    droppedByQuality,
    droppedBySelfPublishing,
    droppedAsCollectedEdition,
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
      ? `${s.candidates} candidates ${s.withIsbn} isbn ${s.withPages} pages ${s.droppedByQuality} dropped-by-quality`
      : `candidates: ${s.candidates}  (isbn ${s.withIsbn}, pages ${s.withPages})  dropped-by-quality: ${s.droppedByQuality}`,
  );
}
