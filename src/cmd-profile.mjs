// `shelf profile` — print the reader's taste profile: genre mix (the
// calibration target), most-read authors and sub-genres. An auditing aid so you
// can see what the recommender is reasoning from.
import { readFile } from 'node:fs/promises';
import { BOOKS_JSON } from './paths.mjs';
import { emit, color } from './output.mjs';
import { genreHistogram } from './recommend.ts';

export async function run(opts) {
  const books = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));
  const hist = genreHistogram(books.map((b) => b.g));

  const tally = (vals) => {
    const m = new Map();
    for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const authors = tally(books.map((b) => b.a)).filter(([, n]) => n > 1);
  const subgenres = tally(books.flatMap((b) => b.s || [])).slice(0, 10);

  const result = {
    booksRead: books.length,
    genreMix: Object.fromEntries(Object.entries(hist).map(([g, s]) => [g, Math.round(s * 1000) / 1000])),
    repeatAuthors: authors.map(([a, n]) => ({ author: a, books: n })),
    topSubgenres: subgenres.map(([s, n]) => ({ subgenre: s, books: n })),
  };

  emit(result, opts, (d, plain) => {
    if (plain) return Object.entries(d.genreMix).map(([g, s]) => `${g}\t${s}`).join('\n');
    const lines = [color.bold(`taste profile`) + color.dim(`  ${d.booksRead} books read`), ''];
    lines.push(color.dim('  genre mix (calibration target):'));
    for (const [g, s] of Object.entries(d.genreMix).sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${g.padEnd(11)} ${color.accent('█'.repeat(Math.round(s * 30)))} ${(s * 100).toFixed(0)}%`);
    }
    lines.push('', color.dim('  most-read authors: ') + d.repeatAuthors.slice(0, 8).map((x) => `${x.author} (${x.books})`).join(', '));
    lines.push(color.dim('  top sub-genres:    ') + d.topSubgenres.slice(0, 6).map((x) => `${x.subgenre} (${x.books})`).join(', '));
    return lines.join('\n');
  });
}
