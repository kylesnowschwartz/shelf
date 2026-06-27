// Tests for the zlib source backend. Pure functions (toCandidate, parseSize,
// parseSourceId, etc.) are exercised directly. The spawn-based functions
// (search, download) are exercised against a real fake binary written to a
// temp dir — more honest than mocking child_process, and the same shape we
// use for end-to-end sanity checks.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, chmodSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  search,
  download,
  toCandidate,
  parseYear,
  parseSize,
  parseRating,
  parseSourceId,
  extractFormat,
  resolveBinary,
  bookIdFromUrl,
  titleFromSuggestedFilename,
  SourceError,
  SOURCE_NAME,
} from './zlib.mjs';

// ─── pure helpers ─────────────────────────────────────────────────────────

describe('toCandidate', () => {
  it('translates a typical zlib Book into a generic Candidate', () => {
    const book = {
      id: '19179031', // numeric attribute id (NOT the one to pass to download)
      url: 'https://z-lib.sk/book/r9bkkbjyzB/dune.html', // path-segment id is what counts
      name: 'Dune',
      authors: ['Frank Herbert'],
      year: '1965',
      extension: 'EPUB',
      size: '1 MB',
      language: 'english',
      rating: '5/5',
      publisher: 'Ace',
      isbn: '9780441172719',
      quality: '4.5',
      cover: 'https://covers.z-lib.sk/x.jpg',
    };
    expect(toCandidate(book)).toEqual({
      sourceId: 'zlib:r9bkkbjyzB',
      title: 'Dune',
      authors: ['Frank Herbert'],
      year: 1965,
      format: 'epub',
      sizeBytes: 1024 * 1024,
      sizeText: '1 MB',
      language: 'english',
      rating: 5,
      publisher: 'Ace',
      isbn: '9780441172719',
      quality: 4.5,
      cover: 'https://covers.z-lib.sk/x.jpg',
    });
  });

  it('tolerates a sparse Book (missing optional fields)', () => {
    const book = { id: 'x', name: 'Unknown' };
    const c = toCandidate(book);
    expect(c.sourceId).toBe('zlib:x');
    expect(c.title).toBe('Unknown');
    expect(c.authors).toEqual([]);
    expect(c.year).toBeNull();
    expect(c.format).toBeNull();
    expect(c.sizeBytes).toBeNull();
    expect(c.language).toBeNull();
    expect(c.rating).toBeNull();
    expect(c.isbn).toBeNull();
    expect(c.quality).toBeNull();
    expect(c.cover).toBeNull();
  });
});

describe('parseYear', () => {
  it('handles real, empty, "0", and non-numeric inputs', () => {
    expect(parseYear('1965')).toBe(1965);
    expect(parseYear('')).toBeNull();
    expect(parseYear('0')).toBeNull();
    expect(parseYear(null)).toBeNull();
    expect(parseYear('forthcoming')).toBeNull();
  });
});

describe('parseSize', () => {
  it('parses common zlib size strings', () => {
    expect(parseSize('1 MB')).toBe(1024 * 1024);
    expect(parseSize('850 KB')).toBe(850 * 1024);
    expect(parseSize('1.5 MB')).toBe(Math.round(1.5 * 1024 * 1024));
    expect(parseSize('12mb')).toBe(12 * 1024 * 1024);
    expect(parseSize('2 GB')).toBe(2 * 1024 ** 3);
  });
  it('returns null for unparseable strings', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('huge')).toBeNull();
    expect(parseSize(undefined)).toBeNull();
    expect(parseSize('1 PB')).toBeNull(); // petabyte unit unknown
  });
});

describe('parseRating', () => {
  it('takes the integer or decimal part before the slash', () => {
    expect(parseRating('5/5')).toBe(5);
    expect(parseRating('4.5/5')).toBe(4.5);
    expect(parseRating('-')).toBeNull();
    expect(parseRating('')).toBeNull();
  });
});

describe('parseSourceId', () => {
  it('round-trips zlib:ID', () => {
    expect(parseSourceId('zlib:abc123')).toBe('abc123');
  });
  it('rejects wrong namespace or empty id', () => {
    expect(() => parseSourceId('other:abc123')).toThrow(SourceError);
    expect(() => parseSourceId('zlib:')).toThrow(SourceError);
    expect(() => parseSourceId('')).toThrow(SourceError);
    expect(() => parseSourceId(null as unknown as string)).toThrow(SourceError);
  });
});

describe('extractFormat', () => {
  it('picks the extension off the path', () => {
    expect(extractFormat('/some/dir/dune.epub')).toBe('epub');
    expect(extractFormat('weird.NAME.AZW3')).toBe('azw3');
    expect(extractFormat('no-extension')).toBeNull();
  });
});

describe('resolveBinary', () => {
  it('honors the env override above everything', () => {
    expect(resolveBinary({ env: { SHELF_RETRIEVE_BIN: '/custom/bin' }, home: '/nope' })).toBe('/custom/bin');
  });
  it('falls back to "zlib" on PATH when nothing else applies', () => {
    expect(resolveBinary({ env: {}, home: '/tmp/no-such-home' })).toBe('zlib');
  });
});

// ─── spawn-based: search / download with a real fake binary ──────────────

/**
 * Write a Node-based fake binary to disk that emulates the `--json` contract
 * of our forked zlib CLI. It dispatches on argv[2] (the subcommand) and emits
 * canned output we can assert against.
 */
function writeFakeBinary(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

// Fake binary for the binary-path tests below. Handles both `search` and
// `download` (download is now the primary transport — see sources/zlib.mjs).
// Behavior is steered by FAKE_* env flags so a single fake covers the success,
// auth-failure, and transport-failure cases.
const FAKE = `
const sub = process.argv[2];
const argv = process.argv.slice(3);
if (sub === 'search') {
  // Echo the query back as a single book so we can assert wiring works.
  const query = argv[0];
  const exts = [];
  for (let i = 1; i < argv.length - 1; i++) {
    if (argv[i] === '--ext') exts.push(argv[i + 1]);
  }
  if (process.env.FAKE_EMPTY === '1') {
    console.log(JSON.stringify({ books: [], page: 1, total_pages: 0 }));
    process.exit(0);
  }
  if (process.env.FAKE_AUTH === '1') {
    process.stderr.write('Not logged in. Run: zlib login\\n');
    process.exit(1);
  }
  const ext = exts[0] ? exts[0].toUpperCase() : 'EPUB';
  console.log(JSON.stringify({
    books: [
      { id: 'fake-1', name: query, authors: ['Test Author'], year: '2020',
        extension: ext, size: '1 MB', language: 'english', rating: '5/5' },
    ],
    page: 1, total_pages: 1,
  }));
  process.exit(0);
}
if (sub === 'download') {
  const id = argv[0];
  let dir = '.';
  for (let i = 1; i < argv.length - 1; i++) {
    if (argv[i] === '--dir') dir = argv[i + 1];
  }
  if (process.env.FAKE_AUTH === '1') {
    process.stderr.write('session expired\\n');
    process.exit(1);
  }
  if (process.env.FAKE_DL_204 === '1') {
    process.stderr.write('download failed: HTTP 204\\n');
    process.exit(1);
  }
  const path = require('node:path');
  const fs = require('node:fs');
  const dest = path.join(dir, 'The Fake Book.epub');
  fs.writeFileSync(dest, Buffer.alloc(12345, 0));
  console.log(JSON.stringify({ id, name: 'The Fake Book', path: dest, size: 12345 }));
  process.exit(0);
}
process.stderr.write('unknown subcommand: ' + sub + '\\n');
process.exit(2);
`;

let tmpRoot: string;
let fakeBin: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shelf-retrieve-test-'));
  fakeBin = writeFakeBinary(tmpRoot, 'zlib-fake', FAKE);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('search (spawn-based)', () => {
  it('queries by ISBN when set and returns one Candidate', async () => {
    const res = await search({ isbn: '9780441172719', bin: fakeBin });
    expect(res.candidates).toHaveLength(1);
    // The fake echoes the query back as the book name → assert we built it right.
    expect(res.candidates[0].title).toBe('9780441172719');
    expect(res.candidates[0].sourceId).toBe('zlib:fake-1');
    expect(res.candidates[0].format).toBe('epub');
    expect(res.candidates[0].sizeBytes).toBe(1024 * 1024);
  });

  it('falls back to title + author concatenation when ISBN absent', async () => {
    const res = await search({ title: 'Dune', author: 'Frank Herbert', bin: fakeBin });
    expect(res.candidates[0].title).toBe('Dune Frank Herbert');
  });

  it('passes --ext through to the binary', async () => {
    const res = await search({ isbn: 'x', extensions: ['azw3'], bin: fakeBin });
    expect(res.candidates[0].format).toBe('azw3');
  });

  it('rejects calls with neither isbn nor title+author', async () => {
    await expect(search({ bin: fakeBin })).rejects.toThrow(SourceError);
    await expect(search({ title: 'Dune', bin: fakeBin })).rejects.toThrow(SourceError); // author missing
  });

  it('classifies a "not logged in" stderr as SOURCE_AUTH_REQUIRED', async () => {
    await expect(
      search({ isbn: 'x', bin: fakeBin, env: { ...process.env, FAKE_AUTH: '1' } }),
    ).rejects.toMatchObject({ code: 'SOURCE_AUTH_REQUIRED' });
  });

  it('handles an empty result set cleanly', async () => {
    const res = await search({ isbn: 'x', bin: fakeBin, env: { ...process.env, FAKE_EMPTY: '1' } });
    expect(res.candidates).toEqual([]);
    expect(res.totalPages).toBe(0);
  });

  it('returns SOURCE_BIN_MISSING when the binary path does not exist', async () => {
    await expect(
      search({ isbn: 'x', bin: '/nope/zlib-does-not-exist' }),
    ).rejects.toMatchObject({ code: 'SOURCE_BIN_MISSING' });
  });
});

// ─── download: now via the playwright driver, mocked at the runner seam ──
//
// The real integration (driver → playwright-cli → z-lib UI → file) was
// verified manually on Hatchet (428,796-byte AZW3, 2.6s click-to-save).
// Here we assert the source-backend layer's translation contract: the
// driver's result shape lands as the documented Candidate-download shape,
// and the driver's error vocabulary maps to the source error vocabulary.

/**
 * Fake runner matching the playwright-cli output the driver expects.
 * Reproduces just enough of the markdown shape to round-trip a JSON Result.
 */
function fakePwRunner(suggestedFilename: string, savedAt: string) {
  return async (_bin: string, args: string[]) => {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === 'cookie-get') {
      return { stdout: 'remix_userid=12345678 (domain: .z-lib.sk, path: /)', stderr: '' };
    }
    if (sub === 'goto') {
      return { stdout: '### Page\nfake\n', stderr: '' };
    }
    if (sub === 'run-code') {
      const body = JSON.stringify({
        path: savedAt,
        suggestedFilename,
        elapsedMs: 2621,
        failure: null,
      });
      return { stdout: `### Result\n${body}\n### Ran Playwright code\n`, stderr: '' };
    }
    throw new Error(`fake pw runner: unhandled ${JSON.stringify(args)}`);
  };
}

// A binary path guaranteed not to exist, so download() fails the binary attempt
// (→ SOURCE_BIN_MISSING, which is not NOT_FOUND) and falls back to the browser.
// This is how the browser-fallback tests below force the secondary transport.
const MISSING_BIN = '/nope/zlib-does-not-exist';

describe('download (browser driver — fallback path)', () => {
  it('returns the saved path, sized from disk, with format extracted from the filename', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
    try {
      const filename = 'Brian Robeson - 01 - Hatchet (Gary Paulsen) (z-library.sk, 1lib.sk, z-lib.sk).azw3';
      const savedAt = join(dest, filename);
      writeFileSync(savedAt, Buffer.alloc(428796, 0));
      const res = await download({
        sourceId: 'zlib:r9bkkbjyzB',
        destDir: dest,
        bin: MISSING_BIN,
        pwRunner: fakePwRunner(filename, savedAt),
      });
      expect(res.path).toBe(savedAt);
      expect(res.sizeBytes).toBe(428796);
      expect(res.format).toBe('azw3');
      // titleFromSuggestedFilename strips the z-lib marketing parenthetical.
      expect(res.name).toBe('Brian Robeson - 01 - Hatchet (Gary Paulsen)');
      expect(res.transport).toBe('browser');
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('rejects an empty or wrong-namespace sourceId before invoking the driver', async () => {
    const runner = fakePwRunner('x.azw3', '/should/not/reach');
    await expect(download({ sourceId: '', destDir: '/tmp', pwRunner: runner })).rejects.toThrow(SourceError);
    await expect(download({ sourceId: 'other:x', destDir: '/tmp', pwRunner: runner })).rejects.toThrow(SourceError);
  });

  it('translates PW_AUTH_REQUIRED into SOURCE_AUTH_REQUIRED', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
    try {
      // Empty cookie-get → driver throws PW_AUTH_REQUIRED before the run-code call.
      const runner = async (_bin: string, args: string[]) => {
        const sub = args.find((a) => !a.startsWith('-'));
        if (sub === 'cookie-get') return { stdout: '', stderr: '' };
        throw new Error('runner reached past auth probe');
      };
      await expect(
        download({ sourceId: 'zlib:abc', destDir: dest, bin: MISSING_BIN, pwRunner: runner }),
      ).rejects.toMatchObject({ code: 'SOURCE_AUTH_REQUIRED' });
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('translates PW_NOT_INSTALLED into SOURCE_BIN_MISSING', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
    try {
      // Real spawn against an impossible playwright-cli binary (binary path also
      // missing, so both transports fail and the browser's error surfaces).
      await expect(
        download({ sourceId: 'zlib:abc', destDir: dest, bin: MISSING_BIN, pwBin: '/nope/playwright-cli' }),
      ).rejects.toMatchObject({ code: 'SOURCE_BIN_MISSING' });
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('translates PW_BOOK_UNAVAILABLE into SOURCE_NOT_FOUND, preserving the reason', async () => {
    // Simulates the DMCA case: cookies fine, page loads, but the script
    // reports `{ unavailable: true, reason: "..." }` because there is no
    // download button. The agent should hear "not found on this source", not
    // "auth required" or "unavailable, retry".
    const dest = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
    try {
      const runner = async (_bin: string, args: string[]) => {
        const sub = args.find((a) => !a.startsWith('-'));
        if (sub === 'cookie-get') {
          return { stdout: 'remix_userid=12345678', stderr: '' };
        }
        if (sub === 'goto') return { stdout: '### Page\nfake\n', stderr: '' };
        if (sub === 'run-code') {
          const body = JSON.stringify({
            unavailable: true,
            reason: "This book isn't available for download due to the complaint of the copyright holder Macmillan",
          });
          return { stdout: `### Result\n${body}\n### Ran Playwright code\n`, stderr: '' };
        }
        throw new Error(`fake runner: unhandled ${JSON.stringify(args)}`);
      };
      await expect(
        download({ sourceId: 'zlib:pqxgMr3aze', destDir: dest, bin: MISSING_BIN, pwRunner: runner }),
      ).rejects.toMatchObject({
        code: 'SOURCE_NOT_FOUND',
        message: expect.stringContaining('copyright holder'),
      });
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('download (binary primary)', () => {
  it('downloads via the binary and does NOT touch the browser', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
    try {
      // pwRunner throws if reached — proves the binary path short-circuits.
      const pwRunner = async () => {
        throw new Error('browser fallback should not have been invoked');
      };
      const res = await download({ sourceId: 'zlib:bin-1', destDir: dest, bin: fakeBin, pwRunner });
      expect(res.transport).toBe('binary');
      expect(res.name).toBe('The Fake Book');
      expect(res.format).toBe('epub');
      expect(res.sizeBytes).toBe(12345);
      expect(res.path).toBe(join(dest, 'The Fake Book.epub'));
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('falls back to the browser when the binary 204s', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
    try {
      const filename = 'Fallback Book (z-library.sk).epub';
      const savedAt = join(dest, filename);
      writeFileSync(savedAt, Buffer.alloc(2048, 0));
      const res = await download({
        sourceId: 'zlib:bin-2',
        destDir: dest,
        bin: fakeBin,
        env: { ...process.env, FAKE_DL_204: '1' },
        pwRunner: fakePwRunner(filename, savedAt),
      });
      expect(res.transport).toBe('browser');
      expect(res.path).toBe(savedAt);
      expect(res.name).toBe('Fallback Book');
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('falls back to the browser when the binary session is expired (auth)', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
    try {
      const filename = 'Auth Fallback.epub';
      const savedAt = join(dest, filename);
      writeFileSync(savedAt, Buffer.alloc(4096, 0));
      const res = await download({
        sourceId: 'zlib:bin-3',
        destDir: dest,
        bin: fakeBin,
        env: { ...process.env, FAKE_AUTH: '1' },
        pwRunner: fakePwRunner(filename, savedAt),
      });
      // Independent sessions: binary auth dead, browser alive → still succeeds.
      expect(res.transport).toBe('browser');
      expect(res.path).toBe(savedAt);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('titleFromSuggestedFilename', () => {
  it('strips the z-lib marketing parenthetical and trailing extension', () => {
    expect(
      titleFromSuggestedFilename('Hatchet (Gary Paulsen) (z-library.sk, 1lib.sk, z-lib.sk).azw3'),
    ).toBe('Hatchet (Gary Paulsen)');
  });
  it('returns the stem when no marketing suffix is present', () => {
    expect(titleFromSuggestedFilename('dune.epub')).toBe('dune');
  });
  it('returns null on falsy or non-string input', () => {
    expect(titleFromSuggestedFilename('')).toBeNull();
    expect(titleFromSuggestedFilename(null as unknown as string)).toBeNull();
  });
});

describe('SOURCE_NAME', () => {
  it('is stable — orchestrator routes on this string', () => {
    expect(SOURCE_NAME).toBe('zlib');
  });
});

describe('bookIdFromUrl', () => {
  it("extracts the URL path-segment id, NOT the numeric Book.id attribute", () => {
    expect(bookIdFromUrl('https://z-lib.sk/book/r9bkkbjyzB/hatchet.html')).toBe('r9bkkbjyzB');
  });
  it('returns null on malformed input', () => {
    expect(bookIdFromUrl('not-a-url')).toBeNull();
    expect(bookIdFromUrl(null as unknown as string)).toBeNull();
    expect(bookIdFromUrl('https://z-lib.sk/some-other-path')).toBeNull();
  });
});
