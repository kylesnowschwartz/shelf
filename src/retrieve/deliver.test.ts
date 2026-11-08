// Tests for deliver.mjs — pure file ops, fake Kindle mount via env override.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decideDestination, safeFilename, cleanTitle, extractFormat, deliver } from './deliver.mjs';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'shelf-deliver-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('decideDestination', () => {
  it('honors an explicit dest override above everything', () => {
    const r = decideDestination({ destOverride: '/some/abs/dir', env: {}, home: '/h' });
    expect(r).toEqual({ dir: '/some/abs/dir', kind: 'override', mounted: false });
  });

  it('picks the Kindle mount when SHELF_RETRIEVE_KINDLE_MOUNT points at an existing dir', () => {
    const fakeMount = join(tmpRoot, 'fake-kindle');
    mkdirSync(fakeMount);
    const r = decideDestination({
      env: { SHELF_RETRIEVE_KINDLE_MOUNT: fakeMount },
      home: '/h',
    });
    expect(r).toEqual({
      dir: join(fakeMount, 'documents'),
      kind: 'kindle',
      mounted: true,
    });
  });

  it('falls back to ~/Downloads when no mount is present', () => {
    const home = join(tmpRoot, 'home');
    mkdirSync(home);
    const r = decideDestination({
      env: { SHELF_RETRIEVE_KINDLE_MOUNT: join(tmpRoot, 'no-such-mount') },
      home,
    });
    expect(r).toEqual({
      dir: join(home, 'Downloads'),
      kind: 'downloads',
      mounted: false,
    });
  });

  it('does not need a mount when --dest is given (no probe of /Volumes)', () => {
    // We pass a deliberately nonexistent mount default; the override wins, so
    // existsSync never gets called on the bogus path.
    const r = decideDestination({
      destOverride: '/explicit/dir',
      env: {},
      home: '/h',
      mountDefault: '/nope/no/such/path',
    });
    expect(r.kind).toBe('override');
  });
});

describe('safeFilename', () => {
  it('slugifies the title and uses the format extension', () => {
    expect(safeFilename({ title: 'The Way of Kings', format: 'epub' })).toBe('the-way-of-kings.epub');
  });
  it('strips punctuation and trims aggressively', () => {
    expect(safeFilename({ title: "Hitchhiker's Guide!", format: 'epub' })).toBe('hitchhiker-s-guide.epub');
  });
  it('falls back to "book" on empty title', () => {
    expect(safeFilename({ title: '', format: 'mobi' })).toBe('book.mobi');
    expect(safeFilename({ title: undefined, format: 'pdf' })).toBe('book.pdf');
  });
  it('coerces an unknown format to epub (allowlist)', () => {
    expect(safeFilename({ title: 'x', format: 'exe' })).toBe('x.epub');
    expect(safeFilename({ title: 'x', format: '../../etc' })).toBe('x.epub');
  });
  it('lowercases and strips dots from format', () => {
    expect(safeFilename({ title: 'x', format: 'AZW3' })).toBe('x.azw3');
    expect(safeFilename({ title: 'x', format: '.epub' })).toBe('x.epub');
  });
});

describe('cleanTitle', () => {
  it('strips a leading "<Series> N:" prefix', () => {
    expect(cleanTitle('Slough House 4: Spook Street')).toBe('Spook Street');
    expect(cleanTitle('Slough House 9: Clown Town')).toBe('Clown Town');
    expect(cleanTitle('Slough House #4: Spook Street')).toBe('Spook Street');
    expect(cleanTitle('Slough House, Book 4: Spook Street')).toBe('Spook Street');
  });
  it('strips a trailing "(<Series> N)" suffix', () => {
    expect(cleanTitle('London Rules (Slough House 5)')).toBe('London Rules');
    expect(cleanTitle('London Rules (Slough House, #5)')).toBe('London Rules');
    expect(cleanTitle('Spook Street (Slough House 4.5)')).toBe('Spook Street');
  });
  it('leaves titles without series text unchanged', () => {
    expect(cleanTitle('The Way of Kings')).toBe('The Way of Kings');
    expect(cleanTitle('Slow Horses')).toBe('Slow Horses');
  });
  it('keeps a colon that belongs to the real title', () => {
    expect(cleanTitle('Standing by the Wall: The Collected Slough House Novellas')).toBe(
      'Standing by the Wall: The Collected Slough House Novellas',
    );
    expect(cleanTitle('1984: A Novel')).toBe('1984: A Novel');
    expect(cleanTitle('Fahrenheit 451: A Novel')).toBe('Fahrenheit 451: A Novel');
    expect(cleanTitle('Dune: Messiah')).toBe('Dune: Messiah');
  });
  it('keeps a parenthetical that is not "<Series> N"', () => {
    expect(cleanTitle('Dune (2)')).toBe('Dune (2)');
    expect(cleanTitle('Dune (Deluxe Edition)')).toBe('Dune (Deluxe Edition)');
  });
  it('returns the original when stripping would leave nothing', () => {
    expect(cleanTitle('Slough House 4:')).toBe('Slough House 4:');
  });
});

describe('safeFilename with series titles', () => {
  it('names the file from the cleaned title', () => {
    expect(safeFilename({ title: 'Slough House 4: Spook Street', format: 'azw3' })).toBe('spook-street.azw3');
    expect(safeFilename({ title: 'London Rules (Slough House 5)', format: 'azw3' })).toBe('london-rules.azw3');
    expect(safeFilename({ title: 'Slough House 9: Clown Town', format: 'azw3' })).toBe('clown-town.azw3');
    expect(
      safeFilename({ title: 'Standing by the Wall: The Collected Slough House Novellas', format: 'azw3' }),
    ).toBe('standing-by-the-wall-the-collected-slough-house-novellas.azw3');
  });
});

describe('extractFormat', () => {
  it('picks the extension off the basename only', () => {
    expect(extractFormat('/a.b.c/dune.epub')).toBe('epub');
    expect(extractFormat('weird.Name.AZW3')).toBe('azw3');
  });
  it('returns null when there is no extension', () => {
    expect(extractFormat('/path/no-ext')).toBeNull();
  });
});

describe('deliver (end-to-end)', () => {
  it('copies source into the Kindle documents dir and removes the source', async () => {
    const home = join(tmpRoot, 'home');
    mkdirSync(home);
    const fakeMount = join(tmpRoot, 'fake-kindle');
    mkdirSync(fakeMount);
    const source = join(tmpRoot, 'incoming.epub');
    writeFileSync(source, 'fake-epub-bytes');

    const r = await deliver({
      sourcePath: source,
      title: 'The Way of Kings',
      env: { SHELF_RETRIEVE_KINDLE_MOUNT: fakeMount },
      home,
    });

    expect(r.kind).toBe('kindle');
    expect(r.mounted).toBe(true);
    expect(r.destination).toBe(join(fakeMount, 'documents', 'the-way-of-kings.epub'));
    expect(r.format).toBe('epub');
    expect(r.sizeBytes).toBe('fake-epub-bytes'.length);
    expect(existsSync(r.destination)).toBe(true);
    expect(existsSync(source)).toBe(false); // source consumed
  });

  it('falls back to ~/Downloads when no Kindle is mounted', async () => {
    const home = join(tmpRoot, 'home');
    mkdirSync(home);
    const source = join(tmpRoot, 'dune.epub');
    writeFileSync(source, 'x');

    const r = await deliver({
      sourcePath: source,
      title: 'Dune',
      env: { SHELF_RETRIEVE_KINDLE_MOUNT: join(tmpRoot, 'no-such-kindle') },
      home,
    });

    expect(r.kind).toBe('downloads');
    expect(r.mounted).toBe(false);
    expect(r.destination).toBe(join(home, 'Downloads', 'dune.epub'));
  });

  it('uses --dest override when given', async () => {
    const dest = join(tmpRoot, 'custom-dest');
    const source = join(tmpRoot, 'src.epub');
    writeFileSync(source, 'x');
    const r = await deliver({ sourcePath: source, title: 'X', dest });
    expect(r.kind).toBe('override');
    expect(r.destination).toBe(join(dest, 'x.epub'));
  });

  it('delivers under a numbered name when a different book already has the name', async () => {
    const dest = join(tmpRoot, 'dest');
    mkdirSync(dest);
    writeFileSync(join(dest, 'dune.azw3'), 'another book');
    const source = join(tmpRoot, 'src.azw3');
    writeFileSync(source, 'this book');

    const r = await deliver({ sourcePath: source, title: 'Dune', dest });

    expect(r.destination).toBe(join(dest, 'dune-2.azw3'));
    expect(r.reused).toBe(false);
    expect(readFileSync(join(dest, 'dune.azw3'), 'utf8')).toBe('another book');
    expect(readFileSync(r.destination, 'utf8')).toBe('this book');
  });

  it('treats a same-size file with different bytes as a different book', async () => {
    const dest = join(tmpRoot, 'dest');
    mkdirSync(dest);
    writeFileSync(join(dest, 'dune.azw3'), 'aaaa');
    const source = join(tmpRoot, 'src.azw3');
    writeFileSync(source, 'bbbb');

    const r = await deliver({ sourcePath: source, title: 'Dune', dest });

    expect(r.destination).toBe(join(dest, 'dune-2.azw3'));
    expect(readFileSync(join(dest, 'dune.azw3'), 'utf8')).toBe('aaaa');
  });

  it('reuses a byte-identical file instead of writing a second copy', async () => {
    const dest = join(tmpRoot, 'dest');
    mkdirSync(dest);
    writeFileSync(join(dest, 'dune.azw3'), 'another book');
    writeFileSync(join(dest, 'dune-2.azw3'), 'this book');
    const source = join(tmpRoot, 'src.azw3');
    writeFileSync(source, 'this book');

    const r = await deliver({ sourcePath: source, title: 'Dune', dest });

    expect(r.destination).toBe(join(dest, 'dune-2.azw3'));
    expect(r.reused).toBe(true);
    expect(r.sizeBytes).toBe('this book'.length);
    expect(readdirSync(dest).sort()).toEqual(['dune-2.azw3', 'dune.azw3']);
    expect(existsSync(source)).toBe(false);
  });

  it('rejects a missing source file with a clear error', async () => {
    await expect(deliver({ sourcePath: join(tmpRoot, 'nope.epub'), title: 'x' })).rejects.toThrow(
      /source file does not exist/,
    );
  });

  it('rejects calls without sourcePath', async () => {
    await expect(deliver({ title: 'x' } as unknown as Parameters<typeof deliver>[0])).rejects.toThrow(/sourcePath/);
  });
});
