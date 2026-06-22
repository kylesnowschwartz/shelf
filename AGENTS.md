# shelf — agent usage

`shelf` is a deterministic reading-recommendation engine. It is the PICKER: it
ranks unread candidate books against a reader's shelf. A calling agent maps the
human's natural language to flags, runs the engine, and explains the results.
The engine never parses prose and never writes prose. No API keys; runs locally.

Run from the repo root: `npm run shelf -- <command>` (or `node shelf.mjs <command>`, or
`shelf <command>` if installed on PATH via `npm link`).

## Output contract

- `--json` (default when stdout is piped) → machine-readable JSON on **stdout**.
- Progress/logs → **stderr**. Errors → structured `{"error":{"code,message}}` on stderr.
- Exit codes: `0` ok · `2` usage · `3` no-data · `4` not-built (run an earlier step) · `5` network.
- Deterministic: same flags → same output.

## Managing the read shelf (books.json)

```bash
npm run shelf -- add "<title>" "<author>" [--genre G --sub a,b --blend a,b --why "…"]  # one-shot add (resolves ISBN/year/cover; --dry-run to preview)
npm run shelf -- enrich    # backfill missing ISBN/year/cover on books.json (idempotent)
```

## Pipeline (run after adding books or on a fresh clone; artifacts are git-ignored in .cache/)

```bash
npm run shelf -- fetch     # → .cache/candidates.json     (Open Library; ~90s)
npm run shelf -- embed     # → .cache/embeddings/         (local MiniLM; git-ignored)
npm run shelf -- build     # → .cache/recommendations.json
```

After `add`, re-run fetch → embed → build to fold the new book into both the
exclusion set and the taste centroids.

## Publish to the website (`export`)

This repo OWNS the data. The personal website (`kylesnowschwartz.github.io`) renders
a committed copy of it. After changing the shelf, sync the copy:

```bash
npm run shelf -- export                          # writes into the sibling website checkout
npm run shelf -- export --to ../path/to/website  # explicit target (or set $SHELF_WEBSITE_DIR)
npm run shelf -- export --dry-run --json         # show what would be written
```

`export` writes `books.json` (byte-identical via the shared serializer) into the website's
`src/data/`. Then commit the synced file in the website repo to deploy. One-way only
(shelf → website); never hand-edit the website's copy — the next `export` overwrites it.
The ranking model (`recommend.ts`) is internal to this engine and is NOT exported.

On a fresh clone, run `fetch → embed → build` before `next`; the candidates,
recommendations, and embedding cache are generated in `.cache/` and git-ignored.

## The product: `next`

```bash
npm run shelf -- next --mood comforting --max-pages 350 --count 5 --json
npm run shelf -- next --like the-blade-itself,dune --count 8 --json
```

Flags: `--like <read-book-ids>` (ad-hoc seed; calibration off) · `--mood dark|comforting`
· `--novelty familiar|adventurous` · `--genre <list>` / `--not-genre <list>` (genre
steer; auto-disables genre-mix calibration) · `--adult` (drop juvenile/YA) · `--english`
(drop likely non-English editions) · `--max-pages <n>` · `--era 2000-|-1980|1990-2010`
· `--count <n>` · `--strict` (drop unknown-length books under a page cap) · `--seed <n>`.
Genres: `SFF`, `Thriller`, `Horror`, `Literary`, `Nonfiction`. `--novelty` moves by
embedding distance, NOT genre — use `--genre`/`--not-genre` (or seed mode) to shift genre.

Each recommendation carries: `title, author, year, pages, isbn, genre` (inferred from
nearest taste centroid), `score`, `baseScore`, `nearestReadId`, `nearestReadTitle`
(provenance — explain with this), `darkness`, `novelty`, `audience` (`juvenile`|`general`),
`langGuess` (`en`|`non-en`), `subjects`. The response also carries `filters` +
`prefiltered` (counts the intent filters dropped silently), `omitted[]` (high-relevance
books a hard page/era filter cut — offer them back) and `spread` (genre diversity).

## Inspect

```bash
npm run shelf -- profile --json   # genre mix (calibration target), repeat authors, top sub-genres
```

## Retrieve a copy

```bash
npm run shelf -- retrieve --isbn <isbn> --json
npm run shelf -- retrieve --title "..." --author "..." --ext azw3,epub --english --json
npm run shelf -- retrieve --isbn <isbn> --dry-run --json     # rank without downloading
npm run shelf -- retrieve --source-id zlib:r9bkkbjyzB --json # exact pick (skip search+rank)
```

Search runs through a headless Go binary (fast, JSON). Download runs through a
**persistent Playwright Chromium session** named `zlib` (the only thing z-lib's
`/dl/` endpoint accepts is a real browser). The session lives on disk in Chrome's
user-data-dir and survives between runs; the saved state at `.cache/zlib-state.json`
is a portable backup.

Delivery destination (set by `retrieve/deliver.mjs`):
- `/Volumes/Kindle/documents/` when the Kindle is mounted (`kind: "kindle"`)
- `~/Downloads/` otherwise (`kind: "downloads"`)
- `<dir>` when `--dest <dir>` is given (`kind: "override"`)

Filename is slugified safe text + format extension (e.g. `brian-robeson-01-hatchet.azw3`).
Each result carries `picked`, `destination`, `mounted`, `kind`, `format`, `sizeBytes`,
`alternatives[]`, `omitted[]` (candidates a hard filter dropped — surface them back).

Retrieve exit codes (same vocabulary): `5` means the source needs authentication
or is unavailable. If it returns `"sourceCode": "SOURCE_AUTH_REQUIRED"`, re-run:

```bash
npm run shelf -- zlib-login   # opens a headed browser; sign in once, then close
```

Cookies last ~30 days; you'll only need this on a fresh machine or after expiry.
