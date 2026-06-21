/**
 * Reading recommender — pure ranking model.
 *
 * DOM-free, dependency-free, isomorphic: the same functions run in the `shelf`
 * CLI (Node) and, later, in the website UI (browser). This module is the
 * deterministic PICKER the preference research prescribes for one reader with
 * no ratings: a content-based core (cosine to per-genre taste centroids),
 * re-ranked for diversity (MMR) and calibrated to the reader's genre mix —
 * never raw similarity, which traps you in a single-genre loop.
 *
 * No collaborative filtering (needs many users), no LLM picking (hallucinates).
 * Natural-language intent → dials happens in the agent layer, not here.
 */

export type Dials = {
  /** 'dark' rewards grim candidates, 'comforting' rewards light ones. */
  mood?: 'dark' | 'comforting';
  /** 'familiar' rewards close-to-shelf picks, 'adventurous' rewards far ones. */
  novelty?: 'familiar' | 'adventurous';
};

export interface RankItem {
  id: string;
  genre: string;
  /** content-similarity relevance in [0,1] (cosine to nearest taste centroid). */
  relevance: number;
  /** 0 = light/comforting, 1 = grim/dark (mood axis projection). */
  darkness?: number;
  /** 0 = very familiar (close to shelf), 1 = far from anything read. */
  novelty?: number;
  /** unit-length embedding; used for on-the-fly diversity when no sim() given. */
  vec?: number[];
}

/** Cosine similarity. Vectors are expected L2-normalized, so this is a dot product. */
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** L2-normalize a vector (returns a new array; zero vector returned as-is). */
export function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

/** Mean of several vectors, re-normalized — a taste centroid. */
export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const acc = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) acc[i] += v[i];
  for (let i = 0; i < dim; i++) acc[i] /= vectors.length;
  return normalize(acc);
}

/** One centroid per genre, from the reader's embedded shelf. */
export function centroidsByGenre(items: { genre: string; vec: number[] }[]): Record<string, number[]> {
  const byGenre = new Map<string, number[][]>();
  for (const it of items) {
    if (!byGenre.has(it.genre)) byGenre.set(it.genre, []);
    byGenre.get(it.genre)!.push(it.vec);
  }
  const out: Record<string, number[]> = {};
  for (const [g, vecs] of byGenre) out[g] = meanVector(vecs);
  return out;
}

/** Highest-cosine centroid for a vector → which genre it reads most like. */
export function nearestCentroid(vec: number[], centroids: Record<string, number[]>): { genre: string; score: number } {
  let best = { genre: '', score: -Infinity };
  for (const [genre, c] of Object.entries(centroids)) {
    const score = cosine(vec, c);
    if (score > best.score) best = { genre, score };
  }
  return best;
}

/**
 * Apply the knowledge-based dials as a soft reweight of relevance. These nudge,
 * they don't filter (hard filters like --max-pages live in the CLI). Mood and
 * novelty are real preference dimensions in the literature; expose them as
 * tunable, not baked-in.
 */
export function applyDials(item: RankItem, dials: Dials, weight = 0.35): number {
  let adj = item.relevance;
  if (dials.mood && item.darkness != null) {
    const want = dials.mood === 'dark' ? item.darkness : 1 - item.darkness;
    adj += weight * (want - 0.5);
  }
  if (dials.novelty && item.novelty != null) {
    const want = dials.novelty === 'adventurous' ? item.novelty : 1 - item.novelty;
    adj += weight * (want - 0.5);
  }
  return adj;
}

/**
 * Greedy Maximal Marginal Relevance with an optional calibration nudge.
 *
 * At each step pick the item maximizing:
 *   lambda * relevance
 *   - (1 - lambda) * maxSimilarityToAlreadyPicked        (diversity)
 *   + lambdaCal * (targetShare[genre] - currentShare[genre])  (calibration)
 *
 * `lambda` is the relevance weight; `1 - lambda` is Ziegler's diversification
 * factor — the book-domain study found reader satisfaction peaks around 0.4,
 * so lambda ≈ 0.6 is the default. `target` is the reader's genre histogram
 * (shares summing to 1); pass it to stop one dominant genre crowding the list.
 */
export function mmrSelect(
  items: RankItem[],
  k: number,
  opts: { lambda?: number; lambdaCal?: number; target?: Record<string, number>; sim?: (a: RankItem, b: RankItem) => number } = {},
): RankItem[] {
  const lambda = opts.lambda ?? 0.6;
  const lambdaCal = opts.lambdaCal ?? 0;
  const target = opts.target ?? {};
  const sim = opts.sim ?? ((a, b) => (a.vec && b.vec ? cosine(a.vec, b.vec) : 0));

  const pool = items.slice();
  const picked: RankItem[] = [];
  const genreCount: Record<string, number> = {};

  while (picked.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestUtil = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let maxSim = 0;
      for (const p of picked) maxSim = Math.max(maxSim, sim(cand, p));
      let util = lambda * cand.relevance - (1 - lambda) * maxSim;
      if (lambdaCal > 0) {
        const currentShare = picked.length ? (genreCount[cand.genre] || 0) / picked.length : 0;
        util += lambdaCal * ((target[cand.genre] || 0) - currentShare);
      }
      if (util > bestUtil) {
        bestUtil = util;
        bestIdx = i;
      }
    }
    const [chosen] = pool.splice(bestIdx, 1);
    picked.push(chosen);
    genreCount[chosen.genre] = (genreCount[chosen.genre] || 0) + 1;
  }
  return picked;
}

/** Genre histogram (shares summing to 1) over a set of read books. */
export function genreHistogram(genres: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const g of genres) counts[g] = (counts[g] || 0) + 1;
  const total = genres.length || 1;
  const out: Record<string, number> = {};
  for (const [g, n] of Object.entries(counts)) out[g] = n / total;
  return out;
}
