import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs sibling has no type declarations
import { passesQualityGate, broadenSubjects, isSelfPublished, isCollectedEdition, isAlreadyRead } from './cmd-fetch.mjs';
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

describe('isCollectedEdition', () => {
  it('drops a bundle record that names no single book', () => {
    expect(isCollectedEdition({ t: "Works (Carrie / Night Shift / 'Salem's Lot)" })).toBe(true);
    expect(isCollectedEdition({ t: 'Complete Works' })).toBe(true);
  });

  it('keeps a real book whose title merely carries a parenthetical', () => {
    expect(isCollectedEdition({ t: 'A Wind in the Door (Time Quintet #2)' })).toBe(false);
    expect(isCollectedEdition({ t: 'The Works of Love' })).toBe(false);
  });
});

describe('isAlreadyRead', () => {
  // dedupKey('The Girl Who Played with Fire', 'Stieg Larsson')
  const readKeys = new Set(['girlwhoplayedwithfire|larsson']);
  const readIsbns = new Set(['9780307476159']);
  const swedishWork = { t: 'Flickan som lekte med elden', a: 'Stieg Larsson' };

  it('matches a translated work through its English edition title', () => {
    expect(isAlreadyRead({ ...swedishWork, editionTitle: 'The Girl Who Played with Fire' }, readKeys, new Set())).toBe(true);
  });

  it('matches a translated work through its English edition ISBN', () => {
    expect(isAlreadyRead({ ...swedishWork, isbn: '9780307476159' }, new Set(), readIsbns)).toBe(true);
  });

  it('matches on the candidate title alone', () => {
    expect(isAlreadyRead({ t: 'The Girl Who Played with Fire', a: 'Stieg Larsson' }, readKeys, new Set())).toBe(true);
  });

  it('keeps a candidate that matches the read shelf on nothing', () => {
    expect(isAlreadyRead({ ...swedishWork, editionTitle: 'Some Other Book', isbn: '9780000000000' }, readKeys, readIsbns)).toBe(false);
  });
});
