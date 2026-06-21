# shelf

`shelf` is a deterministic, keyless reading-recommendation engine — the **picker**. It
fetches unread candidate books, embeds them locally (MiniLM), and ranks them against a
read shelf with diversity + calibration re-ranking. It never parses or writes prose; that
is the calling agent's job. Output is `--json`-primary. No API keys, ever.

This repo also **owns the reading-list data** (`data/books.json`) and the pure ranking
model (`src/recommend.ts`). The personal website `kylesnowschwartz.github.io` renders a
committed copy of both, kept in sync by `shelf export` (one-way: shelf → website).

## Layout

| Path | What |
|------|------|
| `shelf.mjs` | CLI entry (commander); lazy-loads each command from `src/` |
| `src/cmd-*.mjs` | one file per command (fetch, add, enrich, embed, build, next, profile, export, retrieve, zlib-login) |
| `src/recommend.ts` | pure, dependency-free ranking model (canonical home; exported to the website) |
| `src/books-io.mjs` | the single books.json read/write/serialize point |
| `src/paths.mjs` | the single source of truth for all file locations |
| `src/genres.mjs` | the canonical genre vocabulary (must match the website's Zod `z.enum`) |
| `src/retrieve/` | book-file sourcing + delivery (z-lib via a Playwright session) |
| `data/books.json` | the read shelf — source of truth |
| `.cache/` | generated artifacts + z-lib session (git-ignored) |

## Usage

Canonical agent reference: **`AGENTS.md`**. Pipeline:

```bash
npm run shelf -- add "<title>" "<author>"   # add a read book (resolves ISBN/year/cover)
npm run shelf -- fetch                        # → .cache/candidates.json
npm run shelf -- embed                        # → .cache/embeddings/
npm run shelf -- build                        # → .cache/recommendations.json
npm run shelf -- next --json                  # the product: ranked recommendations
npm run shelf -- export                       # sync books.json + recommend.ts → website
```

After `add`, re-run `fetch → embed → build` to fold the book into the exclusion set and
taste centroids, then `export` to publish to the website.

Requires Node ≥ 23.6 (native TypeScript type-stripping — `.mjs` files import `recommend.ts`
directly with no loader). `retrieve`/`zlib-login` additionally need the `playwright-cli`
binary on PATH.

## Tests

`npm test` (vitest). Tests live next to their modules as `src/**/*.test.ts`.
