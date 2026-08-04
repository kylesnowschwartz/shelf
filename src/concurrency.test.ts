import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs sibling has no type declarations
import { mapWithConcurrency } from './concurrency.mjs';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    const items = [30, 5, 20, 1];
    const out = await mapWithConcurrency(items, 4, async (ms: number) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 5, 20, 1]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it('handles an empty input without spawning workers', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => void calls++);
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('caps width at the item count when the limit exceeds it', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 16, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  it('propagates a rejecting task to the caller', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n: number) => {
        if (n === 2) throw new Error('task failed');
        return n;
      }),
    ).rejects.toThrow('task failed');
  });

  it('passes the index alongside each item', async () => {
    const seen: Array<[number, number]> = [];
    await mapWithConcurrency([10, 20, 30], 1, async (item: number, i: number) => {
      seen.push([item, i]);
    });
    expect(seen).toEqual([
      [10, 0],
      [20, 1],
      [30, 2],
    ]);
  });
});
