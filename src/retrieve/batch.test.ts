import { describe, it, expect, vi } from 'vitest';
import { parseBatch, runBatch, singleBookArgs } from './batch.mjs';
import { batchConflicts } from '../cmd-retrieve.mjs';

describe('parseBatch', () => {
  it('skips blank and comment lines, reads ISBNs and Title | Author lines', () => {
    const entries = parseBatch(
      ['# Slough House', '', '9781569476437 Slow Horses', '  978-1-56947-?  ', 'Dead Lions | Mick Herron', '   '].join('\n'),
    );
    expect(entries).toEqual([
      { input: '9781569476437 Slow Horses', isbn: '9781569476437' },
      { input: '978-1-56947-?', error: expect.stringMatching(/neither/) },
      { input: 'Dead Lions | Mick Herron', title: 'Dead Lions', author: 'Mick Herron' },
    ]);
  });

  it('accepts hyphenated ISBN-13, ISBN-10 with X, and CRLF line endings', () => {
    const entries = parseBatch('978-0-441-17271-9\r\n043942089x Goblet\r\n');
    expect(entries.map((e) => e.isbn)).toEqual(['9780441172719', '043942089X']);
  });

  it('marks a title line without an author as an error', () => {
    expect(parseBatch('Slow Horses |')[0].error).toBeTruthy();
    expect(parseBatch('Slow Horses')[0].error).toBeTruthy();
  });
});

describe('singleBookArgs', () => {
  it('passes the shared flags through', () => {
    const args = singleBookArgs(
      { input: 'x', isbn: '9781569476437' },
      { ext: 'azw3', english: true, maxMb: '20', dest: '/tmp/out', dryRun: true, source: 'zlib' },
    );
    expect(args).toEqual([
      '--json', 'retrieve', '--isbn', '9781569476437', '--ext', 'azw3', '--english',
      '--max-mb', '20', '--dest', '/tmp/out', '--dry-run', '--source', 'zlib',
    ]);
  });

  it('sends title and author for a Title | Author line', () => {
    expect(singleBookArgs({ input: 'x', title: 'Dead Lions', author: 'Mick Herron' }, {})).toEqual([
      '--json', 'retrieve', '--title', 'Dead Lions', '--author', 'Mick Herron',
    ]);
  });
});

describe('runBatch', () => {
  const delivered = {
    exitCode: 0,
    result: {
      picked: { title: 'Slow Horses', format: 'azw3', sizeBytes: 900, sourceId: 'zlib:1' },
      destination: '/Volumes/Kindle/documents/slow-horses.azw3',
      format: 'azw3',
      sizeBytes: 1000,
    },
    error: null,
  };

  it('keeps going after a failure and exits 0 when at least one book succeeds', async () => {
    const entries = parseBatch('9781569476437 Slow Horses\nDead Lions | Mick Herron\nnot a book\n9781569478998');
    const retrieveOne = vi
      .fn()
      .mockResolvedValueOnce(delivered)
      .mockResolvedValueOnce({ exitCode: 3, result: null, error: { code: 'NO_DATA', message: 'no candidates' } })
      .mockRejectedValueOnce(new Error('boom'));
    const { output, exitCode } = await runBatch(entries, { ext: 'azw3' }, retrieveOne);

    expect(retrieveOne).toHaveBeenCalledTimes(3); // the unparseable line never reaches retrieve
    expect(retrieveOne.mock.calls[1][0]).toMatchObject({ title: 'Dead Lions', author: 'Mick Herron' });
    expect(retrieveOne.mock.calls[0][1]).toEqual({ ext: 'azw3' });
    expect(output.results.map((r) => r.status)).toEqual(['delivered', 'no-match', 'error', 'error']);
    expect(output.results[0]).toEqual({
      input: '9781569476437 Slow Horses',
      status: 'delivered',
      picked: { title: 'Slow Horses', format: 'azw3', sizeBytes: 1000, sourceId: 'zlib:1' },
      destination: '/Volumes/Kindle/documents/slow-horses.azw3',
      reused: null,
      convertedFrom: null,
      error: null,
    });
    expect(output.results[1]).toMatchObject({
      picked: null,
      destination: null,
      reused: null,
      convertedFrom: null,
      error: 'no candidates',
    });
    expect(output.results[2].error).toMatch(/neither/);
    expect(output.results[3].error).toBe('boom');
    expect(output.summary).toEqual({ delivered: 1, failed: 3 });
    expect(exitCode).toBe(0);
  });

  it('carries convertedFrom, reused and the final destination from the single-book result', async () => {
    const retrieveOne = vi.fn().mockResolvedValue({
      exitCode: 0,
      result: {
        picked: { title: 'Spook Street', format: 'epub', sizeBytes: 900, sourceId: 'zlib:3' },
        destination: '/Volumes/Kindle/documents/spook-street-2.azw3',
        format: 'azw3',
        convertedFrom: 'epub',
        reused: false,
        sizeBytes: 1200,
      },
      error: null,
    });
    const { output } = await runBatch(parseBatch('Spook Street | Mick Herron'), {}, retrieveOne);
    expect(output.results[0]).toEqual({
      input: 'Spook Street | Mick Herron',
      status: 'delivered',
      picked: { title: 'Spook Street', format: 'azw3', sizeBytes: 1200, sourceId: 'zlib:3' },
      destination: '/Volumes/Kindle/documents/spook-street-2.azw3',
      reused: false,
      convertedFrom: 'epub',
      error: null,
    });
  });

  it('reports a reused file', async () => {
    const retrieveOne = vi.fn().mockResolvedValue({
      ...delivered,
      result: { ...delivered.result, reused: true },
    });
    const { output } = await runBatch(parseBatch('9781569476437'), {}, retrieveOne);
    expect(output.results[0]).toMatchObject({ status: 'delivered', reused: true, convertedFrom: null });
  });

  it('reports dry-run rows as successes', async () => {
    const retrieveOne = vi.fn().mockResolvedValue({
      exitCode: 0,
      result: { picked: { title: 'T', format: 'epub', sizeBytes: 5, sourceId: 'zlib:2' }, dryRun: true },
      error: null,
    });
    const { output, exitCode } = await runBatch(parseBatch('9781569476437'), { dryRun: true }, retrieveOne);
    expect(output.results[0]).toMatchObject({ status: 'dry-run', destination: null, error: null });
    expect(output.summary).toEqual({ delivered: 1, failed: 0 });
    expect(exitCode).toBe(0);
  });

  it("exits with the first failure's code when every book fails", async () => {
    const retrieveOne = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 5, result: null, error: { message: 'auth' } })
      .mockResolvedValueOnce({ exitCode: 3, result: null, error: { message: 'none' } });
    const { output, exitCode } = await runBatch(parseBatch('9781569476437\n9781569478998'), {}, retrieveOne);
    expect(output.summary).toEqual({ delivered: 0, failed: 2 });
    expect(exitCode).toBe(5);
  });

  it('runs books one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const retrieveOne = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return delivered;
    });
    await runBatch(parseBatch('9781569476437\n9781569478998\n9781569479926'), {}, retrieveOne);
    expect(maxInFlight).toBe(1);
  });
});

describe('batchConflicts', () => {
  it('flags --isbn, --title and --source-id alongside --batch', () => {
    expect(batchConflicts({ batch: 'f', isbn: '1', title: 'T', sourceId: 'zlib:1' })).toEqual([
      '--isbn',
      '--title',
      '--source-id',
    ]);
  });

  it('allows --batch with only shared flags', () => {
    expect(batchConflicts({ batch: 'f', ext: 'azw3', english: true, dryRun: true, source: 'zlib' })).toEqual([]);
  });
});
