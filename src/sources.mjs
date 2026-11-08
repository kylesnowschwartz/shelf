// Candidate sources. Open Library is free-text search with no API key, the
// keyless baseline every install gets. Google Books requires a key on every
// request, so it is queried only when GOOGLE_BOOKS_API_KEY is set — an
// optional enhancement for the owner's keyed clone, not a requirement for the
// plugin's keyless users. Each fetch returns an array of raw candidate
// records {t,a,year,isbn,pages,subjects,firstSentence,source}.
import { getJson } from './http.mjs';
import {
  pickIsbn13,
  pickEnglishIsbn13,
  primaryAuthor,
  cleanTitle,
  displayTitle,
  threeLetterLanguage,
  looksNonEnglish,
} from './util.mjs';

const OL = 'https://openlibrary.org/search.json';
// Open Library's search index routinely takes upwards of 15 seconds to answer
// a sorted author or subject query, so searches get a longer ceiling than the
// default single-record lookups do.
const SEARCH_TIMEOUT_MS = 45000;
// `editions.*` returns the edition Open Library matched inside each work doc.
// Its `docs` list comes back empty unless `key` is requested alongside it.
const OL_FIELDS =
  'key,title,author_name,first_publish_year,isbn,number_of_pages_median,subject,first_sentence,ratings_count,ratings_average,edition_count,want_to_read_count,language,editions,editions.title,editions.language,editions.isbn';

/** The edition Open Library matched inside a work doc, when it is an English one. */
const englishEdition = (doc) => {
  const edition = doc.editions?.docs?.[0];
  if (!edition?.title || !Array.isArray(edition.language) || !edition.language.includes('eng')) return undefined;
  return edition;
};

/** A name with accents, case and punctuation folded away, for comparing catalog spellings. */
const foldName = (name) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Whether a work doc from an author query is by the queried author.
 *
 * An author query also returns anthologies, works the author introduced, and
 * books by other people with a similar name, so a doc counts only when its
 * first author is the queried author. That holds when the first author's name
 * folds to the queried name, or when the doc has a single author whose
 * alternative names include the queried name ("Fiódor Dostoievski" lists
 * "Fyodor Dostoevsky"). The second test also requires the two surnames to
 * start with the same four letters, because catalog alternative names contain
 * errors: Robert Bloch's list includes "Jim Kjelgaard".
 */
export function isByQueriedAuthor(doc, queriedAuthor) {
  const names = doc.author_name;
  const queried = foldName(queriedAuthor);
  const first = foldName(names[0]);
  if (first === queried) return true;
  if (names.length !== 1 || !Array.isArray(doc.author_alternative_name)) return false;
  const surnamePrefix = (folded) => folded.split(' ').pop().slice(0, 4);
  return (
    surnamePrefix(first) === surnamePrefix(queried) &&
    doc.author_alternative_name.some((alt) => foldName(alt) === queried)
  );
}

/**
 * Maps an Open Library work doc onto the shared candidate shape.
 *
 * A work's `title` is the title in the book's original language, so a
 * translated novel arrives as "Flickan som lekte med elden", and its `isbn`
 * list mixes every translation's ISBNs together. The English edition matched
 * inside the doc gives the title and ISBN an English reader knows the book
 * by. Its title is carried as `editionTitle` so the read-shelf check can match
 * on either name. It replaces the work title only when the work title looks
 * non-English and the edition is English alone: an English original's work
 * title is the better name, and its matched edition can be a study guide or a
 * mislabelled translation.
 *
 * `queriedAuthor` is the read-shelf author an author query asked for. A doc by
 * that author takes the shelf's spelling as its author, so the read-shelf
 * check and pool dedup see one name for the author however the catalog spells
 * it. Any other doc keeps the catalog's first author.
 */
export function fromOpenLibrary(doc, source, queriedAuthor) {
  if (!doc?.title || !Array.isArray(doc.author_name) || !doc.author_name.length) return null;
  const edition = englishEdition(doc);
  const editionTitle = edition ? displayTitle(edition.title) : undefined;
  const useEditionTitle = Boolean(edition) && edition.language.length === 1 && looksNonEnglish(doc.title);
  return {
    t: useEditionTitle ? editionTitle : displayTitle(doc.title),
    editionTitle,
    a: queriedAuthor && isByQueriedAuthor(doc, queriedAuthor) ? queriedAuthor : doc.author_name[0].trim(),
    year: typeof doc.first_publish_year === 'number' ? doc.first_publish_year : undefined,
    isbn: pickIsbn13(edition?.isbn) || pickIsbn13(doc.isbn),
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
  const queriedAuthor = primaryAuthor(author);
  const params = new URLSearchParams({
    author: queriedAuthor,
    fields: `${OL_FIELDS},author_alternative_name`, // read by isByQueriedAuthor
    language: 'eng',
    lang: 'en', // match an English edition inside each work doc
    sort: 'editions',
    limit: String(perQuery),
  });
  const data = await getJson(`${OL}?${params}`, { retries: 2, timeoutMs: SEARCH_TIMEOUT_MS });
  return (data?.docs || [])
    .map((d) => fromOpenLibrary(d, `openlibrary:author:${queriedAuthor}`, queriedAuthor))
    .filter(Boolean);
}

/** Top-rated books in a subject the reader gravitates to ("discovery" signal). */
export async function bySubject(subject, perQuery) {
  const params = new URLSearchParams({
    q: `subject:"${subject}"`,
    fields: OL_FIELDS,
    language: 'eng',
    lang: 'en', // match an English edition inside each work doc
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
