// End-to-end tests for `shelf retrieve`'s run(): the source backend and the
// ISBN lookup services are stubbed, so nothing touches the network. Exit codes
// are observed by making process.exit throw.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
