import { describe, it, expect } from 'vitest';
import { isJuvenile, hasForeignSubjectTag, looksNonEnglish } from './util.mjs';

describe('isJuvenile', () => {
  it('flags catalog juvenile tags', () => {
    expect(isJuvenile(['Fiction', "Nonsexist children's literature", 'Teenage hunters'])).toBe(true);
    expect(isJuvenile(['Juvenile fiction', 'Survival'])).toBe(true);
    expect(isJuvenile(['Children: Grades 4-6'])).toBe(true);
  });
  it('leaves adult fiction alone', () => {
    expect(isJuvenile(['Fiction', 'Westerns', 'Frontier and pioneer life'])).toBe(false);
    expect(isJuvenile([])).toBe(false);
    expect(isJuvenile(undefined)).toBe(false);
  });
});

describe('hasForeignSubjectTag', () => {
  it('catches a non-English literature class', () => {
    expect(hasForeignSubjectTag(['Fantasy', 'Polish Fantasy fiction', 'Assassins'])).toBe(true);
    expect(hasForeignSubjectTag(['Translations into French'])).toBe(true);
  });
  it('does not flag English / topical tags', () => {
    expect(hasForeignSubjectTag(['Fiction, fantasy, general', 'English fiction'])).toBe(false);
    expect(hasForeignSubjectTag(['Poland -- History', 'World War, 1939-1945'])).toBe(false);
  });
});

describe('looksNonEnglish', () => {
  it('flags a Latin-script title with a diacritic', () => {
    expect(looksNonEnglish('Krew elfów', [])).toBe(true);
  });
  it('flags via the subject tag even with a clean title', () => {
    expect(looksNonEnglish('Blood of Elves', ['Polish Fantasy fiction'])).toBe(true);
  });
  it('passes ordinary English titles', () => {
    expect(looksNonEnglish('The North Water', ['Historical fiction', 'Adventure'])).toBe(false);
    expect(looksNonEnglish('Born to Run', [])).toBe(false);
  });
});
