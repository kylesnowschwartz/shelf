// Small pure string helpers shared across shelf commands. Deterministic — no
// I/O, no randomness — so the whole pipeline gives stable output for an agent.

/** Strip "(Thrawn 1)"-style qualifiers. */
export const cleanTitle = (t) => t.replace(/\([^)]*\)/g, '').trim();

/** First listed author, for matching ("A & B" / "A, B" → "A"). */
export const primaryAuthor = (a) => a.split(/ & |, | and /i)[0].trim();

/** Surname-ish last token, lowercased. */
export const surname = (a) => {
  const parts = primaryAuthor(a).split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
};

/** URL/id-safe slug. */
export const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * Dedup key: normalized title (articles + punctuation + subtitle dropped) plus
 * author surname. Two editions of the same book collapse to one key.
 */
export const dedupKey = (title, author) => {
  const t = cleanTitle(title)
    .toLowerCase()
    .replace(/[:–—-].*$/, '') // drop subtitle after a colon/dash
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]/g, ''); // strip ALL non-alphanumerics incl. spaces, so
  // "Hitch Hiker's" and "Hitchhiker's" collapse to the same key
  return `${t}|${surname(author)}`;
};

// Catalogs disagree on which language code list they publish: Open Library
// emits three-letter codes ("eng"), Google Books two-letter ones ("en"). A
// candidate carries the three-letter form whatever produced it, so one
// language test serves every source.
const TWO_TO_THREE_LETTER_LANGUAGE = {
  en: 'eng',
  fr: 'fre',
  de: 'ger',
  es: 'spa',
  it: 'ita',
  pt: 'por',
  nl: 'dut',
  sv: 'swe',
  no: 'nor',
  da: 'dan',
  fi: 'fin',
  is: 'ice',
  pl: 'pol',
  ru: 'rus',
  ja: 'jpn',
  zh: 'chi',
  ko: 'kor',
};

/** A language code in the three-letter form; an unrecognized code is passed through. */
export const threeLetterLanguage = (code) => {
  if (typeof code !== 'string') return undefined;
  const lower = code.trim().toLowerCase();
  return TWO_TO_THREE_LETTER_LANGUAGE[lower] || lower;
};

/** Prefer a 13-digit ISBN from a list. */
export const pickIsbn13 = (isbns) => {
  if (!Array.isArray(isbns) || isbns.length === 0) return undefined;
  return isbns.find((x) => String(x).replace(/[^0-9Xx]/g, '').length === 13) || isbns[0];
};

/**
 * An ISBN's registration group encodes the publisher's language/territory —
 * group 0 and group 1 (the digit right after the 978 EAN prefix on a 13-digit
 * ISBN, or the leading digit on a 10-digit one) are reserved for the English-
 * language area. A work's aggregated `isbn` list mixes every translation's
 * ISBNs together, so this is what tells an English edition's ISBN apart from
 * e.g. a Korean or French one without a language/country lookup table.
 */
const isEnglishIsbn = (digits) =>
  (digits.length === 13 && (digits.startsWith('9780') || digits.startsWith('9781'))) ||
  (digits.length === 10 && (digits[0] === '0' || digits[0] === '1'));

/**
 * Prefer a 13-digit English-edition ISBN from a work's aggregated ISBN list,
 * falling back to a 10-digit English one. Returns undefined rather than an
 * arbitrary (possibly foreign-language) ISBN when no English one is present.
 */
export const pickEnglishIsbn13 = (isbns) => {
  if (!Array.isArray(isbns) || isbns.length === 0) return undefined;
  const digitsOf = (x) => String(x).replace(/[^0-9Xx]/g, '');
  const english13 = isbns.map(digitsOf).find((d) => d.length === 13 && isEnglishIsbn(d));
  if (english13) return english13;
  return isbns.map(digitsOf).find((d) => d.length === 10 && isEnglishIsbn(d));
};

/** Fraction of letters that are plain ASCII — a cheap non-English-script guard. */
export const asciiRatio = (s) => {
  const letters = (s.match(/[\p{L}]/gu) || []).length;
  if (letters === 0) return 1;
  const ascii = (s.match(/[A-Za-z]/g) || []).length;
  return ascii / letters;
};

/** Plausible first-publish year (Open Library's is crowd-sourced and noisy). */
export const plausibleYear = (y, thisYear) =>
  typeof y === 'number' && y >= 1700 && y <= thisYear + 1 && y !== 1900;

/**
 * Catalog juvenile/children markers (Open Library subject tags). Used both to
 * drop kids' books from unread authors at fetch time and to FLAG audience in
 * the build artifact, so the agent can see "this is YA" without re-reading the
 * raw subject list every recommendation.
 */
export const JUVENILE_RE = /juvenile|children'?s|picture book|early reader|chapter book|board book|grades? \d/i;
export const isJuvenile = (subjects = []) => (subjects || []).some((s) => JUVENILE_RE.test(s));

// Non-English language adjectives that show up in Open Library "X fiction /
// literature / poetry" or "Translations into X" subject classes. English is
// deliberately absent — "English fiction" / "American fiction" are English.
const FOREIGN_LANGS =
  'polish|french|german|italian|spanish|russian|japanese|chinese|dutch|swedish|norwegian|danish|portuguese|czech|hungarian|finnish|greek|turkish|korean|arabic|hebrew|romanian|ukrainian|catalan';
const FOREIGN_SUBJECT_RE = new RegExp(
  `\\b(?:${FOREIGN_LANGS})\\b[^,]*\\b(?:fiction|literature|poetry)\\b|translations into (?:${FOREIGN_LANGS})`,
  'i',
);

/** A subject tag classes the work in a non-English literature — a strong edition-language signal. */
export const hasForeignSubjectTag = (subjects = []) => (subjects || []).some((s) => FOREIGN_SUBJECT_RE.test(s));

/**
 * Heuristic non-English guess for FLAGGING (not hard dropping): a Latin-script
 * title with even one diacritic ("Krew elfów") rates < 0.95 ASCII, and a
 * foreign literature subject tag is a second signal. Conservative on purpose —
 * a stray false positive is recoverable because the agent curates; fetch's
 * stricter `isEnglish` guard is what actually drops editions.
 */
export const looksNonEnglish = (title = '', subjects = []) =>
  asciiRatio(title) < 0.95 || hasForeignSubjectTag(subjects);
