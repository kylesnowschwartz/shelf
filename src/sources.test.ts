import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error — .mjs sibling has no type declarations
import { lookupBook, lookupIsbn, lookupIsbnGoogle, fromOpenLibrary, isByQueriedAuthor, googleBySubject, fromGoogleBooks } from './sources.mjs';

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

describe('lookupIsbn', () => {
  it('asks Open Library by isbn and returns the title and first author', async () => {
    const { urls, fetchImpl } = stubFetch({ docs: [{ title: 'Dead Lions', author_name: ['Mick Herron'] }] });
    const hit = await lookupIsbn('978-1-61695-225-9', { fetchImpl });
    expect(hit).toEqual({ title: 'Dead Lions', author: 'Mick Herron' });
    const url = new URL(urls[0]);
    expect(url.searchParams.get('isbn')).toBe('9781616952259');
    expect(url.searchParams.has('key')).toBe(false);
  });

  it('returns null when Open Library has no record for the isbn', async () => {
    const { fetchImpl } = stubFetch({ docs: [] });
    expect(await lookupIsbn('9780000000000', { fetchImpl })).toBeNull();
  });
});

describe('lookupIsbnGoogle', () => {
  it('asks the Google Books volumes API by isbn, without a key, and returns the title and first author', async () => {
    const { urls, fetchImpl } = stubFetch({ items: [{ volumeInfo: { title: 'Dead Lions', authors: ['Mick Herron'] } }] });
    const hit = await lookupIsbnGoogle('978-1-61695-225-9', { fetchImpl });
    expect(hit).toEqual({ title: 'Dead Lions', author: 'Mick Herron' });
    const url = new URL(urls[0]);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/books/v1/volumes');
    expect(url.searchParams.get('q')).toBe('isbn:9781616952259');
    expect(url.searchParams.has('key')).toBe(false);
  });

  it('returns null when no volume carries the isbn', async () => {
    const { fetchImpl } = stubFetch({ totalItems: 0 });
    expect(await lookupIsbnGoogle('9780000000000', { fetchImpl })).toBeNull();
  });

  it('throws when the service cannot be reached', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(lookupIsbnGoogle('9781616952259', { fetchImpl })).rejects.toThrow(/fetch failed/);
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

  it('carries the English edition title and ISBN of a work indexed under its original-language title', () => {
    // Shaped like Open Library's real work doc for "The Girl Who Played with
    // Fire": the work title is Swedish and the aggregated isbn list leads with
    // a Polish edition, while the matched English edition carries both the
    // English title and the English ISBN.
    const cand = fromOpenLibrary(
      {
        title: 'Flickan som lekte med elden',
        author_name: ['Stieg Larsson'],
        isbn: ['8375540900', '9788375540901', '9780307476159'],
        language: ['jpn', 'swe', 'eng'],
        editions: {
          docs: [{ title: 'The Girl Who Played with Fire', language: ['eng'], isbn: ['9780307476159', '0307476154'] }],
        },
      },
      'openlibrary:author:Stieg Larsson',
    );

    expect(cand.editionTitle).toBe('The Girl Who Played with Fire');
    expect(cand.isbn).toBe('9780307476159');
    // An ASCII-only foreign title does not look non-English, so it stays.
    expect(cand.t).toBe('Flickan som lekte med elden');
  });

  it('shows the English edition title when the work title carries non-English letters', () => {
    const cand = fromOpenLibrary(
      {
        title: 'El amante japonés',
        author_name: ['Isabel Allende'],
        editions: { docs: [{ title: 'The Japanese lover', language: ['eng'], isbn: ['9781501116971'] }] },
      },
      'openlibrary:subject:Family Saga',
    );

    expect(cand.t).toBe('The Japanese lover');
    expect(cand.isbn).toBe('9781501116971');
  });

  it("keeps an English original's work title when the matched edition is named differently", () => {
    // Open Library matches a Spanish translation tagged as English to
    // "Anathem"; the work title is the name the reader knows.
    const cand = fromOpenLibrary(
      {
        title: 'Anathem',
        author_name: ['Neal Stephenson'],
        editions: { docs: [{ title: 'Anatema', language: ['eng'] }] },
      },
      'openlibrary:author:Neal Stephenson',
    );

    expect(cand.t).toBe('Anathem');
    expect(cand.editionTitle).toBe('Anatema');
  });

  it('ignores a matched edition that is not in English', () => {
    const cand = fromOpenLibrary(
      {
        title: 'Krew elfów',
        author_name: ['Andrzej Sapkowski'],
        isbn: ['9788375780635'],
        editions: { docs: [{ title: 'Krew elfów', language: ['pol'], isbn: ['9788375780635'] }] },
      },
      'openlibrary:author:Andrzej Sapkowski',
    );

    expect(cand.t).toBe('Krew elfów');
    expect(cand.editionTitle).toBeUndefined();
  });

  describe('author of a doc from an author query', () => {
    const karamazov = {
      title: 'Братья Карамазовы',
      author_name: ['Fiódor Dostoievski'],
      author_alternative_name: ['Fédor Dostoievski', 'Fyodor Dostoevsky', 'F. M. Dostoevsky'],
    };

    it("takes the read shelf's spelling when the catalog spells the queried author differently", () => {
      const cand = fromOpenLibrary(karamazov, 'openlibrary:author:Fyodor Dostoevsky', 'Fyodor Dostoevsky');
      expect(cand.a).toBe('Fyodor Dostoevsky');
    });

    it("keeps the catalog's author when no author was queried", () => {
      const cand = fromOpenLibrary(karamazov, 'openlibrary:subject:Russian');
      expect(cand.a).toBe('Fiódor Dostoievski');
    });

    it('keeps the first author of a work the queried author only contributed to', () => {
      const cand = fromOpenLibrary(
        {
          title: 'A Memory of Light',
          author_name: ['Robert Jordan', 'Brandon Sanderson'],
          author_alternative_name: ['Brandon Sanderson'],
        },
        'openlibrary:author:Brandon Sanderson',
        'Brandon Sanderson',
      );
      expect(cand.a).toBe('Robert Jordan');
    });

    it('keeps the catalog author when an alternative name matches but the surname does not', () => {
      // Open Library's record for Robert Bloch lists "Jim Kjelgaard" among his
      // alternative names.
      const cand = fromOpenLibrary(
        { title: 'Psycho', author_name: ['Robert Bloch'], author_alternative_name: ['Jim Kjelgaard', 'Robert A. Bloch'] },
        'openlibrary:author:Jim Kjelgaard',
        'Jim Kjelgaard',
      );
      expect(cand.a).toBe('Robert Bloch');
    });

    it('keeps the catalog author when the queried name is not among the alternative names', () => {
      const cand = fromOpenLibrary(
        { title: "I'm OK, you're OK", author_name: ['Thomas Anthony Harris'], author_alternative_name: ['Thomas A. Harris'] },
        'openlibrary:author:Thomas Harris',
        'Thomas Harris',
      );
      expect(cand.a).toBe('Thomas Anthony Harris');
    });
  });
});

describe('isByQueriedAuthor', () => {
  it('matches a first author whose name differs from the queried name only in accents and case', () => {
    expect(isByQueriedAuthor({ author_name: ['ÅSA LARSSON'] }, 'Åsa Larsson')).toBe(true);
    expect(isByQueriedAuthor({ author_name: ['Asa Larsson'] }, 'Åsa Larsson')).toBe(true);
  });

  it('rejects a single-author doc that has no alternative names and a different name', () => {
    expect(isByQueriedAuthor({ author_name: ['Dennis E. Taylor'] }, 'Dennis Taylor')).toBe(false);
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

describe('fromGoogleBooks descriptive text', () => {
  it('carries the description so the candidate embeds on more than its title', () => {
    const c = fromGoogleBooks(
      { title: 'Daemon', authors: ['Daniel Suarez'], description: 'A dying game designer unleashes a distributed program.' },
      'googlebooks:subject:thriller',
    );
    expect(c.firstSentence).toBe('A dying game designer unleashes a distributed program.');
  });

  it('leaves the field undefined when the volume has no description', () => {
    const c = fromGoogleBooks({ title: 'Daemon', authors: ['Daniel Suarez'] }, 'googlebooks:subject:thriller');
    expect(c.firstSentence).toBeUndefined();
  });
});
