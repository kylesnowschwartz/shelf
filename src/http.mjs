// Keyless, polite HTTP for candidate fetching. Every public API we hit (Open
// Library, Google Books) is free and unauthenticated, so we must be a good
// citizen: identify ourselves, throttle per host, time out, and back off on
// 429/5xx rather than hammering. No API keys ever (acceptance criterion #5).
import { log } from './output.mjs';

const UA = 'kylesnowschwartz.com reading-list recommender (contact: kyle.snowschwartz@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-host minimum gap between requests, enforced via a tail-chained promise.
const MIN_GAP_MS = 250;
const lastByHost = new Map();
async function throttle(host) {
  const prev = lastByHost.get(host) || Promise.resolve();
  let release;
  const gate = new Promise((r) => (release = r));
  lastByHost.set(host, prev.then(() => gate));
  await prev;
  setTimeout(release, MIN_GAP_MS);
}

/**
 * GET JSON with timeout + bounded retry. Returns parsed JSON, or null on a
 * 429/quota response that survives all retries (caller decides if that host is
 * optional). Throws on other terminal failures.
 */
export async function getJson(url, { timeoutMs = 15000, retries = 3, optional = false } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        const backoff = Math.min(2000 * 2 ** attempt, 16000);
        if (attempt < retries) {
          log(`  ⟲ ${host} ${res.status} — backing off ${backoff}ms (try ${attempt + 1}/${retries})`);
          await sleep(backoff);
          continue;
        }
        if (optional) {
          log(`  ⚠ ${host} ${res.status} after ${retries} retries — skipping (optional source)`);
          return null;
        }
        throw new Error(`${host} ${res.status} after ${retries} retries`);
      }
      if (!res.ok) throw new Error(`${host} HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      const transient = err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (transient && attempt < retries) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        log(`  ⟲ ${host} ${err.name || err.code} — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      if (optional) {
        log(`  ⚠ ${host} ${err.message} — skipping (optional source)`);
        return null;
      }
      throw err;
    }
  }
  return optional ? null : null;
}
