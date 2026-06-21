// Repo-relative paths for the shelf CLI. One place so commands can't drift on
// where data and the embedding cache live.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // shelf/src
export const ROOT = join(here, '..'); // shelf repo root
export const DATA = join(ROOT, 'data');
export const CACHE = join(ROOT, '.cache');
export const BOOKS_JSON = join(DATA, 'books.json');
// The pure ranking model — shelf owns the canonical copy; `shelf export` syncs
// it into consumer checkouts alongside books.json.
export const RECOMMEND_TS = join(here, 'recommend.ts');
export const CANDIDATES_JSON = join(CACHE, 'candidates.json');
export const RECOMMENDATIONS_JSON = join(CACHE, 'recommendations.json');
export const EMBED_CACHE = join(CACHE, 'embeddings');
// Z-lib browser session state (cookies + localStorage), written by
// `shelf zlib-login` and read by the retrieve driver. `.cache/` is
// gitignored so the auth state never lands in commits.
export const ZLIB_STATE_FILE = join(CACHE, 'zlib-state.json');
