// Tests for `shelf convert`. The real ebook-convert binary is never run: the
// converter finder and the runner are injected.

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConverter, planConversion, convertFile, run, CALIBRE_APP_BINARY } from './cmd-convert.mjs';

describe('findConverter', () => {
  it('prefers $EBOOK_CONVERT when it is executable', async () => {
    const found = await findConverter({
      env: { EBOOK_CONVERT: '/opt/ec', PATH: '/usr/bin' },
      isExec: async (p: string) => p === '/opt/ec',
    });
    expect(found).toBe('/opt/ec');
  });

  it('returns null when $EBOOK_CONVERT points at a missing file', async () => {
    const found = await findConverter({
      env: { EBOOK_CONVERT: '/opt/missing', PATH: '/usr/bin' },
      isExec: async (p: string) => p === '/usr/bin/ebook-convert',
    });
    expect(found).toBeNull();
  });

  it('finds the binary on PATH', async () => {
    const found = await findConverter({
      env: { PATH: '/a:/b' },
      isExec: async (p: string) => p === '/b/ebook-convert',
    });
    expect(found).toBe('/b/ebook-convert');
  });

  it('falls back to the macOS Calibre app bundle', async () => {
    const found = await findConverter({
      env: { PATH: '/a' },
      isExec: async (p: string) => p === CALIBRE_APP_BINARY,
    });
    expect(found).toBe(CALIBRE_APP_BINARY);
  });

  it('returns null when nothing is installed', async () => {
    const found = await findConverter({ env: { PATH: '/a' }, isExec: async () => false });
    expect(found).toBeNull();
  });
});

describe('planConversion', () => {
  it('writes next to the input by default', () => {
    const p = planConversion('/books/persuader.mobi', 'azw3');
    expect(p.output).toBe('/books/persuader.azw3');
    expect(p.needed).toBe(true);
    expect(p.inputFormat).toBe('mobi');
  });

  it('writes into --dest when given', () => {
    expect(planConversion('/books/persuader.mobi', 'azw3', '/out').output).toBe('/out/persuader.azw3');
  });

  it('marks a same-format input as not needed, ignoring extension case', () => {
    expect(planConversion('/books/x.AZW3', 'azw3').needed).toBe(false);
  });
});

describe('run', () => {
  async function tempBook(name: string) {
    const dir = await mkdtemp(join(tmpdir(), 'shelf-convert-'));
    const file = join(dir, name);
    await writeFile(file, 'book');
    return { dir, file };
  }

  const fakeRunner = async (_bin: string, args: string[]) => {
    await writeFile(args[1], 'converted');
  };

  it('converts and keeps the input by default', async () => {
    const { dir, file } = await tempBook('a.mobi');
    await run({ file, runner: fakeRunner, finder: { env: { EBOOK_CONVERT: '/x' }, isExec: async () => true }, json: true });
    expect((await readdir(dir)).sort()).toEqual(['a.azw3', 'a.mobi']);
  });

  it('removes the input with --replace', async () => {
    const { dir, file } = await tempBook('a.mobi');
    await run({ file, replace: true, runner: fakeRunner, finder: { env: { EBOOK_CONVERT: '/x' }, isExec: async () => true }, json: true });
    expect(await readdir(dir)).toEqual(['a.azw3']);
  });

  it('does nothing when the file already has the target format', async () => {
    const { dir, file } = await tempBook('a.azw3');
    let ran = false;
    await run({ file, runner: async () => { ran = true; }, json: true });
    expect(ran).toBe(false);
    expect(await readdir(dir)).toEqual(['a.azw3']);
  });

  it('writes nothing with --dry-run', async () => {
    const { dir, file } = await tempBook('a.mobi');
    await run({ file, dryRun: true, runner: fakeRunner, finder: { env: { EBOOK_CONVERT: '/x' }, isExec: async () => true }, json: true });
    expect(await readdir(dir)).toEqual(['a.mobi']);
  });
});

describe('convertFile', () => {
  async function tempBook(name: string) {
    const dir = await mkdtemp(join(tmpdir(), 'shelf-convert-'));
    const file = join(dir, name);
    await writeFile(file, 'book');
    return { dir, file };
  }

  it('converts with the given converter and reports the output and its size', async () => {
    const { dir, file } = await tempBook('a.epub');
    const calls: string[][] = [];
    const r = await convertFile({
      input: file,
      converter: '/x/ebook-convert',
      runner: async (bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        await writeFile(args[1], 'converted');
      },
    });
    expect(r).toMatchObject({ converted: true, output: join(dir, 'a.azw3'), sizeBytes: 'converted'.length, inputFormat: 'epub' });
    expect(calls).toEqual([['/x/ebook-convert', file, join(dir, 'a.azw3')]]);
  });

  it('throws a usage error when ebook-convert is missing', async () => {
    const { file } = await tempBook('a.epub');
    await expect(convertFile({ input: file, finder: { env: { PATH: '/a' }, isExec: async () => false } })).rejects.toMatchObject({
      code: 'CONVERTER_MISSING',
      exitCode: 2,
      message: expect.stringMatching(/ebook-convert not found/),
    });
  });

  it('throws when ebook-convert fails', async () => {
    const { file } = await tempBook('a.mobi');
    const runner = async () => {
      throw new Error('ebook-convert exited with code 1: bad input');
    };
    await expect(convertFile({ input: file, converter: '/x', runner })).rejects.toMatchObject({
      code: 'CONVERT_FAILED',
      exitCode: 5,
      message: expect.stringMatching(/conversion failed: .*bad input/),
    });
  });
});
