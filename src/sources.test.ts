import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error — .mjs sibling has no type declarations
import { lookupBook, fromOpenLibrary, googleBySubject, fromGoogleBooks } from './sources.mjs';

/** A Response-shaped stub carrying only what getJson reads. */
function reply(body: unknown) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => body,
  };
}

/** Stubs the single Open Library call lookupBook makes and records the URL requested. */
function stubFetch(body: unknown) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return reply(body);
  };
  return { urls, fetchImpl };
}

describe('lookupBook', () => {
  it('picks the English edition ISBN and the work\'s first-publish year over a translation edition ahead of it', async () => {
    // Shaped like the real Open Library response for "The Girl Who Played
    // with Fire": the merged work's isbn list mixes Korean and Japanese
    // edition ISBNs in ahead of the English ones, and a same-titled English
    // *edition* record (not shown here) would carry its 2009 translation
    // year instead of the work's 2006 original.
    const { urls, fetchImpl } = stubFetch({
      docs: [
        {
          title: 'The Girl Who Played with Fire',
          first_publish_year: 2006,
          cover_i: 8345016,
          isbn: ['9784151792533', '9788901119533', '9780307476159', '9781906694180'],
          subject: ['Mystery fiction'],
        },
      ],
    });

    const hit = await lookupBook('The Girl Who Played with Fire', 'Stieg Larsson', { fetchImpl });

    expect(hit.isbn).toBe('9780307476159');
    expect(hit.year).toBe(2006);
    expect(hit.coverId).toBe(8345016);
    expect(urls[0]).toMatch(/language=eng/);
  });

  it('leaves isbn undefined rather than falling back to a foreign-language edition', async () => {
    // Every ISBN on this doc is a non-English registration group (Korean 89,
    // French 2) — there is no English edition to prefer, so the resolver
    // must not silently hand back one of these.
    const { fetchImpl } = stubFetch({
      docs: [
        {
          title: 'Män som hatar kvinnor',
          first_publish_year: 2005,
          isbn: ['9788901116150', '9782742761579'],
          subject: [],
        },
      ],
    });

    const hit = await lookupBook('The Girl with the Dragon Tattoo', 'Stieg Larsson', { fetchImpl });

    expect(hit.isbn).toBeUndefined();
    expect(hit.year).toBe(2005);
  });

  it('returns null when Open Library has no match', async () => {
    const { fetchImpl } = stubFetch({ docs: [] });
    const hit = await lookupBook('Some Nonexistent Title', 'Nobody', { fetchImpl });
    expect(hit).toBeNull();
  });
});

describe('fromOpenLibrary', () => {
  it('carries ratings_count, edition_count, and want_to_read_count onto the candidate record', () => {
    const cand = fromOpenLibrary(
      {
        title: 'Project Hail Mary',
        author_name: ['Andy Weir'],
        ratings_count: 5000,
        edition_count: 12,
        want_to_read_count: 40000,
      },
      'openlibrary:subject:science fiction',
    );

    expect(cand.ratingsCount).toBe(5000);
    expect(cand.editionCount).toBe(12);
    expect(cand.wantToReadCount).toBe(40000);
  });

  it('leaves the quality fields undefined when Open Library omits them', () => {
    const cand = fromOpenLibrary({ title: 'Some Book', author_name: ['Some Author'] }, 'openlibrary:subject:thriller');

    expect(cand.ratingsCount).toBeUndefined();
    expect(cand.editionCount).toBeUndefined();
    expect(cand.wantToReadCount).toBeUndefined();
  });
});

describe('fromGoogleBooks', () => {
  it('discards a present rating rather than recording it anywhere', () => {
    // A Stephen King title turns up from Google Books with a ratingsCount of
    // 1 — not a low-signal book, a source whose ratings are vestigial. Mapping
    // that onto the shared `ratingsCount` field would make it look proven-
    // but-below-floor to passesQualityGate instead of unproven.
    const cand = fromGoogleBooks(
      {
        title: 'Misery',
        authors: ['Stephen King'],
        ratingsCount: 1,
        averageRating: 4.5,
      },
      'googlebooks:subject:horror',
    );

    expect(cand.ratingsCount).toBeUndefined();
    expect(cand.ratingsAverage).toBeUndefined();
    expect(cand.editionCount).toBeUndefined();
    expect(cand.wantToReadCount).toBeUndefined();
    expect(Object.keys(cand).some((k) => /rating/i.test(k) && cand[k] !== undefined)).toBe(false);
  });

  it('leaves every rating field undefined when Google omits them', () => {
    const cand = fromGoogleBooks({ title: 'Some Book', authors: ['Some Author'] }, 'googlebooks:subject:thriller');

    expect(cand.ratingsCount).toBeUndefined();
    expect(cand.ratingsAverage).toBeUndefined();
  });

  it('records language in the three-letter form the English guard tests against', () => {
    // Google reports "en" where Open Library reports "eng". cmd-fetch's
    // isEnglish asks whether languages includes "eng", so a two-letter code
    // reaching a candidate record classifies every Google book as foreign and
    // silently empties the source out of the pool.
    const cand = fromGoogleBooks(
      { title: 'Gone Girl', authors: ['Gillian Flynn'], language: 'en' },
      'googlebooks:subject:thriller',
    );
    expect(cand.languages).toEqual(['eng']);
  });

  it('keeps a non-English Google code distinguishable from English', () => {
    const cand = fromGoogleBooks(
      { title: 'Das Parfum', authors: ['Patrick Süskind'], language: 'de' },
      'googlebooks:subject:literary',
    );
    expect(cand.languages).toEqual(['ger']);
  });

  it('carries publisher through when present, and leaves it undefined when absent', () => {
    const withPublisher = fromGoogleBooks(
      { title: 'Some Book', authors: ['Some Author'], publisher: 'Independently published' },
      'googlebooks:subject:thriller',
    );
    const withoutPublisher = fromGoogleBooks({ title: 'Some Book', authors: ['Some Author'] }, 'googlebooks:subject:thriller');

    expect(withPublisher.publisher).toBe('Independently published');
    expect(withoutPublisher.publisher).toBeUndefined();
  });
});

describe('googleBySubject', () => {
  const ORIGINAL_KEY = process.env.GOOGLE_BOOKS_API_KEY;

  beforeEach(() => {
    delete process.env.GOOGLE_BOOKS_API_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.GOOGLE_BOOKS_API_KEY;
    else process.env.GOOGLE_BOOKS_API_KEY = ORIGINAL_KEY;
  });

  it('makes no request and returns [] when GOOGLE_BOOKS_API_KEY is unset', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      throw new Error('should not be called');
    };

    const result = await googleBySubject('thriller', 10, { fetchImpl });

    expect(called).toBe(false);
    expect(result).toEqual([]);
  });

  it('appends the key as the `key` query param when GOOGLE_BOOKS_API_KEY is set', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'dummy-test-key';
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({ items: [] }),
      };
    };

    await googleBySubject('thriller', 10, { fetchImpl });

    expect(urls).toHaveLength(1);
    const requested = new URL(urls[0]);
    expect(requested.searchParams.get('key')).toBe('dummy-test-key');
  });
});
