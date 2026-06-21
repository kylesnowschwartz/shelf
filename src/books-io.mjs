// Shared read/write for books.json — a single serialization point so add-ids
// and enrich-books can't drift on field order or which optional keys persist.
import { readFile, writeFile } from 'node:fs/promises';
import { BOOKS_JSON } from './paths.mjs';

export async function readBooks() {
  return JSON.parse(await readFile(BOOKS_JSON, 'utf8'));
}

// The single serialization point: stable field order, optional keys only when
// present. `shelf export` reuses this so the website's committed copy is
// byte-identical to the shelf-owned original.
export function serializeBooks(books) {
  const ordered = books.map((b) => ({
    id: b.id,
    t: b.t,
    a: b.a,
    g: b.g,
    s: b.s,
    b: b.b,
    why: b.why,
    ...(b.isbn ? { isbn: b.isbn } : {}),
    ...(b.coverId !== undefined ? { coverId: b.coverId } : {}),
    ...(b.year !== undefined ? { year: b.year } : {}),
    ...(b.noIsbn ? { noIsbn: true } : {}),
  }));
  return JSON.stringify(ordered, null, 2) + '\n';
}

export async function writeBooks(books) {
  await writeFile(BOOKS_JSON, serializeBooks(books));
}
