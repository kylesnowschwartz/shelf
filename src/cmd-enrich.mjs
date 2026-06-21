// `shelf enrich` — fill missing ISBN-13, cover id, and first-publish year on
// books.json from the keyless Open Library API. Idempotent (skips books already
// fully enriched) and polite (http.mjs throttles + backs off). Replaces the
// old standalone scripts/enrich-books.mjs.
import { readBooks, writeBooks } from './books-io.mjs';
import { lookupBook } from './sources.mjs';
import { plausibleYear } from './util.mjs';
import { log, emit, color } from './output.mjs';

export async function run(opts) {
  const books = await readBooks();
  const thisYear = new Date().getFullYear();

  let attempted = 0;
  let resolved = 0;
  let hadError = false;
  log(color.bold('shelf enrich') + ` — ${books.length} books`);

  for (const book of books) {
    // Fully enriched = ISBN resolved (or known-missing) AND a publish year known.
    if ((book.isbn || book.noIsbn) && book.year !== undefined) continue;
    attempted++;
    try {
      const hit = await lookupBook(book.t, book.a);
      if (!hit) {
        if (!book.isbn) book.noIsbn = true;
      } else {
        if (plausibleYear(hit.year, thisYear)) book.year = hit.year;
        if (hit.coverId) book.coverId = hit.coverId;
        if (hit.isbn) {
          book.isbn = hit.isbn;
          delete book.noIsbn;
        } else if (!book.isbn) {
          book.noIsbn = true;
        }
      }
      if (book.isbn) resolved++;
      log(`  ${book.isbn ? '✓' : '✗'} ${book.t}${book.isbn ? ` → ${book.isbn}` : ' — no ISBN'}${book.year ? ` (${book.year})` : ''}`);
    } catch (err) {
      hadError = true;
      log(color.dim(`  ! ${book.t} — ${err.message}`));
    }
  }

  if (!opts.dryRun) await writeBooks(books);

  const withIsbn = books.filter((b) => b.isbn).length;
  const noYear = books.filter((b) => b.year === undefined).length;
  const summary = { books: books.length, attempted, newlyResolved: resolved, withIsbn, missingYear: noYear, hadError };
  log(color.accent(`  ✓ ISBN resolved ${withIsbn}/${books.length}; years missing: ${noYear}`));
  if (hadError) process.exitCode = 1; // surface partial failure to CI / callers
  emit(summary, opts, (s, plain) =>
    plain ? `${s.withIsbn}/${s.books} isbn` : `enriched ${s.attempted} attempted, ${s.withIsbn}/${s.books} have ISBN, ${s.missingYear} missing year`,
  );
}
