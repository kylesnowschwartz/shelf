import { describe, it, expect } from 'vitest';
import {
  cosine,
  normalize,
  meanVector,
  centroidsByGenre,
  nearestCentroid,
  applyDials,
  mmrSelect,
  genreHistogram,
  type RankItem,
} from './recommend';

describe('vector math', () => {
  it('cosine: identical = 1, orthogonal = 0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('normalize: returns unit length', () => {
    const n = normalize([3, 4]);
    expect(Math.hypot(...n)).toBeCloseTo(1);
    expect(normalize([0, 0])).toEqual([0, 0]); // zero vector is left alone
  });

  it('meanVector: averages then re-normalizes', () => {
    const m = meanVector([[1, 0], [0, 1]]);
    expect(Math.hypot(...m)).toBeCloseTo(1);
    expect(m[0]).toBeCloseTo(m[1]); // symmetric inputs → symmetric centroid
  });
});

describe('taste profile', () => {
  const items = [
    { genre: 'SFF', vec: [1, 0] },
    { genre: 'SFF', vec: [1, 0] },
    { genre: 'Horror', vec: [0, 1] },
  ];

  it('centroidsByGenre: one centroid per genre', () => {
    const c = centroidsByGenre(items);
    expect(Object.keys(c).sort()).toEqual(['Horror', 'SFF']);
    expect(cosine(c.SFF, [1, 0])).toBeCloseTo(1);
  });

  it('nearestCentroid: picks the closest genre', () => {
    const c = centroidsByGenre(items);
    expect(nearestCentroid([0.9, 0.1], c).genre).toBe('SFF');
    expect(nearestCentroid([0.1, 0.9], c).genre).toBe('Horror');
  });
});

describe('applyDials', () => {
  const base: RankItem = { id: 'x', genre: 'SFF', relevance: 0.5, darkness: 0.9, novelty: 0.8 };

  it('no dials → relevance unchanged', () => {
    expect(applyDials(base, {})).toBeCloseTo(0.5);
  });

  it('mood: comforting penalizes a dark book, dark rewards it', () => {
    expect(applyDials(base, { mood: 'comforting' })).toBeLessThan(0.5);
    expect(applyDials(base, { mood: 'dark' })).toBeGreaterThan(0.5);
  });

  it('novelty: familiar penalizes a far-flung book, adventurous rewards it', () => {
    expect(applyDials(base, { novelty: 'familiar' })).toBeLessThan(0.5);
    expect(applyDials(base, { novelty: 'adventurous' })).toBeGreaterThan(0.5);
  });
});

describe('mmrSelect', () => {
  const A: RankItem = { id: 'A', genre: 'SFF', relevance: 0.9, vec: [1, 0] };
  const B: RankItem = { id: 'B', genre: 'SFF', relevance: 0.85, vec: [1, 0] }; // near-duplicate of A
  const C: RankItem = { id: 'C', genre: 'Horror', relevance: 0.7, vec: [0, 1] }; // distinct

  it('lambda=1 → pure relevance order (the similarity-hole trap)', () => {
    const out = mmrSelect([A, B, C], 2, { lambda: 1 });
    expect(out.map((x) => x.id)).toEqual(['A', 'B']);
  });

  it('diversity → after A, the near-duplicate B loses to the distinct C', () => {
    const out = mmrSelect([A, B, C], 2, { lambda: 0.5 });
    expect(out.map((x) => x.id)).toEqual(['A', 'C']);
  });

  it('calibration → an under-target genre is pulled up despite lower relevance', () => {
    const y1: RankItem = { id: 'y1', genre: 'SFF', relevance: 0.9 };
    const y2: RankItem = { id: 'y2', genre: 'SFF', relevance: 0.8 };
    const x1: RankItem = { id: 'x1', genre: 'Nonfiction', relevance: 0.5 };
    const out = mmrSelect([y1, y2, x1], 1, { lambda: 0.6, lambdaCal: 2, target: { Nonfiction: 1, SFF: 0 }, sim: () => 0 });
    expect(out[0].id).toBe('x1');
  });

  it('returns at most k, never crashes when k exceeds pool', () => {
    expect(mmrSelect([A], 5, {})).toHaveLength(1);
  });
});

describe('genreHistogram', () => {
  it('shares sum to 1', () => {
    const h = genreHistogram(['SFF', 'SFF', 'Horror', 'Literary']);
    expect(h.SFF).toBeCloseTo(0.5);
    expect(Object.values(h).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});
