// Candidate sources. Open Library is the load-bearing, reliable keyless source;
// Google Books is best-effort enrichment (its anonymous quota is frequently
// exhausted — a 429 there must never fail the run). Each fetch returns an array
// of raw candidate records {t,a,year,isbn,pages,subjects,firstSentence,source}.
import { getJson } from './http.mjs';
import { pickIsbn13, primaryAuthor, cleanTitle } from './util.mjs';

const OL = 'https://openlibrary.org/search.json';
const OL_FIELDS = 'title,author_name,first_publish_year,isbn,number_of_pages_median,subject,first_sentence,ratings_count,language';

function fromOpenLibrary(doc, source) {
  if (!doc?.title || !Array.isArray(doc.author_name) || !doc.author_name.length) return null;
  return {
    t: doc.title.trim(),
    a: doc.author_name[0].trim(),
    year: typeof doc.first_publish_year === 'number' ? doc.first_publish_year : undefined,
    isbn: pickIsbn13(doc.isbn),
    pages: typeof doc.number_of_pages_median === 'number' ? doc.number_of_pages_median : undefined,
    subjects: Array.isArray(doc.subject) ? doc.subject.slice(0, 8) : [],
    firstSentence: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence,
    languages: Array.isArray(doc.language) ? doc.language : undefined,
    source,
  };
}

/** More books by an author the reader already reads ("familiar" signal). */
export async function byAuthor(author, perQuery) {
  const params = new URLSearchParams({
    author: primaryAuthor(author),
    fields: OL_FIELDS,
    language: 'eng',
    sort: 'editions',
    limit: String(perQuery),
  });
  const data = await getJson(`${OL}?${params}`, { retries: 2 });
  return (data?.docs || []).map((d) => fromOpenLibrary(d, `openlibrary:author:${primaryAuthor(author)}`)).filter(Boolean);
}

/** Top-rated books in a subject the reader gravitates to ("discovery" signal). */
export async function bySubject(subject, perQuery) {
  const params = new URLSearchParams({
    q: `subject:"${subject}"`,
    fields: OL_FIELDS,
    language: 'eng',
    sort: 'rating',
    limit: String(perQuery),
  });
  const data = await getJson(`${OL}?${params}`, { retries: 2 });
  return (data?.docs || []).map((d) => fromOpenLibrary(d, `openlibrary:subject:${subject}`)).filter(Boolean);
}

/**
 * Resolve metadata for ONE known book (title + author) — the lookup `enrich`
 * and `add` share. Returns { isbn, coverId, year, subjects, firstSentence,
 * languages } from the best Open Library match, or null if nothing matched.
 */
export async function lookupBook(title, author) {
  const params = new URLSearchParams({
    title: cleanTitle(title),
    author: primaryAuthor(author),
    fields: 'title,author_name,isbn,cover_i,first_publish_year,subject,first_sentence,language',
    limit: '1',
  });
  const data = await getJson(`${OL}?${params}`, { retries: 3 });
  const doc = data?.docs?.[0];
  if (!doc) return null;
  return {
    isbn: pickIsbn13(doc.isbn),
    coverId: doc.cover_i,
    year: doc.first_publish_year,
    subjects: Array.isArray(doc.subject) ? doc.subject.slice(0, 12) : [],
    firstSentence: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence,
    languages: Array.isArray(doc.language) ? doc.language : undefined,
  };
}

/** Best-effort Google Books by subject. Returns [] on quota/429 — never throws. */
export async function googleBySubject(subject, perQuery) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`subject:${subject}`)}&maxResults=${Math.min(perQuery, 20)}&langRestrict=en&printType=books`;
  const data = await getJson(url, { retries: 1, optional: true });
  if (!data?.items) return [];
  return data.items
    .map((it) => {
      const v = it.volumeInfo || {};
      if (!v.title || !Array.isArray(v.authors) || !v.authors.length) return null;
      const isbn13 = (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13')?.identifier;
      const year = v.publishedDate ? Number(String(v.publishedDate).slice(0, 4)) : undefined;
      return {
        t: v.title.trim(),
        a: v.authors[0].trim(),
        year: Number.isFinite(year) ? year : undefined,
        isbn: isbn13,
        pages: typeof v.pageCount === 'number' && v.pageCount > 0 ? v.pageCount : undefined,
        subjects: Array.isArray(v.categories) ? v.categories.slice(0, 8) : [],
        firstSentence: v.description ? String(v.description).slice(0, 240) : undefined,
        source: `googlebooks:subject:${subject}`,
      };
    })
    .filter(Boolean);
}
