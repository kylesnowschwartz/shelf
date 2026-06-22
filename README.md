# shelf

A keyless, local reading-recommendation engine. It ranks unread books against the shelf of
books you've read, runs on your own machine (Open Library for candidates, a local MiniLM model
for embeddings), and prints JSON so an agent can drive it. No API keys.

It ships two ways: a Node CLI, and a Claude Code plugin that bundles the CLI plus an agent
driver (the `shelf-skill`).

## Install

### As a Claude Code plugin

```
/plugin marketplace add kylesnowschwartz/shelf
/plugin install shelf@shelf
```

The first `shelf` call installs the engine's node dependencies once, then runs.

### As a CLI (dev clone)

```
git clone https://github.com/kylesnowschwartz/shelf
cd shelf && npm install
npm run shelf -- --help
```

Requires Node >= 23.6 (the `.mjs` commands import a `.ts` model directly, via Node's native
type stripping, so no build step or loader). `retrieve` and `zlib-login` also need the
`playwright-cli` binary on your PATH.

## Owner workflow: where the data lives

`data/books.json` holds the book list, and this is the only repo that writes it. These
commands change it:

- `add`, `enrich` edit `data/books.json`
- `export` copies it into a consumer site

**Run write commands against your own clone, not a cached plugin copy.** A plugin installed
from a remote marketplace lives under `~/.claude/plugins/`, and that copy is overwritten when
the plugin updates, so a book you `add` there is lost on the next update. Two setups that
avoid it:

- Add the marketplace by local path, so the plugin *is* your clone:
  ```
  /plugin marketplace add /path/to/shelf
  ```
- Or treat a remote install as read-only and run `add`/`export` from the clone.

`recommend` and `retrieve` only read the data, so they're safe from any install.

## Usage

```bash
shelf add "Project Hail Mary" "Andy Weir"   # log a book you've read
shelf fetch                                  # pull unread candidates (Open Library)
shelf embed                                  # embed read + candidate text locally (MiniLM)
shelf build                                  # assemble the recommendation artifact
shelf next --mood comforting --max-pages 350 --json
shelf profile --json                         # your taste profile (genre mix, repeat authors)
```

After `add`, re-run `fetch -> embed -> build` to fold the new book into both the exclusion set
and the taste centroids. Generated artifacts (candidates, recommendations, embeddings, and the
z-lib session) live in `.cache/`, which is git-ignored.

Full flag reference, retrieval, and exit codes: see `AGENTS.md`.

## Sync to the website

`shelf export` writes a byte-identical copy of `books.json` into a consumer checkout. Kyle's
site (`kylesnowschwartz.github.io`) renders its "The House" reading-list page from that copy.

```bash
shelf export                          # the conventional sibling website checkout
shelf export --to ../path/to/website  # explicit target (or set $SHELF_WEBSITE_DIR)
```

Then commit the synced file in the website repo to deploy. The sync is one-way (shelf to
website), and the website copy is derived, so don't hand-edit it. The ranking model
(`recommend.ts`) stays internal to this engine and is not exported.

## Tests

```bash
npm test    # vitest; tests live next to their modules in src/
```
