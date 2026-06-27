---
name: shelf-skill
description: >-
  Kyle's reading library and book engine. Use for ANYTHING book-related: getting a
  recommendation or "what should I read next / something like X / a cozy short read";
  retrieving or downloading a book and sending a copy to his Kindle; adding a book he's
  read to his reading-list library; or maintaining/inspecting the library (enrich covers,
  rebuild recommendations, show his taste profile). Drives the local, keyless `shelf`
  engine — never invents titles, ISBNs, or book facts.
---

# Shelf — Kyle's reading library

`shelf` is a local, keyless CLI that backs Kyle's reading life. It has four jobs.
**This skill is the router:** figure out which job the request is, run the matching
`shelf` command, and present the result in Kyle's voice (warm, dry, no filler).
The engine is deterministic and the source of truth — never fabricate a book, author,
ISBN, or fact. Only present what `shelf` returns.

This plugin bundles the engine. Run it as the bare command **`shelf <command> ... --json`**
(provided by this plugin's `bin/`). The first invocation auto-installs the engine's node
deps once; after that it's instant. All command examples below use this `shelf` command. (In
a raw dev clone of the repo, `npm run shelf -- <command>` does the same.)

`data/books.json` is the source of truth, owned by this engine. After any command that
changes it (`add`, `enrich`), run `shelf export` to sync a byte-identical copy into Kyle's
website (`kylesnowschwartz.github.io/src/data/books.json`) — set `$SHELF_WEBSITE_DIR` or pass
`--to <website-dir>` if it isn't the conventional sibling path — then commit it in the website
repo to deploy "The House". The website copy is derived — never edit it directly.

**Write commands run against the canonical clone, not a cache.** `add`/`enrich`/`export`
mutate `data/books.json`. If this plugin was installed from a *remote* marketplace it lives
in `~/.claude/plugins/` and is wiped on update — an `add` there is lost. So run write commands
from Kyle's dev clone (`/Users/kyle/Code/my-projects/shelf`); `recommend`/`retrieve` are
read-only and safe from any install.

## Route the request

| If Kyle wants… | Job | Command | Section |
|---|---|---|---|
| a recommendation, "what to read next", "something like X", a mood/length/era read | **recommend** | `next` | [Recommend](#recommend) |
| a copy of a book / "send X to my Kindle" / "get/download the one you recommended" | **retrieve** | `retrieve` | [Retrieve](#retrieve) |
| to log a book he's *finished* to his library | **add** | `add` | [Add to library](#add-to-library) |
| covers/ISBNs backfilled, recommendations rebuilt, or his taste profile | **maintain** | `enrich`/`fetch`/`embed`/`build`/`profile` | [Maintain & inspect](#maintain--inspect) |

A single request can chain jobs — e.g. *"recommend something short and send it to my
Kindle"* = **recommend** then **retrieve**. *"I finished Dune, what's next?"* = **add**
then **recommend**.

Output contract for every command: JSON on **stdout**, logs/progress on **stderr**,
structured `{"error":{code,message}}` on failure. Exit codes: `0` ok · `2` usage ·
`3` no-data · `4` not-built (run an earlier pipeline step) · `5` source/network.

---

## Recommend

For "what should I read next", "something like X/Y/Z", or any mood/novelty/length/era/
genre request. **The engine picks; you interpret his request and explain the results.**
Never invent titles, authors, or ISBNs — only present what `shelf next` returns.

### 1. Map his natural language to flags

`shelf next` takes flags, not prose. Translate his request:

| He says… | Flag |
|---|---|
| cozy, comforting, gentle, palette cleanser, light, feel-good | `--mood comforting` |
| dark, grim, grimdark, bleak, brutal, heavy | `--mood dark` |
| familiar, nostalgic, comfort read, more of what I love | `--novelty familiar` |
| surprise me, an unexpected pick, off the beaten path *(but same genres)* | `--novelty adventurous` |
| less / no sci-fi-fantasy, horror, etc. | `--not-genre SFF` (or `Horror`, `Thriller`, …) |
| only / mostly literary, nonfiction, etc. | `--genre Literary` (or `Nonfiction`, …) |
| more nature / survival / historical / westerns / a *theme*, not a genre | seed `--like <ids>` against his shelf books in that vein (step 2) — optionally + `--not-genre SFF` |
| no YA / kids' books / "something grown-up" | `--adult` |
| English only / no foreign-language editions | `--english` |
| short, quick, a weekend read, page-turner | `--max-pages 350` (or `400`) |
| "like X, Y, Z" / "similar to X" | `--like <ids>` (resolve titles → ids, step 2) |
| from the 80s / recent / modern / classic | `--era 1980-1989` / `--era 2015-` / `--era -1980` |
| "give me 8" / a longer list | `--count 8` (default 5) |
| "show me another / different ones / re-roll" | `--seed <n>` (any new number; same number reproduces) |

Combine freely: *"cozy and short after that grimdark binge"* → `--mood comforting --max-pages 350`.
If he names no constraint, run with no dials (pure relevance + diversity).

**Genre/theme shift ≠ novelty.** `--novelty adventurous` rewards books *far from his shelf
by embedding distance* — it does NOT move him out of a genre, and in dial mode the engine
calibrates results back toward his dominant genre (heavy SFF), so "less fantasy" via
`--novelty` backfires into a fantasy-heavy list. For a request to move toward or away from a
**genre**, use `--genre`/`--not-genre`. For a **theme** that isn't a genre (nature, survival,
historical, seafaring), seed `--like` against the matching books on his shelf — seed mode
turns calibration off, so it actually leaves the dominant genre behind. Valid genres: `SFF`,
`Thriller`, `Horror`, `Literary`, `Nonfiction`. Any genre filter (or seed mode) auto-disables
genre-mix calibration.

### 2. Resolve "like X" titles to ids

When he seeds with titles, read `data/books.json`, find the matching entries by title,
and pass their `id` values: `--like the-blade-itself,the-last-wish,a-game-of-thrones`. If a
named book isn't on his shelf, say so — seed mode needs books he's read.

### 3. Run the engine

```bash
shelf next <flags> --json
```

Read the JSON from stdout. If it exits with a `NOT_BUILT` error:
- "no embedding cache" → `shelf embed` (vector cache is git-ignored, so a fresh
  clone needs it once; ~a few seconds), then retry.
- "no recommendations.json" → `shelf build`, then retry.
- To refresh the candidate pool entirely (rare): `fetch && embed && build` (~2 min, hits
  Open Library).

### 4. Present in Kyle's voice

Give him **3–5 books**, conversational and direct. For each, use the JSON's provenance:

- **Title** — Author, year · Npp. One honest line on why it fits, anchored to the
  `nearestReadTitle` ("nearest your Bobiverse books", "near your read of *The Blade Itself*").
- **Render foreign-language titles in English** when you recognize the work (e.g. the engine
  may return *Czas pogardy* — present it as *Time of Contempt* (Witcher 3)).
- **Read the per-book flags.** Each pick carries `audience` (`juvenile` = YA/kids) and
  `langGuess` (`non-en` = likely a foreign-language edition). A `juvenile` pick may still fit
  (he reads Paulsen) — call it out: *"YA, but it's the* Hatchet *sequel"*. A `non-en` pick you
  can't translate confidently, drop. If he wants neither, re-run with `--adult` / `--english`.
- **Curate lightly.** The engine is strong but not perfect. If a pick is an obvious mismatch
  (a textbook, a wrong-language edition you don't recognize), drop it and pull the next — but
  say you did.
- **Surface omissions honestly.** If `omitted[]` lists a high-relevance book the filters cut,
  offer it back: *"I left out The Cold Commands — 496pp, over your page bar; want it anyway?"*
- End by offering an adjacent dial: *"Too far from home? I can bias familiar instead."*

Trust the engine's ranking — don't re-rank by vibe or substitute your own picks.

---

## Retrieve

Source a copy of a specific book and deliver it. Triggers: *"get me a copy of X"*,
*"send that to my Kindle"*, *"download the one you just recommended"*.

### Workflow

1. **Pin the title + author** (or ISBN). Pull it from the conversation (e.g. the book you
   just recommended), or ask. ISBN wins when you have it — it's the most precise query.
2. **Run the retrieve:**
   ```bash
   shelf retrieve --isbn <isbn> --json
   # or
   shelf retrieve --title "..." --author "..." --ext azw3,epub --english --json
   ```
   Kindles read **AZW3 / EPUB** natively; the engine already prefers those, then MOBI,
   then PDF (poor reflow). Add `--ext azw3,epub` to be strict, `--english` to drop
   non-English editions, `--max-mb <n>` to skip likely OCR scans / audiobook zips.
3. **Preview first when the pick is uncertain:** `--dry-run` searches and ranks without
   downloading, returning `picked` + `alternatives`. If the heuristic picked wrong,
   re-run with `--source-id <id>` (from the dry-run output) to fetch that exact edition.
4. **Read the JSON and report the outcome.** Delivery routing is automatic:
   - `kind: "kindle"` (mounted at `/Volumes/Kindle/documents/`) → *"Landed on your Kindle — `<title>`, <format>."*
   - `kind: "downloads"` (`~/Downloads/`) → *"Kindle wasn't mounted, so it's in `~/Downloads`. Plug in and re-run, or move it across."*
   - `kind: "override"` (`--dest`) → *"Saved to `<dir>`."*
   - Name the edition you got (`picked.format`, year) in one line — *which* copy and why.
   - If `omitted[]` is non-empty (a copy dropped by `--ext`/`--max-mb`/`--english`),
     offer it back: *"Skipped a 60 MB scan; want it instead?"*
5. **Never name the backend.** Say "your copy", "the source", "the best edition",
   "delivered to your Kindle" — never the library/site/binary it came from.

### Auth lifecycle (two independent sessions, binary-first)

`retrieve` downloads via **two transports with independent logins**, and tries them in
order:

1. **Binary (primary).** The `zlib` Go binary downloads directly. Its session lives in
   `~/.config/zlib/session.json` and is refreshed *outside shelf* by running `zlib login`
   directly (email/password). shelf does not manage this login.
2. **Browser (fallback).** If the binary fails for any reason, `retrieve` falls back to a
   persistent Chromium session whose cookies last ~30 days, refreshed by `shelf zlib-login`.

The result JSON reports which one delivered via `"transport": "binary" | "browser"`.
Because the two sessions are independent, a download succeeds as long as **either** is
alive — so `retrieve` only exits `5` with `"sourceCode": "SOURCE_AUTH_REQUIRED"` when
**both** have expired.

When that happens, tell Kyle plainly and offer both refreshes — the browser one is the
in-shelf one-shot:

```bash
shelf zlib-login   # opens a headed browser; Kyle signs in, you wait
# and/or, outside shelf, to refresh the primary path:
zlib login
```

`shelf zlib-login` polls cookies, saves state to `.cache/zlib-state.json` (gitignored),
closes the window, and emits a success JSON when done. After either refresh, retry the
failed retrieve. Default timeout is 5 minutes; bump with `--timeout 600` if needed.

**Don't run `zlib-login` proactively.** It needs human interaction and a visible window;
only invoke it when `retrieve` has explicitly said auth expired.

### Exit codes

`5` = source needs login or is unavailable (suggest `zlib-login` if `sourceCode` is
`SOURCE_AUTH_REQUIRED`, otherwise plain retry); `3` = no matching copy found; `2` = bad
flags (needs `--isbn` or `--title`+`--author`).
---

## Add to library

Log a book Kyle has *read* into `data/books.json` (the source of truth for
`/reading-list`). Triggers: *"add X to my reading list"*, *"I just finished X"*.

```bash
shelf add "<title>" "<author>" --json
# optional: --genre SFF|Thriller|Horror|Literary|Nonfiction (inferred if omitted)
#           --sub "a,b"  --blend "a,b"  --why "one-line take"  --dry-run
```

`add` resolves ISBN / year / cover from Open Library, stamps a slug `id`, infers the
genre, and dedup-guards against books already on the shelf. Use `--dry-run` to preview the
resolved entry before writing. If he gives a one-line take on the book, pass it as `--why`.

**After adding, fold the book into the engine** so it's excluded from future
recommendations and shifts his taste centroids:
```bash
shelf fetch && shelf embed && shelf build
shelf export   # sync books.json + recommend.ts into the website, then commit there
```
`fetch` hits Open Library (~90s); skip it if you only need the new book in the exclusion
set and centroids (then just `embed` + `build`). Commit `books.json` + the regenerated
`candidates.json`/`recommendations.json`; the vector cache is git-ignored.

---

## Maintain & inspect

| Task | Command |
|---|---|
| Backfill missing ISBN / year / cover on the library (idempotent) | `shelf enrich` |
| Refresh the unread candidate pool from Open Library (~90s) | `shelf fetch` |
| Re-embed read + candidate text locally (MiniLM; git-ignored cache) | `shelf embed` |
| Rebuild `recommendations.json` (centroids, scores, provenance) | `shelf build` |
| Show his taste profile — genre mix, repeat authors, top sub-genres | `shelf profile --json` |

Pipeline order is always `fetch → embed → build`. On a fresh clone the embedding cache is
absent, so seed-mode `next` and `build` need `embed` run once first. The canonical generic
reference (for non-Claude agents) is `AGENTS.md` at this plugin's root (`${CLAUDE_PLUGIN_ROOT}/AGENTS.md`).

---

## Boundaries

- The engine picks and resolves; you interpret intent and explain results. Don't re-rank
  recommendations by vibe or substitute your own picks.
- Never fabricate a book, ISBN, author, or fact. If unsure of a detail, say less.
- Don't show JSON, scores, or flag names unless he asks — those are internals.
