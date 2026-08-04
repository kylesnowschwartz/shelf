import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs sibling has no type declarations
import { passesQualityGate, broadenSubjects, isSelfPublished } from './cmd-fetch.mjs';
// @ts-expect-error — .mjs sibling has no type declarations
import { fromGoogleBooks } from './sources.mjs';

const noReadAuthors = new Set<string>();

describe('passesQualityGate', () => {
  it('keeps a candidate passing on edition_count alone', () => {
    const cand = { a: 'Some Author', editionCount: 5, ratingsCount: 0, wantToReadCount: 0 };
    expect(passesQualityGate(cand, noReadAuthors)).toBe(true);
  });

  it('keeps a candidate passing on want_to_read_count alone', () => {
    const cand = { a: 'Some Author', editionCount: 1, ratingsCount: 1, wantToReadCount: 30 };
    expect(passesQualityGate(cand, noReadAuthors)).toBe(true);
  });

  it('drops a candidate whose present signals are all below their floors', () => {
    const cand = { a: 'Some Author', editionCount: 1, ratingsCount: 2, wantToReadCount: 10 };
    expect(passesQualityGate(cand, noReadAuthors)).toBe(false);
  });

  it('keeps a candidate whose signals are all absent — missing data is not evidence of low quality', () => {
    const cand = { a: 'Some Author' };
    expect(passesQualityGate(cand, noReadAuthors)).toBe(true);
  });

  it('keeps a low-signal candidate whose author is already on the read shelf', () => {
    const cand = { a: 'Some Author', editionCount: 1, ratingsCount: 2, wantToReadCount: 10 };
    const readAuthors = new Set(['some author']);
    expect(passesQualityGate(cand, readAuthors)).toBe(true);
  });

  it('keeps a Google-sourced candidate carrying a vestigial rating count, since Google ratings are never mapped onto the gated fields', () => {
    // Regression guard: Google Books has deprecated user ratings, so where a
    // count survives at all it is a single digit — a "Misery" volume can
    // arrive with ratingsCount: 1. Mapped straight onto the shared
    // ratingsCount field, that reads as a present-but-below-floor signal and
    // the gate drops a Stephen King book. fromGoogleBooks leaves the gated
    // fields undefined, so this candidate is unproven, not disqualified.
    const cand = fromGoogleBooks(
      { title: 'Misery', authors: ['Stephen King'], ratingsCount: 1, averageRating: 4.5 },
      'googlebooks:subject:horror',
    );
    expect(passesQualityGate(cand, noReadAuthors)).toBe(true);
  });
});

describe('isSelfPublished', () => {
  it('drops a candidate whose publisher matches a self-publishing imprint, case-insensitively', () => {
    expect(isSelfPublished({ publisher: 'Independently published' })).toBe(true);
    expect(isSelfPublished({ publisher: 'CREATESPACE' })).toBe(true);
  });

  it('keeps a candidate whose publisher is absent — missing data is not evidence of self-publishing', () => {
    expect(isSelfPublished({})).toBe(false);
    expect(isSelfPublished({ publisher: undefined })).toBe(false);
  });

  it('keeps a candidate from a traditional publisher', () => {
    expect(isSelfPublished({ publisher: 'Tor Books' })).toBe(false);
  });
});

describe('broadenSubjects', () => {
  it('collapses narrow tags mapping to the same broad subject into one deduplicated entry', () => {
    const result = broadenSubjects(['Nordic Noir', 'Action Thriller']);
    expect(result).toEqual(['thriller', 'crime']);
  });

  it('passes an unmapped tag through unchanged', () => {
    const result = broadenSubjects(['Espionage']);
    expect(result).toEqual(['Espionage']);
  });
});
