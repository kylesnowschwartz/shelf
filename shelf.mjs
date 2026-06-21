#!/usr/bin/env node
// shelf — a personal reading recommender's deterministic engine.
//
// This CLI is the PICKER: it fetches unread candidate books, embeds them
// locally, and ranks them against your read shelf with diversity + calibration
// re-ranking. It does NOT interpret natural language and does NOT write prose —
// that is the job of the Claude Code plugin that drives it. Output is
// `--json`-primary so an agent can consume it. No API keys, ever.
//
// Pipeline:  shelf fetch → shelf embed → shelf build → shelf next
import { Command } from 'commander';
import { EXIT } from './src/output.mjs';

const program = new Command();

program
  .name('shelf')
  .description('Deterministic reading-recommendation engine (agent-driven; --json primary).')
  .version('0.1.0', '-V, --version', 'print version and exit')
  .option('--json', 'machine-readable JSON output (default when stdout is piped)')
  .option('--plain', 'compact, script-friendly output')
  .showHelpAfterError('(add --help for usage)');

// Lazy-load each command's implementation so `--help` stays instant and a
// heavy dependency (the embedding model) only loads for the command that needs it.
const lazy = (mod, fn) => async (...args) => {
  const command = args[args.length - 1];
  const opts = command.optsWithGlobals();
  const m = await import(mod);
  await m[fn](opts, command);
};

program
  .command('fetch')
  .description('fetch unread candidate books from Open Library (+ Google Books, best-effort)')
  .option('--limit <n>', 'max candidates to keep', '400')
  .option('--source <list>', 'comma list: openlibrary,googlebooks', 'openlibrary,googlebooks')
  .option('--dry-run', 'show what would be fetched; write nothing')
  .addHelpText('after', '\nExample:\n  $ shelf fetch --limit 300\n  $ shelf fetch --dry-run --json')
  .action(lazy('./src/cmd-fetch.mjs', 'run'));

program
  .command('add')
  .description('add a book to the read shelf (resolves ISBN/year/cover from Open Library)')
  .argument('<title>', 'book title (quote it)')
  .argument('<author>', 'author (quote it)')
  .option('--genre <g>', 'SFF|Thriller|Horror|Literary|Nonfiction (inferred if omitted)')
  .option('--why <text>', 'one-line editorial rationale')
  .option('--sub <list>', 'comma list of sub-genres')
  .option('--blend <list>', 'comma list of cross-genre blends')
  .option('--dry-run', 'resolve and show the entry; write nothing')
  .addHelpText('after', '\nExample:\n  $ shelf add "Project Hail Mary" "Andy Weir" --genre SFF --sub "Hard SF" --why "..."')
  .action(lazy('./src/cmd-add.mjs', 'run'));

program
  .command('enrich')
  .description('fill missing ISBN / publish-year / cover on books.json from Open Library (idempotent)')
  .option('--dry-run', 'look up but do not write')
  .addHelpText('after', '\nExample:\n  $ shelf enrich')
  .action(lazy('./src/cmd-enrich.mjs', 'run'));

program
  .command('embed')
  .description('embed read + candidate text locally (MiniLM); cache vectors')
  .option('--force', 're-embed even if cached')
  .addHelpText('after', '\nExample:\n  $ shelf embed')
  .action(lazy('./src/cmd-embed.mjs', 'run'));

program
  .command('build')
  .description('assemble the recommendation artifact (centroids, scores, features)')
  .option('--dry-run', 'compute but do not write recommendations.json')
  .addHelpText('after', '\nExample:\n  $ shelf build')
  .action(lazy('./src/cmd-build.mjs', 'run'));

program
  .command('next')
  .description('rank and emit recommendations (the product; --json primary)')
  .option('--like <ids>', 'comma list of read-book ids to seed an ad-hoc profile')
  .option('--mood <m>', 'dark | comforting')
  .option('--novelty <n>', 'familiar | adventurous')
  .option('--genre <list>', 'keep only these genres, e.g. Literary,Nonfiction')
  .option('--not-genre <list>', 'exclude these genres, e.g. SFF,Horror')
  .option('--adult', 'exclude juvenile / YA candidates')
  .option('--english', 'exclude likely non-English editions')
  .option('--max-pages <n>', 'hard cap on page count')
  .option('--era <range>', 'publish-year range, e.g. 2000- or -1980 or 1990-2010')
  .option('--count <n>', 'how many to return', '5')
  .option('--strict', 'drop items that violate a hard filter instead of flagging them')
  .option('--seed <n>', 're-roll: same seed reproduces the list, a different seed reshuffles near-ties', '1')
  .addHelpText('after', '\nExamples:\n  $ shelf next --mood comforting --max-pages 350 --json\n  $ shelf next --not-genre SFF,Horror --json\n  $ shelf next --like the-blade-itself,dune --count 8')
  .action(lazy('./src/cmd-next.mjs', 'run'));

program
  .command('profile')
  .description('print the taste profile (genre histogram, centroids) — auditing aid')
  .action(lazy('./src/cmd-profile.mjs', 'run'));

program
  .command('export')
  .description('sync the shelf-owned data (books.json + recommend.ts) into a consumer website checkout')
  .option('--to <dir>', 'website repo root (overrides $SHELF_WEBSITE_DIR and the default sibling path)')
  .option('--dry-run', 'show what would be written; write nothing')
  .addHelpText('after', '\nExamples:\n  $ shelf export\n  $ shelf export --to ../kylesnowschwartz.github.io\n  $ shelf export --dry-run --json')
  .action(lazy('./src/cmd-export.mjs', 'run'));

program
  .command('retrieve')
  .description('source a book file (by --isbn or --title + --author) and deliver it to /Volumes/Kindle/documents or ~/Downloads')
  .option('--isbn <isbn>', 'preferred identifier; wins over title/author when both are given')
  .option('--title <title>', 'book title (quote it); requires --author')
  .option('--author <author>', 'author name (quote it); requires --title')
  .option('--ext <list>', 'comma-list of acceptable formats (e.g. epub,azw3) — drops everything else')
  .option('--max-mb <n>', 'skip files larger than this (likely OCR scans / audiobook zips)')
  .option('--english', 'drop candidates whose language is explicitly non-English')
  .option('--dest <dir>', 'force destination dir (overrides Kindle-mount detection)')
  .option('--dry-run', 'search + rank only; print candidates without downloading or delivering')
  .option('--source <name>', 'backend source name (forward-compat; currently zlib only)', 'zlib')
  .option('--source-id <id>', 'explicit candidate id (e.g. zlib:19179031); bypasses search + rank — use when --dry-run shows the heuristic picked wrong')
  .addHelpText('after', '\nExamples:\n  $ shelf retrieve --isbn 9780441172719\n  $ shelf retrieve --title "Dune" --author "Frank Herbert" --ext epub,azw3\n  $ shelf retrieve --isbn 9780441172719 --dry-run --json\n  $ shelf retrieve --source-id zlib:19179031 --title "Hatchet"')
  .action(lazy('./src/cmd-retrieve.mjs', 'run'));

program
  .command('zlib-login')
  .description('open a headed browser and persist the z-lib session (run once per ~30 days, or when retrieve reports auth expired)')
  .option('--timeout <s>', 'seconds to wait for the login to complete', '300')
  .addHelpText('after', '\nExamples:\n  $ shelf zlib-login\n  $ shelf zlib-login --timeout 600')
  .action(lazy('./src/cmd-zlib-login.mjs', 'run'));

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${JSON.stringify({ error: { code: 'ERROR', message: err.message } })}\n`);
  process.exit(EXIT.NETWORK);
});
