// Tests for cmd-retrieve helpers. The end-to-end glue (search → filter →
// pick → download → deliver) is exercised manually during integration
// testing, since each underlying module already has thorough unit coverage.
// What's worth testing here is the deterministic mechanics: filter reasons,
// the composite quality score, and the indexed-pair ranker that fuses
// format preference + quality + source order.

import { describe, it, expect } from 'vitest';
import { rejectReason, qualityScore, rankIndexedCandidates } from './cmd-retrieve.mjs';

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
