// `shelf embed` — turn every read book and candidate into a 384-dim vector and
// cache it. The cache is keyed by id + a hash of the embedded text, so re-runs
// only re-embed what actually changed (edit a `why`, only that book re-embeds).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKS_JSON, CANDIDATES_JSON, EMBED_CACHE } from './paths.mjs';
import { log, emit, fail, EXIT, color } from './output.mjs';
import { embedText, readText, candText, textHash } from './embed-model.mjs';

const CACHE_FILE = join(EMBED_CACHE, 'vectors.json');

export async function run(opts) {
  const books = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));
  if (!existsSync(CANDIDATES_JSON)) fail(EXIT.NOT_BUILT, 'no candidates.json — run `shelf fetch` first');
  const candidates = JSON.parse(await readFile(CANDIDATES_JSON, 'utf8'));

  await mkdir(EMBED_CACHE, { recursive: true });
  const cache = existsSync(CACHE_FILE) ? JSON.parse(await readFile(CACHE_FILE, 'utf8')) : {};

  // read books → "read:<id>"; candidates → "cand:<id>" (namespaced so a slug
  // collision between the two sets can never overwrite the wrong vector).
  const items = [
    ...books.map((b) => ({ key: `read:${b.id}`, text: readText(b) })),
    ...candidates.map((c) => ({ key: `cand:${c.id}`, text: candText(c) })),
  ];

  let embedded = 0;
  let hits = 0;
  log(color.bold('shelf embed') + ` — ${items.length} items (${books.length} read + ${candidates.length} candidates)`);
  for (const { key, text } of items) {
    const h = textHash(text);
    if (!opts.force && cache[key]?.hash === h) {
      hits++;
      continue;
    }
    cache[key] = { hash: h, dim: 0, vec: await embedText(text) };
    cache[key].dim = cache[key].vec.length;
    embedded++;
    if (embedded % 50 === 0) log(color.dim(`  …embedded ${embedded}`));
  }

  // Drop stale cache entries for ids no longer present (candidates churn each fetch).
  const live = new Set(items.map((i) => i.key));
  for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];

  await writeFile(CACHE_FILE, JSON.stringify(cache));

  const dims = new Set(Object.values(cache).map((v) => v.dim));
  const summary = { items: items.length, embedded, cacheHits: hits, dim: [...dims][0] || 0, cached: Object.keys(cache).length };
  log(color.accent(`  ✓ ${embedded} embedded, ${hits} cache hits → .cache/embeddings/vectors.json`));
  emit(summary, opts, (s, plain) => (plain ? `${s.embedded} embedded ${s.cacheHits} hits dim ${s.dim}` : `embedded ${s.embedded}, hits ${s.cacheHits}, dim ${s.dim}, total ${s.cached}`));
}
