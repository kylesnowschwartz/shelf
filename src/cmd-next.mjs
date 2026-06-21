// `shelf next` — THE PRODUCT. Rank unread candidates into a short, trustworthy
// shortlist and emit it as structured JSON for the agent to explain.
//
// Two modes:
//   • dials (default): relevance = artifact baseScore, reweighted by --mood /
//     --novelty, calibrated to the reader's genre mix.
//   • seed (--like a,b,c): relevance = cosine to an ad-hoc centroid of the named
//     read books; calibration off (the reader asked for "more like these").
//
// A relevance floor (top WORKING by baseScore) is applied BEFORE the dials so a
// mood/novelty request can never dredge up off-taste noise from the pool's tail.
// Hard filters (--max-pages, --era) exclude, but anything high-relevance they
// drop is reported in `omitted` so the agent can offer it back. No prose here.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { BOOKS_JSON, RECOMMENDATIONS_JSON } from './paths.mjs';
import { log, emit, fail, EXIT, color } from './output.mjs';
import { loadVectors, readKey, candKey } from './cache.mjs';
import { cosine, meanVector, applyDials, mmrSelect, genreHistogram } from './recommend.ts';
import { GENRES } from './genres.mjs';

const WORKING = 60; // relevance-floor working-set size before dials + MMR

// Seeded re-roll: a tiny deterministic jitter (±~0.015) keyed on id+seed,
// added to relevance before ranking. Same seed → identical list (determinism
// preserved); a different seed reshuffles near-ties so the reader can ask for
// "another five" without the engine going random. Magnitude is small enough
// that a clearly stronger pick never loses to a weaker one.
const JITTER = 0.015;
function seededJitter(id, seed) {
  let h = 2166136261 ^ seed;
  const s = `${id}:${seed}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) / 4294967295) * 2 - 1) * JITTER;
}

function parseEra(era) {
  if (!era) return null;
  const m = String(era).match(/^(\d{4})?\s*-\s*(\d{4})?$/);
  if (m) return { from: m[1] ? Number(m[1]) : -Infinity, to: m[2] ? Number(m[2]) : Infinity };
  if (/^\d{4}$/.test(era)) return { from: Number(era), to: Number(era) };
  return null;
}

export async function run(opts) {
  if (!existsSync(RECOMMENDATIONS_JSON)) fail(EXIT.NOT_BUILT, 'no recommendations.json — run `shelf build` first');
  const recs = JSON.parse(await readFile(RECOMMENDATIONS_JSON, 'utf8'));
  const books = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));
  const vectors = await loadVectors();
  const count = Math.max(1, Number(opts.count) || 5);

  const seedMode = !!opts.like;
  const seed = Number(opts.seed) || 1;
  const dials = { mood: opts.mood, novelty: opts.novelty };
  if (opts.mood && !['dark', 'comforting'].includes(opts.mood)) fail(EXIT.USAGE, `--mood must be dark|comforting, got "${opts.mood}"`);
  if (opts.novelty && !['familiar', 'adventurous'].includes(opts.novelty)) fail(EXIT.USAGE, `--novelty must be familiar|adventurous, got "${opts.novelty}"`);

  // Relevance per candidate.
  let scored;
  let seedTitles = [];
  if (seedMode) {
    const ids = String(opts.like).split(',').map((s) => s.trim()).filter(Boolean);
    const seedVecs = ids.map((id) => vectors[readKey(id)]?.vec).filter(Boolean);
    if (seedVecs.length === 0) fail(EXIT.USAGE, `--like: none of [${ids.join(', ')}] match a read-book id (see books.json ids)`);
    seedTitles = ids.map((id) => books.find((b) => b.id === id)?.t).filter(Boolean);
    const centroid = meanVector(seedVecs);
    scored = recs.map((r) => {
      const v = vectors[candKey(r.id)]?.vec;
      const relevance = v ? cosine(v, centroid) : r.baseScore;
      return { ...r, relevance };
    });
  } else {
    scored = recs.map((r) => ({ ...r, relevance: r.baseScore }));
  }

  // Intent filters (genre / audience / language). Applied BEFORE the relevance
  // floor on purpose: genre correlates with relevance — the reader's dominant
  // genre fills the top of the ranking — so filtering AFTER a top-WORKING slice
  // would starve a "less SFF" request of survivors. These are exclusions the
  // reader explicitly asked for, so they're filtered silently (not surfaced in
  // `omitted`, unlike the near-miss page/era constraints worth offering back).
  const VALID_GENRES = GENRES;
  const parseGenres = (val, flag) => {
    if (!val) return null;
    const out = String(val).split(',').map((s) => s.trim()).filter(Boolean).map((g) => {
      const hit = VALID_GENRES.find((v) => v.toLowerCase() === g.toLowerCase());
      if (!hit) fail(EXIT.USAGE, `${flag}: "${g}" is not a genre (${VALID_GENRES.join('|')})`);
      return hit;
    });
    return new Set(out);
  };
  const genreInclude = parseGenres(opts.genre, '--genre');
  const genreExclude = parseGenres(opts.notGenre, '--not-genre');
  const intentFilterActive = !!(genreInclude || genreExclude || opts.adult || opts.english);
  const prefilter = { genre: 0, juvenile: 0, nonEnglish: 0 };
  if (intentFilterActive) {
    scored = scored.filter((r) => {
      if (genreInclude && !genreInclude.has(r.genre)) return (prefilter.genre++, false);
      if (genreExclude && genreExclude.has(r.genre)) return (prefilter.genre++, false);
      if (opts.adult && r.audience === 'juvenile') return (prefilter.juvenile++, false);
      if (opts.english && r.langGuess === 'non-en') return (prefilter.nonEnglish++, false);
      return true;
    });
    if (scored.length === 0) fail(EXIT.NO_DATA, 'every candidate was filtered out by --genre/--not-genre/--adult/--english — loosen them');
  }

  // Relevance floor: keep the most relevant WORKING items, THEN reweight.
  scored.sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
  const floorPool = scored.slice(0, WORKING);

  // Hard filters. Track high-relevance casualties for honest omission.
  const maxPages = opts.maxPages ? Number(opts.maxPages) : null;
  const era = parseEra(opts.era);
  if (opts.era && !era) fail(EXIT.USAGE, `--era must look like 2000- or -1980 or 1990-2010, got "${opts.era}"`);
  const omitted = [];
  const passes = (r) => {
    if (era && (r.year == null || r.year < era.from || r.year > era.to)) return reject(r, `outside era ${opts.era}`);
    if (maxPages != null) {
      if (r.pages == null) return opts.strict ? reject(r, 'unknown length') : true;
      if (r.pages > maxPages) return reject(r, `${r.pages}pp > ${maxPages}pp`);
    }
    return true;
  };
  function reject(r, reason) {
    omitted.push({ id: r.id, t: r.t, a: r.a, reason, baseScore: r.baseScore });
    return false;
  }
  const pool = floorPool.filter(passes);
  if (pool.length === 0) fail(EXIT.NO_DATA, 'every candidate was filtered out — loosen --max-pages/--era');

  // Genre-mix calibration nudges results back toward the reader's shelf
  // histogram — good for an open-ended "what next?", but it fights the reader
  // when they're explicitly steering genre. Off in seed mode (they asked for
  // "more like these") and off whenever an intent filter is active (they asked
  // to leave a genre behind; don't drag them back to it).
  const calibrate = !seedMode && !intentFilterActive;
  const target = genreHistogram(books.map((b) => b.g));
  const items = pool.map((r) => ({
    id: r.id,
    genre: r.genre,
    relevance: applyDials({ relevance: r.relevance, darkness: r.darkness, novelty: r.novelty }, dials) + seededJitter(r.id, seed),
    vec: vectors[candKey(r.id)]?.vec,
  }));
  const picked = mmrSelect(items, count, {
    lambda: 0.6, // diversification factor ≈ 0.4 (book-domain sweet spot)
    lambdaCal: calibrate ? 0.3 : 0,
    target: calibrate ? target : {},
    sim: (a, b) => (a.vec && b.vec ? cosine(a.vec, b.vec) : 0),
  });

  const byId = new Map(pool.map((r) => [r.id, r]));
  const round = (x) => Math.round(x * 1000) / 1000;
  const recommendations = picked.map((p) => {
    const r = byId.get(p.id);
    return {
      id: r.id,
      title: r.t,
      author: r.a,
      year: r.year ?? null,
      pages: r.pages ?? null,
      isbn: r.isbn ?? null,
      genre: r.genre,
      score: round(p.relevance),
      baseScore: r.baseScore,
      nearestReadId: r.nearestReadId,
      nearestReadTitle: r.nearestReadTitle,
      darkness: r.darkness,
      novelty: r.novelty,
      audience: r.audience ?? 'general',
      langGuess: r.langGuess ?? 'en',
      subjects: r.subjects,
    };
  });

  const result = {
    mode: seedMode ? 'seed' : 'dials',
    ...(seedMode ? { seed: seedTitles } : {}),
    dials: { mood: opts.mood ?? null, novelty: opts.novelty ?? null, maxPages, era: opts.era ?? null },
    filters: {
      genre: genreInclude ? [...genreInclude] : null,
      notGenre: genreExclude ? [...genreExclude] : null,
      adult: !!opts.adult,
      english: !!opts.english,
    },
    prefiltered: prefilter, // counts silently dropped by the intent filters above
    count: recommendations.length,
    calibratedToGenreMix: calibrate,
    recommendations,
    omittedTotal: omitted.length, // total filtered by hard constraints…
    omitted: omitted.sort((a, b) => b.baseScore - a.baseScore).slice(0, 5), // …of which these are the highest-relevance, shown so the agent can offer them back
    spread: { genres: [...new Set(recommendations.map((r) => r.genre))], distinctGenres: new Set(recommendations.map((r) => r.genre)).size },
  };

  emit(result, opts, renderHuman);
}

function bar(score) {
  const n = Math.max(0, Math.min(9, Math.round(score * 9)));
  return '█'.repeat(n) + '░'.repeat(9 - n);
}

function renderHuman(d, plain) {
  if (plain) return d.recommendations.map((r) => `${r.title}\t${r.author}\t${r.year ?? ''}\t${r.genre}\t${r.score}`).join('\n');
  const lines = [];
  const dl = d.dials;
  const f = d.filters || {};
  const fbits = [
    f.genre ? `genre=${f.genre.join(',')}` : null,
    f.notGenre ? `not-genre=${f.notGenre.join(',')}` : null,
    f.adult ? 'adult' : null,
    f.english ? 'english' : null,
  ].filter(Boolean);
  lines.push(color.bold(`shelf next`) + color.dim(`  mode=${d.mode}  mood=${dl.mood ?? '·'}  novelty=${dl.novelty ?? '·'}  max-pages=${dl.maxPages ?? '·'}  era=${dl.era ?? '·'}${fbits.length ? '  ' + fbits.join('  ') : ''}`));
  if (d.mode === 'seed') lines.push(color.dim(`  seed: ${d.seed.join(', ')}`));
  lines.push('');
  d.recommendations.forEach((r, i) => {
    const tags = [r.audience === 'juvenile' ? 'YA' : null, r.langGuess === 'non-en' ? 'non-en?' : null].filter(Boolean);
    const tagStr = tags.length ? ` ${color.dim(`[${tags.join(' ')}]`)}` : '';
    lines.push(`  ${String(i + 1).padStart(2)}. ${color.bold(r.title)} — ${r.author}  ${color.dim(`${r.year ?? '????'} · ${r.pages ?? '?'}pp · ${r.genre}`)}${tagStr}  ${color.accent(bar(r.score))} ${r.score.toFixed(2)}`);
    lines.push(color.dim(`      ↳ near your read of ${r.nearestReadTitle}`));
  });
  if (d.omitted.length) {
    lines.push('');
    const more = d.omittedTotal > d.omitted.length ? ` (+${d.omittedTotal - d.omitted.length} more filtered)` : '';
    lines.push(color.dim(`  omitted — top ${d.omitted.length} of ${d.omittedTotal} filtered${more}: ` + d.omitted.map((o) => `${o.t} (${o.reason})`).join('; ')));
  }
  const pf = d.prefiltered || {};
  const pfTotal = (pf.genre || 0) + (pf.juvenile || 0) + (pf.nonEnglish || 0);
  if (pfTotal) {
    const bits = [pf.genre ? `${pf.genre} off-genre` : null, pf.juvenile ? `${pf.juvenile} YA` : null, pf.nonEnglish ? `${pf.nonEnglish} non-en` : null].filter(Boolean);
    lines.push('');
    lines.push(color.dim(`  intent filters dropped ${pfTotal} (${bits.join(', ')})`));
  }
  lines.push('');
  const why = d.mode === 'seed' ? ' · calibration off (seed mode)' : d.calibratedToGenreMix ? ' · calibrated to your shelf mix' : ' · calibration off (genre steer)';
  lines.push(color.dim(`  spread: ${d.count} picks across ${d.spread.distinctGenres} genre(s)${why}`));
  return lines.join('\n');
}
