// `shelf add "<title>" "<author>"` — one-shot: resolve a book's metadata from
// Open Library, stamp a slug id, and append it to books.json. Factual fields
// (isbn, year, cover, suggested genre) come from the catalog; editorial fields
// (--why, --sub, --blend, --genre) are yours to pass, with sensible fallbacks
// and loud warnings when something needs your hand.
import { readBooks, writeBooks } from './books-io.mjs';
import { lookupBook } from './sources.mjs';
import { slugify, dedupKey, plausibleYear } from './util.mjs';
import { log, emit, fail, EXIT, color } from './output.mjs';
import { GENRES } from './genres.mjs';

// Rough genre inference from catalog subjects — a starting guess, always
// surfaced as a warning so it can be overridden with --genre.
function inferGenre(subjects) {
  const s = subjects.join(' ').toLowerCase();
  if (/fantasy|science fiction|sci-fi|dragons|wizards|space opera|dystopia/.test(s)) return 'SFF';
  if (/horror|ghost|haunt|vampire|occult|supernatural/.test(s)) return 'Horror';
  if (/thriller|crime|mystery|detective|spy|espionage|suspense|noir/.test(s)) return 'Thriller';
  if (/biography|autobiography|history|science|essays|memoir|nonfiction|economics|politics|nature|philosophy/.test(s)) return 'Nonfiction';
  return 'Literary';
}

export async function run(opts, command) {
  const [title, author] = command.args;
  if (!title || !author) fail(EXIT.USAGE, 'usage: shelf add "<title>" "<author>" [--genre G] [--why "…"] [--sub a,b] [--blend a,b]');

  const books = await readBooks();
  const key = dedupKey(title, author);
  const dupe = books.find((b) => dedupKey(b.t, b.a) === key);
  if (dupe) fail(EXIT.USAGE, `already on the shelf: "${dupe.t}" by ${dupe.a} (id ${dupe.id})`);

  if (opts.genre && !GENRES.includes(opts.genre)) fail(EXIT.USAGE, `--genre must be one of ${GENRES.join('|')}`);

  log(color.bold('shelf add') + ` — resolving "${title}" by ${author} via Open Library…`);
  const hit = await lookupBook(title, author);
  const thisYear = new Date().getFullYear();
  const warnings = [];

  let genre = opts.genre;
  if (!genre) {
    genre = inferGenre(hit?.subjects || []);
    warnings.push(`genre inferred as "${genre}" — override with --genre if wrong`);
  }

  const why = opts.why || (hit?.firstSentence ? String(hit.firstSentence).slice(0, 160) : '');
  if (!opts.why) warnings.push(why ? "why defaulted to the book's first line — set --why to editorialize" : 'no --why given and none derivable — set --why');
  if (!hit) warnings.push('Open Library had no match — no ISBN/year/cover; verify the title/author spelling');

  const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);

  let id = slugify(title);
  const ids = new Set(books.map((b) => b.id));
  let n = 2;
  const baseId = id;
  while (ids.has(id)) id = `${baseId}-${n++}`;

  const entry = {
    id,
    t: title,
    a: author,
    g: genre,
    s: list(opts.sub),
    b: list(opts.blend),
    why,
    ...(hit?.isbn ? { isbn: hit.isbn } : {}),
    ...(hit?.coverId !== undefined ? { coverId: hit.coverId } : {}),
    ...(plausibleYear(hit?.year, thisYear) ? { year: hit.year } : {}),
    ...(!hit?.isbn ? { noIsbn: true } : {}),
  };

  if (!opts.dryRun) {
    books.push(entry);
    await writeBooks(books);
    log(color.accent(`  ✓ added "${title}" → data/books.json (id ${id})`));
    for (const w of warnings) log(color.dim(`  ⚠ ${w}`));
    log(color.dim('  ↳ refresh recommendations: shelf fetch && shelf embed && shelf build'));
    log(color.dim('  ↳ then publish to the website: shelf export'));
  } else {
    log(color.dim('  (dry run — nothing written)'));
    for (const w of warnings) log(color.dim(`  ⚠ ${w}`));
  }

  emit({ added: !opts.dryRun, entry, warnings }, opts, (d, plain) =>
    plain
      ? `${d.entry.id}\t${d.entry.g}\t${d.entry.isbn || 'no-isbn'}`
      : `${d.added ? 'added' : 'would add'}: ${d.entry.t} — ${d.entry.a} [${d.entry.g}]  isbn=${d.entry.isbn || 'none'} year=${d.entry.year || '?'}` +
        (d.warnings.length ? '\n  ' + d.warnings.map((w) => `⚠ ${w}`).join('\n  ') : ''),
  );
}
