// Read-side of the embedding cache. `build` and `next` both need the vectors
// `embed` produced; this is the one place that loads them.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EMBED_CACHE } from './paths.mjs';
import { fail, EXIT } from './output.mjs';

const CACHE_FILE = join(EMBED_CACHE, 'vectors.json');

/** Load { "read:<id>"|"cand:<id>": {hash,dim,vec} }, or fail with the fix. */
export async function loadVectors() {
  if (!existsSync(CACHE_FILE)) fail(EXIT.NOT_BUILT, 'no embedding cache — run `shelf embed` first');
  return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
}

export const readKey = (id) => `read:${id}`;
export const candKey = (id) => `cand:${id}`;
