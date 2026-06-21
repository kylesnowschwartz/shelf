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

/** Prefer a 13-digit ISBN from a list. */
export const pickIsbn13 = (isbns) => {
  if (!Array.isArray(isbns) || isbns.length === 0) return undefined;
  return isbns.find((x) => String(x).replace(/[^0-9Xx]/g, '').length === 13) || isbns[0];
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
