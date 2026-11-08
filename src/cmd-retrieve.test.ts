// Tests for cmd-retrieve helpers. The end-to-end glue (search → filter →
// pick → download → deliver) is exercised manually during integration
// testing, since each underlying module already has thorough unit coverage.
// What's worth testing here is the deterministic mechanics: filter reasons,
// the composite quality score, and the indexed-pair ranker that fuses
// format preference + quality + source order.

import { describe, it, expect, vi } from 'vitest';
import { rejectReason, qualityScore, rankIndexedCandidates, normalizeTitle, mismatchReason, withSourceRetry, candidateHasIsbn, searchWithIsbnFallback } from './cmd-retrieve.mjs';
import { SourceError } from './retrieve/sources/zlib.mjs';

const cand = (overrides = {}) => ({
  sourceId: 'zlib:x',
  title: 'X',
  authors: ['A'],
  year: 2000,
  format: 'epub',
  sizeBytes: 1024 * 1024,
  language: 'english',
  rating: null,
  publisher: null,
  isbn: null,
  quality: null,
  cover: null,
  ...overrides,
});

describe('rejectReason', () => {
  it('passes a typical EPUB through with no filters', () => {
    expect(rejectReason(cand())).toBeNull();
  });

  it('rejects a format not in --ext', () => {
    expect(rejectReason(cand({ format: 'pdf' }), { extensions: ['epub', 'azw3'] })).toMatch(/format pdf/);
  });

  it('allows a candidate when --ext list is empty', () => {
    expect(rejectReason(cand({ format: 'pdf' }), { extensions: [] })).toBeNull();
  });

  it('rejects a non-English candidate when --english is set', () => {
    expect(rejectReason(cand({ language: 'russian' }), { english: true })).toMatch(/russian/i);
  });

  it('keeps an unknown-language candidate when --english is set (rather than dropping silently)', () => {
    expect(rejectReason(cand({ language: null }), { english: true })).toBeNull();
  });

  it('rejects an oversized file', () => {
    expect(rejectReason(cand({ sizeBytes: 60 * 1024 * 1024 }), { maxBytes: 50 * 1024 * 1024 })).toMatch(/exceeds/);
  });

  it('rejects a tiny file (likely a sample)', () => {
    expect(rejectReason(cand({ sizeBytes: 1024 }))).toMatch(/sample/);
  });

  it('reports the first applicable reason; order is extension > language > size', () => {
    const r = rejectReason(cand({ format: 'pdf', language: 'russian', sizeBytes: 99 * 1024 * 1024 }), {
      extensions: ['epub'],
      english: true,
      maxBytes: 50 * 1024 * 1024,
    });
    expect(r).toMatch(/format pdf/);
  });
});

describe('qualityScore', () => {
  it('returns 0 for a no-signal candidate', () => {
    expect(qualityScore(cand({ rating: null, quality: null, publisher: null, year: null }))).toBe(0);
  });

  it('weights rating most heavily (×1.5)', () => {
    expect(qualityScore(cand({ rating: 5, quality: null, publisher: null, year: null }))).toBeCloseTo(7.5);
    expect(qualityScore(cand({ rating: 4.5, quality: null, publisher: null, year: null }))).toBeCloseTo(6.75);
  });

  it('treats rating 0 as no signal (z-lib defaults unrated entries to 0)', () => {
    expect(qualityScore(cand({ rating: 0, publisher: 'Real', year: 2010 }))).toBeCloseTo(1 + 0.5); // publisher + year only
  });

  it('rewards a real publisher but penalizes a Telegram-handle publisher', () => {
    // year:null isolates the publisher signal from the year bonus.
    const real = qualityScore(cand({ publisher: 'Simon & Schuster', year: null }));
    const handle = qualityScore(cand({ publisher: '@mystery_books_ar', year: null }));
    const nope = qualityScore(cand({ publisher: null, year: null }));
    expect(real).toBe(1);
    expect(handle).toBe(0);
    expect(nope).toBe(0);
  });

  it('credits z-lib quality at half the rating weight', () => {
    // year:null + publisher:null isolate the quality signal.
    expect(qualityScore(cand({ rating: null, quality: 4, year: null, publisher: null }))).toBeCloseTo(2);
    expect(qualityScore(cand({ rating: null, quality: 0, year: null, publisher: null }))).toBe(0);
  });

  it('rejects garbage years (101, 1800, ::current+10)', () => {
    expect(qualityScore(cand({ year: 101 }))).toBe(0);
    expect(qualityScore(cand({ year: 1800 }))).toBe(0);
    expect(qualityScore(cand({ year: 9999 }))).toBe(0);
    expect(qualityScore(cand({ year: 2009 }))).toBeCloseTo(0.5);
  });

  it('composes signals additively (the Hatchet-style positive case)', () => {
    // S&S Books for Young Readers, 2009, rating 5.0, no z-lib quality
    const s = qualityScore(
      cand({ rating: 5, quality: 0, publisher: 'Simon & Schuster Books for Young Readers', year: 2009 }),
    );
    expect(s).toBeCloseTo(7.5 + 0 + 1 + 0.5); // 9
  });
});

describe('rankIndexedCandidates', () => {
  // Helper: wrap candidates with their source-list index, the way cmd-retrieve
  // does before sorting. This keeps tests honest about what callers pass in.
  const idx = (arr: any[]) => arr.map((c: any, i: number) => ({ c, i }));
  const order = (sorted: any[]) => sorted.map((x: any) => x.c.sourceId);

  it('prefers AZW3 over EPUB over MOBI over PDF (Kindle-first)', () => {
    const ranked = idx([
      cand({ format: 'pdf', sourceId: 'zlib:p' }),
      cand({ format: 'azw3', sourceId: 'zlib:a' }),
      cand({ format: 'epub', sourceId: 'zlib:e' }),
      cand({ format: 'mobi', sourceId: 'zlib:m' }),
    ]).sort(rankIndexedCandidates);
    expect(order(ranked)).toEqual(['zlib:a', 'zlib:e', 'zlib:m', 'zlib:p']);
  });

  it('within format, higher quality score wins over source order', () => {
    const ranked = idx([
      // Position 0: weak signals
      cand({ format: 'azw3', sourceId: 'zlib:weak', rating: null, publisher: null }),
      // Position 1: strong signals (real publisher + 5/5 rating)
      cand({ format: 'azw3', sourceId: 'zlib:strong', rating: 5, publisher: 'Simon & Schuster', year: 2009 }),
    ]).sort(rankIndexedCandidates);
    expect(order(ranked)).toEqual(['zlib:strong', 'zlib:weak']);
  });

  it('within format, tied quality falls back to source order (preserves source relevance)', () => {
    // Two no-signal AZW3s: source order decides — first in the search list wins.
    const ranked = idx([
      cand({ format: 'azw3', sourceId: 'zlib:first' }),
      cand({ format: 'azw3', sourceId: 'zlib:second' }),
      cand({ format: 'azw3', sourceId: 'zlib:third' }),
    ]).sort(rankIndexedCandidates);
    expect(order(ranked)).toEqual(['zlib:first', 'zlib:second', 'zlib:third']);
  });

  it('the Hatchet regression: 419KB rating-5 S&S beats a 80KB no-rating sample (size is not the tiebreaker)', () => {
    // The old "size asc" tiebreaker picked the sample; the new one promotes
    // the rich-metadata candidate via the quality score even though it's larger.
    const ranked = idx([
      // Source-position 0: smallest, no signals — the buggy old picker's winner.
      cand({
        format: 'azw3',
        sourceId: 'zlib:sample',
        sizeBytes: 80 * 1024,
        rating: 0,
        publisher: null,
        year: 2021,
      }),
      // Source-position 1: bigger, the real edition.
      cand({
        format: 'azw3',
        sourceId: 'zlib:real',
        sizeBytes: 419 * 1024,
        rating: 5,
        publisher: 'Simon & Schuster Books for Young Readers',
        year: 2009,
      }),
    ]).sort(rankIndexedCandidates);
    expect(order(ranked)).toEqual(['zlib:real', 'zlib:sample']);
  });

  it('treats unknown formats as worst (sorted after all known formats)', () => {
    const ranked = idx([
      cand({ format: 'djvu', sourceId: 'zlib:dj' }),
      cand({ format: 'azw3', sourceId: 'zlib:a' }),
      cand({ format: 'pdf', sourceId: 'zlib:p' }),
    ]).sort(rankIndexedCandidates);
    expect(order(ranked)).toEqual(['zlib:a', 'zlib:p', 'zlib:dj']);
  });
});

describe('normalizeTitle', () => {
  it('strips a numbered series prefix', () => {
    expect(normalizeTitle('Slough House 4: Spook Street')).toBe('spook street');
    expect(normalizeTitle("DCC-02. Carl's Doomsday Scenario")).toBe('carls doomsday scenario');
  });

  it('strips a trailing series parenthetical', () => {
    expect(normalizeTitle('London Rules (Slough House 5)')).toBe('london rules');
  });

  it('drops a leading article, case, and punctuation', () => {
    expect(normalizeTitle('The Secret Hours!')).toBe('secret hours');
  });

  it('drops a subtitle', () => {
    expect(normalizeTitle('Slow Horses: A Slough House Thriller')).toBe('slow horses');
  });
});

describe('mismatchReason', () => {
  const req = { title: 'Slow Horses', author: 'Mick Herron' };

  it('rejects a different book by the same author', () => {
    expect(mismatchReason(cand({ title: 'The Secret Hours', authors: ['Mick Herron'] }), req)).toMatch(/title/);
  });

  it('accepts the requested book', () => {
    expect(mismatchReason(cand({ title: 'Slow Horses', authors: ['Mick Herron'] }), req)).toBeNull();
  });

  it('matches a series-prefixed title', () => {
    const c = cand({ title: 'Slough House 4: Spook Street', authors: ['Mick Herron'] });
    expect(mismatchReason(c, { title: 'Spook Street', author: 'Mick Herron' })).toBeNull();
  });

  it('matches a title with a trailing series parenthetical', () => {
    const c = cand({ title: 'London Rules (Slough House 5)', authors: ['Herron, Mick'] });
    expect(mismatchReason(c, { title: 'London Rules', author: 'Mick Herron' })).toBeNull();
  });

  it('rejects an author mismatch', () => {
    const c = cand({ title: 'Slow Horses', authors: ['Someone Else'] });
    expect(mismatchReason(c, req)).toMatch(/author/);
  });

  it('passes on title alone when the candidate has no author data', () => {
    expect(mismatchReason(cand({ title: 'Slow Horses', authors: [] }), req)).toBeNull();
  });
});


describe('withSourceRetry', () => {
  const unavailable = () => new SourceError('SOURCE_UNAVAILABLE', 'source temporarily unavailable; retry later');
  const noSleep = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  it('retries SOURCE_UNAVAILABLE and returns the first success', async () => {
    const { waits, sleep } = noSleep();
    const call = vi.fn().mockRejectedValueOnce(unavailable()).mockResolvedValueOnce({ candidates: [] });
    await expect(withSourceRetry(call, { delaysMs: [2000, 5000], sleep })).resolves.toEqual({ candidates: [] });
    expect(call).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2000]);
  });

  it('gives up after the retry limit and rethrows the last error', async () => {
    const { waits, sleep } = noSleep();
    const last = unavailable();
    const call = vi.fn().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(last);
    await expect(withSourceRetry(call, { delaysMs: [2000, 5000], sleep })).rejects.toBe(last);
    expect(call).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 5000]);
  });

  it('does not retry an auth error', async () => {
    const { waits, sleep } = noSleep();
    const call = vi.fn().mockRejectedValue(new SourceError('SOURCE_AUTH_REQUIRED', 'login needed'));
    await expect(withSourceRetry(call, { sleep })).rejects.toMatchObject({ code: 'SOURCE_AUTH_REQUIRED' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('does not retry a no-data error', async () => {
    const { sleep } = noSleep();
    const call = vi.fn().mockRejectedValue(new SourceError('SOURCE_NOT_FOUND', 'gone'));
    await expect(withSourceRetry(call, { sleep })).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(call).toHaveBeenCalledTimes(1);
  });
});


describe('candidateHasIsbn', () => {
  it('matches across hyphens and within a comma-separated isbn list', () => {
    expect(candidateHasIsbn(cand({ isbn: '1616952261, 978-1-61695-226-6' }), '9781616952266')).toBe(true);
  });

  it('does not match a different edition or a missing isbn', () => {
    expect(candidateHasIsbn(cand({ isbn: '9781616952266' }), '9781616952259')).toBe(false);
    expect(candidateHasIsbn(cand({ isbn: null }), '9781616952259')).toBe(false);
  });
});

describe('searchWithIsbnFallback', () => {
  /** A source stub that answers each search with `answer(query)` and records the queries. */
  function stubSource(answer: (q: any) => any[]) {
    const queries: any[] = [];
    const search = async (q: any) => {
      queries.push(q);
      return { candidates: answer(q), page: 1, totalPages: 1 };
    };
    return { queries, source: { search } };
  }

  it('keeps the isbn search when a candidate carries the requested isbn', async () => {
    const { queries, source } = stubSource(() => [cand({ isbn: '9781616952259' })]);
    const lookup = async () => {
      throw new Error('should not be called');
    };
    const found = await searchWithIsbnFallback(source, { isbn: '9781616952259' }, { lookup });
    expect(found.matchedBy).toBe('isbn');
    expect(queries).toHaveLength(1);
  });

  it('resolves the isbn via the lookup and searches by title when only other editions come back', async () => {
    const ebook = cand({ sourceId: 'zlib:ebook', isbn: '9781616952266' });
    const { queries, source } = stubSource((q) => (q.isbn ? [] : [ebook]));
    const lookup = async (isbn: string) => {
      expect(isbn).toBe('9781616952259');
      return { title: 'Dead Lions', author: 'Mick Herron' };
    };
    const found = await searchWithIsbnFallback(source, { isbn: '9781616952259', extensions: ['epub'] }, { lookup });
    expect(found.matchedBy).toBe('title');
    expect(found.result.candidates).toEqual([ebook]);
    expect(queries[1]).toEqual({ title: 'Dead Lions', author: 'Mick Herron', extensions: ['epub'] });
  });

  it('falls back when the isbn search returns candidates without the requested isbn', async () => {
    const { queries, source } = stubSource((q) => (q.isbn ? [cand({ isbn: '9780000000000' })] : [cand()]));
    const found = await searchWithIsbnFallback(source, { isbn: '9781616952259' }, {
      lookup: async () => ({ title: 'Dead Lions', author: 'Mick Herron' }),
    });
    expect(found.matchedBy).toBe('title');
    expect(queries).toHaveLength(2);
  });

  it('uses the caller title and author instead of the lookup when both are given', async () => {
    const { queries, source } = stubSource((q) => (q.isbn ? [] : [cand()]));
    const lookup = async () => {
      throw new Error('should not be called');
    };
    const found = await searchWithIsbnFallback(source, { isbn: '9781616952259', title: 'Dead Lions', author: 'Mick Herron' }, { lookup });
    expect(found.matchedBy).toBe('title');
    expect(queries[1]).toMatchObject({ title: 'Dead Lions', author: 'Mick Herron' });
  });

  it('reports unresolved when the lookup has no record for the isbn', async () => {
    const { queries, source } = stubSource(() => []);
    const found = await searchWithIsbnFallback(source, { isbn: '9781616952259' }, { lookup: async () => null });
    expect(found.unresolved).toMatch(/Open Library has no title/);
    expect(queries).toHaveLength(1);
  });

  it('reports unresolved when the lookup fails', async () => {
    const { source } = stubSource(() => []);
    const found = await searchWithIsbnFallback(source, { isbn: '9781616952259' }, {
      lookup: async () => {
        throw new Error('openlibrary.org 503 after 3 retries');
      },
    });
    expect(found.unresolved).toMatch(/lookup for it failed \(openlibrary.org 503/);
  });

  it('searches by title with matchedBy "title" when no isbn is given', async () => {
    const { queries, source } = stubSource(() => [cand()]);
    const found = await searchWithIsbnFallback(source, { title: 'Dead Lions', author: 'Mick Herron' });
    expect(found.matchedBy).toBe('title');
    expect(queries).toEqual([{ title: 'Dead Lions', author: 'Mick Herron', extensions: undefined }]);
  });
});
