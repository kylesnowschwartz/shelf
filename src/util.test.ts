import { describe, it, expect } from 'vitest';
import { isJuvenile, hasForeignSubjectTag, looksNonEnglish, cleanTitle, dedupKey, displayTitle } from './util.mjs';

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

describe('cleanTitle', () => {
  it('strips a closed series qualifier', () => {
    expect(cleanTitle('A Wind in the Door (Time Quintet #2)')).toBe('A Wind in the Door');
  });

  it('strips a qualifier the catalog never closed', () => {
    expect(cleanTitle('A Wind in the Door (Time Quintet #2')).toBe('A Wind in the Door');
    expect(cleanTitle('Gai-Jin (Asian Saga')).toBe('Gai-Jin');
  });
});

describe('dedupKey', () => {
  it('matches a read book against a candidate whose series note is unclosed', () => {
    expect(dedupKey('A Wind in the Door (Time Quintet #2', "Madeleine L'Engle")).toBe(
      dedupKey('A Wind in the Door', "Madeleine L'Engle"),
    );
  });
});

describe('displayTitle', () => {
  it('keeps a closed series qualifier the reader benefits from', () => {
    expect(displayTitle('A Wind in the Door (Time Quintet #2)')).toBe('A Wind in the Door (Time Quintet #2)');
  });

  it('drops a parenthetical the catalog left unterminated', () => {
    expect(displayTitle('Gai-Jin (Asian Saga')).toBe('Gai-Jin');
  });
});
