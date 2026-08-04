// Polite HTTP for candidate fetching. Open Library is free and
// unauthenticated, so we must be a good citizen: identify ourselves, throttle
// per host, time out, and back off on 429/5xx rather than hammering. A
// User-Agent naming the app and a contact address is what earns the higher
// anonymous rate budget. Google Books is the one keyed host, and its key
// travels in the query string — so failures log the host, never the URL.
import { log } from './output.mjs';

const UA = 'kylesnowschwartz.com reading-list recommender (contact: kyle.snowschwartz@gmail.com)';
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-host request spacing. A host answering normally is polled at
// MIN_GAP_MS; one that answers 429 or 5xx has its gap widened, so the requests
// that follow arrive slower instead of each burning its own retry budget
// against a wall the host already told us about. The gap halves back toward
// the minimum on every success. The floor is set by Open Library's allowance
// of three requests a second for a client that identifies itself, which the
// User-Agent above does.
const MIN_GAP_MS = 340;
const MAX_GAP_MS = 8000;
// A Retry-After far in the future means the quota is gone for this run; wait
// this long at most, then let the caller treat the host as unavailable.
const MAX_RETRY_AFTER_MS = 60000;

const gapByHost = new Map();
const lastByHost = new Map();

const hostGap = (host) => gapByHost.get(host) ?? MIN_GAP_MS;

function widenGap(host) {
  gapByHost.set(host, Math.min(hostGap(host) * 2, MAX_GAP_MS));
}

function narrowGap(host) {
  const relaxed = Math.max(MIN_GAP_MS, Math.floor(hostGap(host) / 2));
  if (relaxed === MIN_GAP_MS) gapByHost.delete(host);
  else gapByHost.set(host, relaxed);
}

/** Clears per-host pacing so a caller starts from the polite default. */
export function resetHostPacing() {
  gapByHost.clear();
  lastByHost.clear();
}

/** The gap currently enforced between requests to a host, in ms. */
export const hostGapMs = (host) => hostGap(host);

async function throttle(host) {
  const prev = lastByHost.get(host) || Promise.resolve();
  let release;
  const gate = new Promise((r) => (release = r));
  lastByHost.set(host, prev.then(() => gate));
  await prev;
  setTimeout(release, hostGap(host));
}

/**
 * How long a 429/503 response asks us to wait, in ms, or null when the header
 * is absent or unparseable. RFC 9110 allows either a delay in seconds or an
 * HTTP date.
 */
export function retryAfterMs(headerValue, now = Date.now()) {
  if (!headerValue) return null;
  const raw = String(headerValue).trim();
  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/** Exponential backoff with jitter, so parallel callers do not retry in lockstep. */
function backoffMs(attempt, base, cap, random) {
  const window = Math.min(base * 2 ** attempt, cap);
  return Math.floor(window / 2 + random() * (window / 2));
}

/**
 * GET JSON with timeout + bounded retry. Returns parsed JSON, or null on a
 * 429/quota response that survives all retries (caller decides if that host is
 * optional). Throws on other terminal failures.
 */
export async function getJson(
  url,
  {
    timeoutMs = 15000,
    retries = 3,
    optional = false,
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    random = Math.random,
  } = {},
) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        widenGap(host);
        const asked = retryAfterMs(res.headers?.get?.('retry-after'));
        const wait = asked ?? backoffMs(attempt, 2000, 16000, random);
        if (attempt < retries) {
          const why = asked === null ? '' : ' (Retry-After)';
          log(`  ⟲ ${host} ${res.status} — backing off ${wait}ms${why} (try ${attempt + 1}/${retries})`);
          await sleep(wait);
          continue;
        }
        if (optional) {
          log(`  ⚠ ${host} ${res.status} after ${retries} retries — skipping (optional source)`);
          return null;
        }
        throw new Error(`${host} ${res.status} after ${retries} retries`);
      }
      if (!res.ok) throw new Error(`${host} HTTP ${res.status}`);
      const parsed = await res.json();
      narrowGap(host);
      return parsed;
    } catch (err) {
      clearTimeout(timer);
      const transient = err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (transient && attempt < retries) {
        const wait = backoffMs(attempt, 1000, 8000, random);
        log(`  ⟲ ${host} ${err.name || err.code} — retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (optional) {
        log(`  ⚠ ${host} ${err.message} — skipping (optional source)`);
        return null;
      }
      throw err;
    }
  }
  return null;
}
