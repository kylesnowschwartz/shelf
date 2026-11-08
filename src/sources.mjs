// Candidate sources. Open Library is free-text search with no API key, the
// keyless baseline every install gets. Google Books requires a key on every
// request, so it is queried only when GOOGLE_BOOKS_API_KEY is set — an
// optional enhancement for the owner's keyed clone, not a requirement for the
// plugin's keyless users. Each fetch returns an array of raw candidate
// records {t,a,year,isbn,pages,subjects,firstSentence,source}.
import { getJson } from './http.mjs';
import { pickIsbn13, pickEnglishIsbn13, primaryAuthor, cleanTitle, displayTitle, threeLetterLanguage } from './util.mjs';

const OL = 'https://openlibrary.org/search.json';
// Open Library's search index routinely takes upwards of 15 seconds to answer
// a sorted author or subject query, so searches get a longer ceiling than the
// default single-record lookups do.
const SEARCH_TIMEOUT_MS = 45000;
const OL_FIELDS =
  'title,author_name,first_publish_year,isbn,number_of_pages_median,subject,first_sentence,ratings_count,ratings_average,edition_count,want_to_read_count,language';

export function fromOpenLibrary(doc, source) {
  if (!doc?.title || !Array.isArray(doc.author_name) || !doc.author_name.length) return null;
  return {
    t: displayTitle(doc.title),
    a: doc.author_name[0].trim(),
    year: typeof doc.first_publish_year === 'number' ? doc.first_publish_year : undefined,
    isbn: pickIsbn13(doc.isbn),
    pages: typeof doc.number_of_pages_median === 'number' ? doc.number_of_pages_median : undefined,
    subjects: Array.isArray(doc.subject) ? doc.subject.slice(0, 8) : [],
    firstSentence: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence,
    languages: Array.isArray(doc.language) ? doc.language : undefined,
    ratingsCount: typeof doc.ratings_count === 'number' ? doc.ratings_count : undefined,
    ratingsAverage: typeof doc.ratings_average === 'number' ? doc.ratings_average : undefined,
    editionCount: typeof doc.edition_count === 'number' ? doc.edition_count : undefined,
    wantToReadCount: typeof doc.want_to_read_count === 'number' ? doc.want_to_read_count : undefined,
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
  const data = await getJson(`${OL}?${params}`, { retries: 2, timeoutMs: SEARCH_TIMEOUT_MS });
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
  const data = await getJson(`${OL}?${params}`, { retries: 2, timeoutMs: SEARCH_TIMEOUT_MS });
  return (data?.docs || []).map((d) => fromOpenLibrary(d, `openlibrary:subject:${subject}`)).filter(Boolean);
}

const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';

/**
 * Maps a Google Books `volumeInfo` record onto the shared candidate shape.
 *
 * Google's rating fields reach roughly a tenth of volumes and report
 * single-digit counts where they do — "Misery" comes back with one rating —
 * nowhere near the thousands-of-raters scale `passesQualityGate`'s floors are
 * set against. They are dropped rather than recorded: too sparse to rank by,
 * and low enough to read a bestseller as under-floor if the gate saw them.
 * Leaving the gate-relevant fields undefined lets a Google candidate through
 * as unproven, which matches Google's already-curated relevance ordering.
 * `publisher` is the signal Google does carry usefully, and the
 * self-publishing screen uses it.
 *
 * `description` is a marketing blurb, not the opening line Open Library's
 * `first_sentence` gives, but it lands in the same field because it plays the
 * same role: the descriptive text `embed-model.mjs` embeds alongside the
 * title and subjects. Without it a Google candidate embeds on its title
 * alone.
 */
export function fromGoogleBooks(volumeInfo, source) {
  if (!volumeInfo?.title || !Array.isArray(volumeInfo.authors) || !volumeInfo.authors.length) return null;
  const isbns = (volumeInfo.industryIdentifiers || [])
    .filter((id) => id.type === 'ISBN_13')
    .map((id) => id.identifier);
  return {
    t: displayTitle(volumeInfo.title),
    a: volumeInfo.authors[0].trim(),
    year: /^\d{4}/.test(volumeInfo.publishedDate || '') ? Number(volumeInfo.publishedDate.slice(0, 4)) : undefined,
    isbn: pickIsbn13(isbns),
    pages: typeof volumeInfo.pageCount === 'number' ? volumeInfo.pageCount : undefined,
    subjects: Array.isArray(volumeInfo.categories) ? volumeInfo.categories.slice(0, 8) : [],
    firstSentence: typeof volumeInfo.description === 'string' ? volumeInfo.description.slice(0, 240) : undefined,
    languages: volumeInfo.language ? [threeLetterLanguage(volumeInfo.language)] : undefined,
    publisher: typeof volumeInfo.publisher === 'string' ? volumeInfo.publisher : undefined,
    ratingsCount: undefined,
    ratingsAverage: undefined,
    editionCount: undefined,
    wantToReadCount: undefined,
    source,
  };
}

/**
 * Top-rated books in a subject, sourced from the Google Books volumes API — a
 * second discovery signal alongside Open Library's. Google requires an API
 * key on every request, so this source is optional: it makes no request at
 * all when `GOOGLE_BOOKS_API_KEY` is unset, and a quota or auth failure never
 * fails the run (`optional: true`).
 */
export async function googleBySubject(subject, perQuery, { fetchImpl } = {}) {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({
    q: `subject:"${subject}"`,
    maxResults: String(Math.min(perQuery, 40)),
    langRestrict: 'en',
    printType: 'books', // the volumes index also carries magazines
    key,
  });
  const data = await getJson(`${GOOGLE_BOOKS}?${params}`, {
    retries: 2,
    optional: true,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return (data?.items || [])
    .map((item) => fromGoogleBooks(item.volumeInfo, `googlebooks:subject:${subject}`))
    .filter(Boolean);
}

/**
 * Resolve metadata for ONE known book (title + author) — the lookup `enrich`
 * and `add` share. Returns { isbn, coverId, year, subjects, firstSentence,
 * languages } from the best Open Library match, or null if nothing matched.
 *
 * A translated work is sometimes indexed as its own separate, unmerged "work"
 * record — a structured title=/author= search can land on that foreign-
 * language record outright (year, cover, and ISBN all specific to that
 * edition), so the query is free text combined with the `language=eng`
 * filter, which reliably lands on the merged, English-tagged work record
 * instead. Even that record's `isbn` list aggregates every translation's
 * ISBNs together, so pickEnglishIsbn13 — not pickIsbn13 — is what keeps a
 * foreign-language ISBN out of the result.
 */
export async function lookupBook(title, author, { fetchImpl } = {}) {
  const params = new URLSearchParams({
    q: `${cleanTitle(title)} ${primaryAuthor(author)}`,
    language: 'eng',
    fields: 'title,author_name,isbn,cover_i,first_publish_year,subject,first_sentence,language',
    limit: '1',
  });
  const data = await getJson(`${OL}?${params}`, { retries: 3, ...(fetchImpl ? { fetchImpl } : {}) });
  const doc = data?.docs?.[0];
  if (!doc) return null;
  return {
    isbn: pickEnglishIsbn13(doc.isbn),
    coverId: doc.cover_i,
    year: doc.first_publish_year,
    subjects: Array.isArray(doc.subject) ? doc.subject.slice(0, 12) : [],
    firstSentence: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence,
    languages: Array.isArray(doc.language) ? doc.language : undefined,
  };
}

/**
 * Resolve ONE ISBN to the work's { title, author } via Open Library's keyless
 * search. Returns null when Open Library has no record carrying that ISBN, or
 * the record lacks a title or author.
 */
export async function lookupIsbn(isbn, { fetchImpl } = {}) {
  const params = new URLSearchParams({
    isbn: String(isbn).replace(/[^0-9Xx]/g, ''),
    fields: 'title,author_name',
    limit: '1',
  });
  const data = await getJson(`${OL}?${params}`, { retries: 3, ...(fetchImpl ? { fetchImpl } : {}) });
  const doc = data?.docs?.[0];
  if (!doc?.title || !Array.isArray(doc.author_name) || !doc.author_name.length) return null;
  return { title: doc.title, author: doc.author_name[0].trim() };
}
