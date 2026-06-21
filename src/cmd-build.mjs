// `shelf build` — assemble the recommendation artifact from embedded vectors.
//
// For each unread candidate it computes the content-based signals the ranker
// needs, and the provenance the agent needs to explain itself:
//   • genre        — inferred from the nearest read-shelf centroid
//   • baseScore    — cosine to that nearest centroid (content relevance)
//   • nearestRead  — the specific read book it sits closest to ("near your X")
//   • darkness     — projection onto a dark↔comforting axis (mood dial)
//   • novelty      — distance from everything already read (novelty dial)
//
// Output is a flat, human-auditable array (THE quality gate: eyeball the top).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BOOKS_JSON, CACHE, CANDIDATES_JSON, RECOMMENDATIONS_JSON } from './paths.mjs';
import { log, emit, fail, EXIT, color } from './output.mjs';
import { loadVectors, readKey, candKey } from './cache.mjs';
import { embedText } from './embed-model.mjs';
import { isJuvenile, looksNonEnglish } from './util.mjs';
import { centroidsByGenre, nearestCentroid, cosine, meanVector, normalize } from './recommend.ts';

// Mood axis anchors. The axis is dark-anchor-centroid minus comforting-anchor-
// centroid; a candidate's darkness is its projection onto it. Defined here (not
// from tags) so it is meaningful even for candidates with sparse subjects.
const DARK_ANCHORS = [
  'grimdark, brutal and bleak, violence and despair, morally grey, no heroes',
  'horror, dread and terror, death, disturbing and nightmarish',
  'tragedy, war atrocity, cruelty, grief and darkness',
];
const COZY_ANCHORS = [
  'cozy and comforting, warm and gentle, low stakes, hopeful and heartwarming',
  'lighthearted and funny, whimsical and charming, feel-good',
  'tea and friendship, quiet and uplifting, a soothing read',
];

const minmax = (xs) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const span = hi - lo || 1;
  return xs.map((x) => (x - lo) / span);
};
const round = (x, p = 4) => Math.round(x * 10 ** p) / 10 ** p;

export async function run(opts) {
  const books = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));
  const candidates = JSON.parse(await readFile(CANDIDATES_JSON, 'utf8'));
  const vectors = await loadVectors();

  const readVec = (id) => vectors[readKey(id)]?.vec;
  const candVec = (id) => vectors[candKey(id)]?.vec;

  // Read shelf → per-genre taste centroids.
  const readItems = books.filter((b) => readVec(b.id)).map((b) => ({ id: b.id, t: b.t, genre: b.g, vec: readVec(b.id) }));
  if (readItems.length === 0) fail(EXIT.NOT_BUILT, 'no read-book vectors — run `shelf embed` first');
  const centroids = centroidsByGenre(readItems);

  // Mood axis from anchor embeddings (built fresh; cheap — 6 short strings).
  log(color.bold('shelf build') + ` — ${readItems.length} read centroids, ${candidates.length} candidates`);
  const darkC = meanVector(await Promise.all(DARK_ANCHORS.map(embedText)));
  const cozyC = meanVector(await Promise.all(COZY_ANCHORS.map(embedText)));
  const darkAxis = normalize(darkC.map((x, i) => x - cozyC[i]));

  // First pass: raw signals per candidate.
  const raw = [];
  for (const c of candidates) {
    const vec = candVec(c.id);
    if (!vec) continue; // not embedded (shouldn't happen after `embed`)
    const near = nearestCentroid(vec, centroids);
    let best = { id: '', t: '', genre: '', score: -Infinity };
    for (const r of readItems) {
      const s = cosine(vec, r.vec);
      if (s > best.score) best = { id: r.id, t: r.t, genre: r.genre, score: s };
    }
    raw.push({ c, vec, genre: near.genre, baseScore: near.score, nearest: best, darkRaw: cosine(vec, darkAxis), noveltyRaw: 1 - best.score });
  }
  if (raw.length === 0) fail(EXIT.NO_DATA, 'no embedded candidates found — run `shelf embed`');

  // Second pass: normalize darkness + novelty to [0,1] across the pool.
  const darkN = minmax(raw.map((r) => r.darkRaw));
  const novN = minmax(raw.map((r) => r.noveltyRaw));

  const recommendations = raw
    .map((r, i) => ({
      id: r.c.id,
      t: r.c.t,
      a: r.c.a,
      year: r.c.year,
      pages: r.c.pages,
      isbn: r.c.isbn,
      genre: r.genre,
      baseScore: round(r.baseScore),
      nearestReadId: r.nearest.id,
      nearestReadTitle: r.nearest.t,
      darkness: round(darkN[i]),
      novelty: round(novN[i]),
      audience: isJuvenile(r.c.subjects) ? 'juvenile' : 'general',
      langGuess: looksNonEnglish(r.c.t, r.c.subjects) ? 'non-en' : 'en',
      subjects: (r.c.subjects || []).slice(0, 5),
    }))
    .sort((a, b) => b.baseScore - a.baseScore || a.id.localeCompare(b.id));

  if (!opts.dryRun) {
    await mkdir(CACHE, { recursive: true });
    await writeFile(RECOMMENDATIONS_JSON, JSON.stringify(recommendations, null, 2) + '\n');
    log(color.accent(`  ✓ wrote ${recommendations.length} recommendations → .cache/recommendations.json`));
  }

  const top = recommendations.slice(0, 10).map((r) => ({ t: r.t, a: r.a, genre: r.genre, baseScore: r.baseScore, near: r.nearestReadTitle }));
  emit({ recommendations: recommendations.length, genres: [...new Set(recommendations.map((r) => r.genre))], top }, opts, (d, plain) =>
    plain
      ? `${d.recommendations} recs`
      : `built ${d.recommendations} recs\n\nTop 10 by content relevance (the quality gate):\n` +
        d.top.map((r, i) => `  ${String(i + 1).padStart(2)}. ${r.t} — ${r.a}  [${r.genre} ${r.baseScore}]  ↳ near ${r.near}`).join('\n'),
  );
}
