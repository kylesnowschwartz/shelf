// `shelf export` — publish the shelf-owned data into a consumer website
// checkout. The shelf repo OWNS books.json; the website keeps a committed copy
// it renders "The House" from. This command is the one-way sync: shelf →
// website. It never reads from the website, so the website copy can't drift
// back into the source of truth.
//
// books.json is written THROUGH the shared serializer so the website's copy is
// byte-identical to the original (and so it satisfies the website's Zod
// build-gate without reformatting). The ranking model (recommend.ts) is NOT
// exported — it's internal to this engine; the website never used it.
import { writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readBooks, serializeBooks } from './books-io.mjs';
import { ROOT } from './paths.mjs';
import { log, emit, fail, EXIT, color } from './output.mjs';

// --to flag wins, then $SHELF_WEBSITE_DIR, then the conventional sibling repo.
function resolveTarget(opts) {
  const raw = opts.to || process.env.SHELF_WEBSITE_DIR || join(ROOT, '..', 'kylesnowschwartz.github.io');
  return resolve(raw);
}

const exists = (p) => access(p).then(() => true, () => false);

export async function run(opts) {
  const target = resolveTarget(opts);
  const booksDest = join(target, 'src', 'data', 'books.json');

  // Fail loudly if the target isn't a checkout shaped like the website — better
  // than silently scattering files into the wrong directory.
  const dataDir = join(target, 'src', 'data');
  if (!(await exists(dataDir)))
    fail(EXIT.USAGE, `export target does not look like the website checkout: missing ${dataDir}`, { target });

  const booksJson = serializeBooks(await readBooks());
  const wrote = [{ what: 'books.json', dest: booksDest, bytes: Buffer.byteLength(booksJson) }];

  if (!opts.dryRun) {
    await writeFile(booksDest, booksJson);
    log(color.accent(`  ✓ exported books.json → ${target}`));
    log(color.dim('  ↳ commit the synced file in the website repo to deploy'));
  } else {
    log(color.dim(`  (dry run — would write to ${target})`));
  }

  emit({ exported: !opts.dryRun, target, wrote }, opts, (d, plain) =>
    plain
      ? d.wrote.map((w) => `${w.what}\t${w.dest}\t${w.bytes}`).join('\n')
      : `${d.exported ? 'exported' : 'would export'} → ${d.target}\n` +
        d.wrote.map((w) => `  ${w.what} (${w.bytes} bytes) → ${w.dest}`).join('\n'),
  );
}
