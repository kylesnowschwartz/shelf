// `shelf convert` — turn an ebook file into another format with Calibre's
// `ebook-convert`, which must already be installed (shelf never installs it).
//
// Why it exists: `retrieve` sometimes finds only MOBI or EPUB for a book, and
// the Kindle only shows AZW3 files copied over USB. This command closes that gap.
//
// Behaviour:
//   - Finds `ebook-convert` from $EBOOK_CONVERT, then PATH, then the macOS
//     Calibre app bundle. Exits USAGE with an install hint when none exists.
//   - Skips the conversion when the file already has the target format.
//   - Writes the result next to the input, or into --dest.
//   - With --replace, removes the input file after the output is written.

import { spawn } from 'node:child_process';
import { access, constants, stat, unlink } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';

import { log, emit, fail, EXIT } from './output.mjs';

export const CALIBRE_APP_BINARY = '/Applications/calibre.app/Contents/MacOS/ebook-convert';
const DEFAULT_TARGET = 'azw3';
const SUPPORTED_TARGETS = new Set(['azw3', 'epub', 'mobi', 'pdf']);

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the `ebook-convert` binary. Returns its path, or null when none of
 * the known locations holds an executable file.
 */
export async function findConverter({
  env = process.env,
  isExec = isExecutable,
  appBinary = CALIBRE_APP_BINARY,
} = {}) {
  if (env.EBOOK_CONVERT) {
    return (await isExec(env.EBOOK_CONVERT)) ? env.EBOOK_CONVERT : null;
  }
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'ebook-convert');
    if (await isExec(candidate)) return candidate;
  }
  return (await isExec(appBinary)) ? appBinary : null;
}

/**
 * Decide what a conversion would do. `output` is the file the conversion writes;
 * `needed` is false when the input already has the target format.
 */
export function planConversion(input, to, dest) {
  const inputFormat = extname(input).slice(1).toLowerCase();
  const stem = basename(input, extname(input));
  const outDir = dest ? resolve(dest) : dirname(resolve(input));
  return {
    input: resolve(input),
    inputFormat,
    to,
    output: join(outDir, `${stem}.${to}`),
    needed: inputFormat !== to,
  };
}

function defaultRunner(bin, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ebook-convert exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

export async function run(opts, command) {
  const file = opts.file ?? command?.args?.[0];
  const to = String(opts.to ?? DEFAULT_TARGET).toLowerCase();
  const runner = opts.runner ?? defaultRunner;

  if (!file) fail(EXIT.USAGE, 'convert needs an input file: shelf convert <file>');
  if (!SUPPORTED_TARGETS.has(to)) {
    fail(EXIT.USAGE, `unsupported --to "${to}"; use one of: ${[...SUPPORTED_TARGETS].join(', ')}`);
  }
  try {
    await stat(file);
  } catch {
    fail(EXIT.USAGE, `input file not found: ${file}`);
  }

  const plan = planConversion(file, to, opts.dest);
  if (!plan.needed) {
    emit({ converted: false, reason: `already ${to}`, ...plan }, opts, (d) => `skipped: ${d.input} is already ${to}`);
    return;
  }

  const converter = await findConverter(opts.finder ?? {});
  if (!converter) {
    fail(
      EXIT.USAGE,
      'ebook-convert not found. Install Calibre (brew install --cask calibre) or set EBOOK_CONVERT to its path.',
    );
  }

  if (opts.dryRun) {
    emit({ converted: false, dryRun: true, converter, ...plan }, opts, (d) => `would convert ${d.input} -> ${d.output}`);
    return;
  }

  log(`converting ${basename(plan.input)} (${plan.inputFormat} -> ${to})`);
  try {
    await runner(converter, [plan.input, plan.output]);
  } catch (err) {
    fail(EXIT.NETWORK, `conversion failed: ${err.message}`);
  }

  const { size } = await stat(plan.output);
  let replaced = false;
  if (opts.replace && plan.output !== plan.input) {
    await unlink(plan.input);
    replaced = true;
  }

  emit(
    { converted: true, converter, ...plan, sizeBytes: size, replaced },
    opts,
    (d) => `converted: ${d.output} (${d.sizeBytes} bytes)${d.replaced ? `; removed ${d.input}` : ''}`,
  );
}
