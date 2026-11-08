// End-to-end tests for `shelf retrieve`'s run(): the source backend and the
// ISBN lookup services are stubbed, so nothing touches the network. Exit codes
// are observed by making process.exit throw.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./retrieve/sources/zlib.mjs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  search: vi.fn(),
  download: vi.fn(),
}));
vi.mock('./sources.mjs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  lookupIsbn: vi.fn(),
  lookupIsbnGoogle: vi.fn(),
}));

import { run } from './cmd-retrieve.mjs';
import * as zlib from './retrieve/sources/zlib.mjs';
import * as sources from './sources.mjs';

const search = zlib.search as unknown as ReturnType<typeof vi.fn>;
const lookupIsbn = sources.lookupIsbn as unknown as ReturnType<typeof vi.fn>;
const lookupIsbnGoogle = sources.lookupIsbnGoogle as unknown as ReturnType<typeof vi.fn>;

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

let root: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shelf-retrieve-run-'));
  stdout = '';
  stderr = '';
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Exit(code);
  }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    stdout += chunk;
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as never);
  // No Kindle mounted, so delivery would go to --dest.
  vi.stubEnv('SHELF_RETRIEVE_KINDLE_MOUNT', join(root, 'no-kindle'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  search.mockReset();
  lookupIsbn.mockReset();
  lookupIsbnGoogle.mockReset();
  rmSync(root, { recursive: true, force: true });
});

/** Run retrieve and return its exit code, parsed stdout result, and parsed stderr error. */
async function retrieve(opts: Record<string, unknown>) {
  let code = 0;
  try {
    await run({ json: true, dest: join(root, 'out'), ...opts });
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    code = err.code;
  }
  const errorLine = stderr.split('\n').reverse().find((l) => l.startsWith('{"error"'));
  return {
    code,
    result: stdout ? JSON.parse(stdout) : null,
    error: errorLine ? JSON.parse(errorLine).error : null,
  };
}

describe('retrieve --isbn when the source has no copy carrying the isbn', () => {
  beforeEach(() => {
    search.mockResolvedValue({ candidates: [], page: 1, totalPages: 1 });
  });

  it('exits 5 when both ISBN lookup services throw', async () => {
    lookupIsbn.mockRejectedValue(new Error('openlibrary.org 503 after 3 retries'));
    lookupIsbnGoogle.mockRejectedValue(new Error('fetch failed'));
    const { code, error } = await retrieve({ isbn: '9781616952259' });
    expect(code).toBe(5);
    expect(error.code).toBe('NETWORK');
    expect(error.sourceCode).toBe('ISBN_LOOKUP_UNAVAILABLE');
    expect(error.message).toMatch(/ISBN lookup service could not be reached/);
  });

  it('exits 3 when both ISBN lookup services answer with no record', async () => {
    lookupIsbn.mockResolvedValue(null);
    lookupIsbnGoogle.mockResolvedValue(null);
    const { code, error } = await retrieve({ isbn: '9781616952259' });
    expect(code).toBe(3);
    expect(error.code).toBe('NO_DATA');
    expect(error.message).toMatch(/have no title and author/);
  });

  it('searches by the title Google Books resolves when Open Library is down', async () => {
    lookupIsbn.mockRejectedValue(new Error('openlibrary.org 503 after 3 retries'));
    lookupIsbnGoogle.mockResolvedValue({ title: 'Dead Lions', author: 'Mick Herron' });
    search.mockImplementation(async (q: any) => ({
      candidates: q.isbn
        ? []
        : [{ sourceId: 'zlib:1', title: 'Dead Lions', authors: ['Mick Herron'], format: 'epub', sizeBytes: 900_000 }],
      page: 1,
      totalPages: 1,
    }));
    const { code, result } = await retrieve({ isbn: '9781616952259', dryRun: true });
    expect(code).toBe(0);
    expect(result.matchedBy).toBe('title');
    expect(result.picked.sourceId).toBe('zlib:1');
  });
});

describe('retrieve to a mounted Kindle when no AZW3 exists', () => {
  const download = zlib.download as unknown as ReturnType<typeof vi.fn>;
  let kindle: string;
  let documents: string;
  let downloadedPaths: string[];

  const book = (sourceId: string, format: string) => ({
    sourceId,
    title: 'Slough House 4: Spook Street',
    authors: ['Mick Herron'],
    format,
    sizeBytes: 900_000,
    language: 'english',
  });

  beforeEach(() => {
    kindle = join(root, 'kindle');
    documents = join(kindle, 'documents');
    mkdirSync(kindle);
    vi.stubEnv('SHELF_RETRIEVE_KINDLE_MOUNT', kindle);
    downloadedPaths = [];
    download.mockImplementation(async ({ sourceId, destDir }: any) => {
      const format = sourceId.split(':')[1]; // 'zlib:epub' downloads an EPUB
      const path = join(destDir, `download.${format}`);
      writeFileSync(path, `${format} bytes`);
      downloadedPaths.push(path);
      return { path, format, sizeBytes: 10, name: null, transport: 'binary' };
    });
  });

  afterEach(() => download.mockReset());

  /** Search stub: the source holds `candidates`; a search's format filter is honoured for listed formats. */
  const sourceHas = (candidates: any[]) =>
    search.mockImplementation(async (q: any) => ({
      candidates: candidates.filter((c) => !q.extensions || !c.format || q.extensions.includes(c.format)),
      page: 1,
      totalPages: 1,
    }));

  const finder = { env: { EBOOK_CONVERT: '/fake/ebook-convert' }, isExec: async () => true };
  const kindleRun = (opts: Record<string, unknown> = {}) =>
    retrieve({ title: 'Spook Street', author: 'Mick Herron', dest: undefined, finder, ...opts });

  it('downloads the EPUB over the MOBI, converts it, and delivers only the AZW3', async () => {
    sourceHas([book('zlib:mobi', 'mobi'), book('zlib:epub', 'epub')]);
    const conversions: string[][] = [];
    const runner = async (bin: string, args: string[]) => {
      conversions.push([bin, ...args]);
      writeFileSync(args[1], 'azw3 bytes');
    };

    const { code, result } = await kindleRun({ runner });

    expect(code).toBe(0);
    expect(search.mock.calls.map(([q]: any) => q.extensions)).toEqual([['azw3'], ['epub', 'mobi']]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0].sourceId).toBe('zlib:epub');
    expect(conversions).toHaveLength(1);
    expect(conversions[0][0]).toBe('/fake/ebook-convert');
    expect(conversions[0][1]).toMatch(/download\.epub$/);
    expect(result).toMatchObject({
      kind: 'kindle',
      format: 'azw3',
      convertedFrom: 'epub',
      destination: join(documents, 'spook-street.azw3'),
    });
    expect(readdirSync(documents)).toEqual(['spook-street.azw3']);
    expect(readFileSync(result.destination, 'utf8')).toBe('azw3 bytes');
    expect(existsSync(downloadedPaths[0])).toBe(false); // temp EPUB removed
  });

  it('delivers nothing when the conversion fails', async () => {
    sourceHas([book('zlib:epub', 'epub')]);
    const runner = async () => {
      throw new Error('ebook-convert exited with code 1: bad input');
    };

    const { code, error, result } = await kindleRun({ runner });

    expect(code).toBe(5);
    expect(result).toBeNull();
    expect(error.message).toMatch(/conversion failed: .*bad input\. The epub file was not delivered\./);
    expect(existsSync(documents) ? readdirSync(documents) : []).toEqual([]);
    expect(existsSync(downloadedPaths[0])).toBe(false);
  });

  it('fails before downloading when Calibre is not installed', async () => {
    sourceHas([book('zlib:epub', 'epub')]);
    const missing = { env: { EBOOK_CONVERT: '/nowhere/ebook-convert' }, isExec: async () => false };

    const { code, error } = await kindleRun({ finder: missing });

    expect(code).toBe(2);
    expect(error.message).toMatch(/ebook-convert not found.*nothing was downloaded or delivered/);
    expect(download).not.toHaveBeenCalled();
  });

  it('skips conversion when an AZW3 exists', async () => {
    sourceHas([book('zlib:epub', 'epub'), book('zlib:azw3', 'azw3')]);
    const runner = vi.fn();

    const { code, result } = await kindleRun({ runner });

    expect(code).toBe(0);
    expect(search).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    expect(download.mock.calls[0][0].sourceId).toBe('zlib:azw3');
    expect(result.format).toBe('azw3');
    expect(result).not.toHaveProperty('convertedFrom');
    expect(readdirSync(documents)).toEqual(['spook-street.azw3']);
  });

  it('keeps --max-mb on the EPUB/MOBI search', async () => {
    sourceHas([{ ...book('zlib:epub', 'epub'), sizeBytes: 80 * 1024 * 1024 }, book('zlib:mobi', 'mobi')]);
    const runner = async (_bin: string, args: string[]) => writeFileSync(args[1], 'azw3 bytes');

    const { code, result } = await kindleRun({ runner, maxMb: '50' });

    expect(code).toBe(0);
    expect(result.picked.sourceId).toBe('zlib:mobi');
    expect(result.convertedFrom).toBe('mobi');
  });

  it('keeps the title gate on the EPUB/MOBI search', async () => {
    sourceHas([{ ...book('zlib:epub', 'epub'), title: 'The Secret Hours' }]);
    const { code, error } = await kindleRun({ runner: vi.fn() });
    expect(code).toBe(3);
    expect(error.matchCode).toBe('NO_MATCH');
    expect(error.message).toMatch(/^no AZW3 copy, and no EPUB or MOBI to convert/);
    expect(download).not.toHaveBeenCalled();
  });

  it('reports the planned conversion in a dry run without downloading', async () => {
    sourceHas([book('zlib:epub', 'epub')]);
    const { code, result } = await kindleRun({ dryRun: true });
    expect(code).toBe(0);
    expect(result).toMatchObject({ dryRun: true, convertTo: 'azw3' });
    expect(result.picked.sourceId).toBe('zlib:epub');
    expect(download).not.toHaveBeenCalled();
  });

  it('does not search for EPUB or MOBI when --ext azw3 is given explicitly', async () => {
    sourceHas([book('zlib:epub', 'epub')]);
    const { code } = await kindleRun({ ext: 'azw3' });
    expect(code).toBe(3);
    expect(search).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it('converts a candidate with no listed format that downloads as a MOBI', async () => {
    sourceHas([{ ...book('zlib:mobi', 'azw3'), format: null }]);
    const runner = async (_bin: string, args: string[]) => writeFileSync(args[1], 'azw3 bytes');

    const { code, result } = await kindleRun({ runner, ext: 'azw3' });

    expect(code).toBe(0);
    expect(result).toMatchObject({ format: 'azw3', convertedFrom: 'mobi' });
    expect(readdirSync(documents)).toEqual(['spook-street.azw3']);
    expect(existsSync(downloadedPaths[0])).toBe(false);
  });
});

describe('retrieve --source-id to a mounted Kindle', () => {
  const download = zlib.download as unknown as ReturnType<typeof vi.fn>;
  let kindle: string;
  let documents: string;
  let home: string;
  let downloadedPaths: string[];

  beforeEach(() => {
    kindle = join(root, 'kindle');
    documents = join(kindle, 'documents');
    home = join(root, 'home');
    mkdirSync(kindle);
    mkdirSync(home);
    vi.stubEnv('SHELF_RETRIEVE_KINDLE_MOUNT', kindle);
    vi.stubEnv('HOME', home);
    downloadedPaths = [];
    download.mockImplementation(async ({ sourceId, destDir }: any) => {
      const format = sourceId.split(':')[1];
      const path = join(destDir, `download.${format}`);
      writeFileSync(path, `${format} bytes`);
      downloadedPaths.push(path);
      return { path, format, sizeBytes: 10, name: 'Spook Street', transport: 'binary' };
    });
  });

  afterEach(() => download.mockReset());

  const finder = { env: { EBOOK_CONVERT: '/fake/ebook-convert' }, isExec: async () => true };
  const runner = async (_bin: string, args: string[]) => writeFileSync(args[1], 'azw3 bytes');
  const bypass = (sourceId: string, opts: Record<string, unknown> = {}) =>
    retrieve({ sourceId, dest: undefined, finder, runner, ...opts });

  it('converts a downloaded EPUB to AZW3 and delivers only the AZW3', async () => {
    const { code, result } = await bypass('zlib:epub');

    expect(code).toBe(0);
    expect(result).toMatchObject({
      bypassed: true,
      kind: 'kindle',
      format: 'azw3',
      convertedFrom: 'epub',
      destination: join(documents, 'spook-street.azw3'),
    });
    expect(readdirSync(documents)).toEqual(['spook-street.azw3']);
    expect(existsSync(downloadedPaths[0])).toBe(false);
  });

  it('converts a downloaded MOBI too', async () => {
    const { code, result } = await bypass('zlib:mobi');
    expect(code).toBe(0);
    expect(result.convertedFrom).toBe('mobi');
  });

  it('saves the download to ~/Downloads and delivers nothing when Calibre is missing', async () => {
    const missing = { env: { EBOOK_CONVERT: '/nowhere/ebook-convert' }, isExec: async () => false };

    const { code, error } = await bypass('zlib:epub', { finder: missing });

    expect(code).toBe(2);
    expect(error.message).toMatch(/ebook-convert not found.*already downloaded.*not delivered/);
    expect(error.savedTo).toBe(join(home, 'Downloads', 'spook-street.epub'));
    expect(readFileSync(error.savedTo, 'utf8')).toBe('epub bytes');
    expect(existsSync(documents) ? readdirSync(documents) : []).toEqual([]);
    expect(existsSync(downloadedPaths[0])).toBe(false);
  });

  it('delivers nothing when the conversion fails', async () => {
    const failing = async () => {
      throw new Error('ebook-convert exited with code 1: bad input');
    };
    const { code, error } = await bypass('zlib:epub', { runner: failing });
    expect(code).toBe(5);
    expect(error.message).toMatch(/conversion failed.*The epub file was not delivered/);
    expect(existsSync(documents) ? readdirSync(documents) : []).toEqual([]);
  });

  it('delivers a PDF as it is', async () => {
    const conversions = vi.fn();
    const { code, result } = await bypass('zlib:pdf', { runner: conversions });
    expect(code).toBe(0);
    expect(result.format).toBe('pdf');
    expect(result).not.toHaveProperty('convertedFrom');
    expect(conversions).not.toHaveBeenCalled();
  });

  it('keeps an EPUB as it is when --dest is given', async () => {
    const conversions = vi.fn();
    const { code, result } = await bypass('zlib:epub', { dest: join(root, 'out'), runner: conversions });
    expect(code).toBe(0);
    expect(result).toMatchObject({ kind: 'override', format: 'epub' });
    expect(conversions).not.toHaveBeenCalled();
  });
});
