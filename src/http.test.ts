import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs sibling has no type declarations
import { getJson, hostGapMs, resetHostPacing, retryAfterMs } from './http.mjs';

const URL_A = 'https://example.test/a';

/** A Response-shaped stub carrying only what getJson reads. */
function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** Records every sleep so a test can assert on waits without spending them. */
function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe('retryAfterMs', () => {
  it('reads a delay given in seconds', () => {
    expect(retryAfterMs('30')).toBe(30000);
  });

  it('reads a delay given as an HTTP date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10000);
  });

  it('clamps a far-future date to the maximum wait', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs('Thu, 01 Jan 2027 00:00:00 GMT', now)).toBe(60000);
  });

  it('treats a past date as no wait', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs('Thu, 01 Jan 2025 00:00:00 GMT', now)).toBe(0);
  });

  it('returns null when the header is absent or unparseable', () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('getJson', () => {
  beforeEach(() => resetHostPacing());

  it('waits for the period the server asked for instead of its own backoff', async () => {
    const { waits, sleep } = recorder();
    const responses = [reply(429, {}, { 'retry-after': '7' }), reply(200, { ok: true })];
    const fetchImpl = async () => responses.shift();

    const out = await getJson(URL_A, { fetchImpl, sleep, random: () => 0.5, retries: 3 });

    expect(out).toEqual({ ok: true });
    expect(waits).toEqual([7000]);
  });

  it('falls back to jittered exponential backoff when the server gives no period', async () => {
    const { waits, sleep } = recorder();
    const responses = [reply(429), reply(429), reply(200, { ok: true })];
    const fetchImpl = async () => responses.shift();

    await getJson(URL_A, { fetchImpl, sleep, random: () => 0, retries: 3 });

    // window/2 with random() === 0: 2000 -> 1000, then 4000 -> 2000.
    expect(waits).toEqual([1000, 2000]);
  });

  it('varies the backoff with the random source so callers do not retry in lockstep', async () => {
    const low = recorder();
    const high = recorder();
    const attempts = () => [reply(429), reply(200, {})];

    let a = attempts();
    await getJson(URL_A, { fetchImpl: async () => a.shift(), sleep: low.sleep, random: () => 0, retries: 3 });
    resetHostPacing();
    let b = attempts();
    await getJson(URL_A, { fetchImpl: async () => b.shift(), sleep: high.sleep, random: () => 0.99, retries: 3 });

    expect(high.waits[0]).toBeGreaterThan(low.waits[0]);
  });

  it('returns null for an optional source once retries are exhausted', async () => {
    const { sleep } = recorder();
    const out = await getJson(URL_A, {
      fetchImpl: async () => reply(429),
      sleep,
      random: () => 0,
      retries: 1,
      optional: true,
    });
    expect(out).toBeNull();
  });

  it('throws for a required source once retries are exhausted', async () => {
    const { sleep } = recorder();
    await expect(
      getJson(URL_A, { fetchImpl: async () => reply(500), sleep, random: () => 0, retries: 1 }),
    ).rejects.toThrow(/500 after 1 retries/);
  });

  it('widens the gap for a host that answers 429, so later requests are paced', async () => {
    const { sleep } = recorder();
    const before = hostGapMs('example.test');

    await getJson(URL_A, {
      fetchImpl: async () => reply(429),
      sleep,
      random: () => 0,
      retries: 0,
      optional: true,
    });

    expect(hostGapMs('example.test')).toBeGreaterThan(before);
  });

  it('narrows the gap back toward the default once a host answers normally', async () => {
    const { sleep } = recorder();
    await getJson(URL_A, {
      fetchImpl: async () => reply(429),
      sleep,
      random: () => 0,
      retries: 0,
      optional: true,
    });
    const widened = hostGapMs('example.test');

    await getJson(URL_A, { fetchImpl: async () => reply(200, {}), sleep, random: () => 0 });

    expect(hostGapMs('example.test')).toBeLessThan(widened);
  });
});
