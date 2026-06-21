// Decide where a retrieved book file should land, and move it there.
//
// Pure file ops. No network. No shell-out. Idempotent: calling deliver()
// twice with the same source is a no-op the second time (source already
// gone). Tested purely with env-overridable mount detection.
//
// Destination resolution (first hit wins):
//   1) explicit --dest argument
//   2) $SHELF_RETRIEVE_KINDLE_MOUNT/documents  (test/dev override)
//   3) /Volumes/Kindle/documents               (mounted Kindle on macOS)
//   4) ~/Downloads                             (fallback)
//
// The "mounted" boolean in the result is the load-bearing signal an agent
// uses to phrase the answer: "landed on your Kindle" vs "left in Downloads,
// plug in and re-deliver later".

import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { slugify } from '../util.mjs';

const KINDLE_MOUNT_DEFAULT = '/Volumes/Kindle';
const KINDLE_DOCUMENTS_SUBDIR = 'documents';

/**
 * Decide where to put the file. Pure function — does not touch disk except
 * for an `existsSync` probe on the mount path.
 *
 * @param {{
 *   destOverride?: string,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   mountDefault?: string,
 * }} [opts]
 * @returns {{
 *   dir: string,
 *   kind: 'override' | 'kindle' | 'downloads',
 *   mounted: boolean,
 * }}
 */
export function decideDestination({
  destOverride,
  env = process.env,
  home = homedir(),
  mountDefault = KINDLE_MOUNT_DEFAULT,
} = {}) {
  if (destOverride) {
    return { dir: destOverride, kind: 'override', mounted: false };
  }
  const mountPath = env.SHELF_RETRIEVE_KINDLE_MOUNT || mountDefault;
  if (mountPath && existsSync(mountPath)) {
    return { dir: join(mountPath, KINDLE_DOCUMENTS_SUBDIR), kind: 'kindle', mounted: true };
  }
  return { dir: join(home, 'Downloads'), kind: 'downloads', mounted: false };
}

/**
 * Compose a safe filename from a title and format. The slug strips
 * everything but [a-z0-9-], capped at 60 chars (matches util.slugify);
 * the extension is allowlisted to a small set we expect Kindle to read.
 * Falsy title falls back to "book", unknown format falls back to "epub".
 */
const ALLOWED_FORMATS = new Set(['epub', 'azw3', 'mobi', 'pdf', 'txt']);

export function safeFilename({ title, format }) {
  const slug = (title && slugify(title)) || 'book';
  const ext = (format || 'epub').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const safeExt = ALLOWED_FORMATS.has(ext) ? ext : 'epub';
  return `${slug}.${safeExt}`;
}

/**
 * Move a retrieved file to its final destination. The source path is
 * removed on success (copy + unlink, not rename, so cross-device moves
 * across /Volumes/* work without EXDEV).
 *
 * @param {{
 *   sourcePath: string,
 *   title?: string,
 *   format?: string,        // e.g. 'epub' — derived from sourcePath if absent
 *   dest?: string,          // explicit destination directory override
 *   env?: object,           // for tests
 *   home?: string,          // for tests
 * }} opts
 * @returns {Promise<{
 *   destination: string,    // absolute path of the final file
 *   kind: 'override' | 'kindle' | 'downloads',
 *   mounted: boolean,
 *   format: string,
 *   sizeBytes: number,
 * }>}
 */
export async function deliver(opts = {}) {
  const { sourcePath } = opts;
  if (!sourcePath) throw new Error('deliver requires sourcePath');
  if (!existsSync(sourcePath)) throw new Error(`source file does not exist: ${sourcePath}`);

  const decision = decideDestination({
    destOverride: opts.dest,
    env: opts.env,
    home: opts.home,
  });
  await mkdir(decision.dir, { recursive: true });

  const format = opts.format || extractFormat(sourcePath) || 'epub';
  const filename = safeFilename({ title: opts.title, format });
  const finalPath = join(decision.dir, filename);

  await copyFile(sourcePath, finalPath);
  const sizeBytes = (await stat(finalPath)).size;
  // Best-effort cleanup of the source — if it's already gone (idempotent
  // re-run) or on a read-only filesystem (unlikely), don't fail delivery.
  try {
    await unlink(sourcePath);
  } catch {
    /* ignore */
  }

  return {
    destination: finalPath,
    kind: decision.kind,
    mounted: decision.mounted,
    format: extractFormat(finalPath) || format,
    sizeBytes,
  };
}

/** '/some/dir/title.epub' → 'epub'; no extension → null */
export function extractFormat(path) {
  if (typeof path !== 'string') return null;
  const m = basename(path).match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : null;
}
