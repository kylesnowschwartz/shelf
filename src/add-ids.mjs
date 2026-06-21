// One-shot: give each book a stable slug `id` (required by Astro's file()
// loader, and a durable key for CRUD + ISBN matching). Idempotent.
import { readBooks, writeBooks } from './books-io.mjs';

const books = await readBooks();

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop "(Thrawn 1)" etc.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const seen = new Set();
for (const b of books) {
  if (!b.id) {
    let id = slug(b.t);
    let n = 2;
    while (seen.has(id)) id = `${slug(b.t)}-${n++}`;
    b.id = id;
  }
  seen.add(b.id);
}

await writeBooks(books);
console.log(`stamped ids on ${books.length} books`);
