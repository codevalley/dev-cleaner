import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { currentCacheEnv, listCaches, type CacheEnv } from '../src/caches.js';
import type { CacheEntry } from '../src/types.js';
import { dir, file, fixture, symlink, type Fixture } from './fixture.js';

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

/**
 * A synthetic environment. Every test drives `listCaches` through one of these rather than
 * through the real machine: the table is a claim about three platforms, and the test host
 * is only ever one of them.
 */
function envFor(
  f: Fixture,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): CacheEnv {
  return { platform, home: f.path('home'), env };
}

const pathsOf = (entries: readonly CacheEntry[]): string[] => entries.map((entry) => entry.path).sort();

function entryFor(entries: readonly CacheEntry[], id: string): CacheEntry {
  const found = entries.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no cache entry with id ${id}; got ${entries.map((e) => e.id).join(', ')}`);
  }
  return found;
}

/** Every cache directory the macOS table names, each with something inside it. */
const DARWIN_TREE = {
  'home/Library/pnpm/store/v3/files/00/blob': file('p', { size: 4096 }),
  'home/.npm/_cacache/index-v5/aa/blob': file('n', { size: 2048 }),
  'home/.gradle/caches/modules-2/blob': file('g', { size: 2048 }),
  'home/.cargo/registry/cache/blob': file('c', { size: 2048 }),
  'home/Library/Developer/Xcode/DerivedData/App-abc/blob': file('d', { size: 2048 }),
  'home/Library/Developer/CoreSimulator/Caches/dyld/blob': file('s', { size: 2048 }),
  // Not build output: downloaded runtimes and device state. Must never be offered.
  'home/Library/Developer/CoreSimulator/Devices/UUID/runtime.bin': file('r', { size: 4096 }),
  'home/.pub-cache/hosted/blob': file('u', { size: 2048 }),
  'home/Library/Caches/Yarn/v6/blob': file('y', { size: 2048 }),
  'home/Library/Caches/CocoaPods/Pods/blob': file('k', { size: 2048 }),
} as const;

describe('listCaches — platform resolution', () => {
  it('resolves the macOS table under the home directory', async () => {
    const f = await tree({ ...DARWIN_TREE });
    const home = f.path('home');
    const entries = await listCaches(envFor(f, 'darwin'));

    expect(pathsOf(entries)).toEqual(
      [
        path.join(home, 'Library', 'pnpm', 'store'),
        path.join(home, '.npm', '_cacache'),
        path.join(home, '.gradle', 'caches'),
        path.join(home, '.cargo', 'registry'),
        path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
        path.join(home, 'Library', 'Developer', 'CoreSimulator', 'Caches'),
        path.join(home, '.pub-cache'),
        path.join(home, 'Library', 'Caches', 'Yarn'),
        path.join(home, 'Library', 'Caches', 'CocoaPods'),
      ].sort(),
    );
  });

  it('resolves the Linux table, and omits the macOS-only caches even when those directories exist', async () => {
    const f = await tree({
      ...DARWIN_TREE,
      'home/.local/share/pnpm/store/v3/blob': file('p', { size: 2048 }),
      'home/.cache/yarn/v6/blob': file('y', { size: 2048 }),
    });
    const home = f.path('home');
    const entries = await listCaches(envFor(f, 'linux'));

    expect(pathsOf(entries)).toEqual(
      [
        path.join(home, '.local', 'share', 'pnpm', 'store'),
        path.join(home, '.npm', '_cacache'),
        path.join(home, '.gradle', 'caches'),
        path.join(home, '.cargo', 'registry'),
        path.join(home, '.pub-cache'),
        path.join(home, '.cache', 'yarn'),
      ].sort(),
    );
    // Xcode, CoreSimulator and CocoaPods live on disk in this fixture; the table is keyed
    // on platform, not on what happens to be present.
    for (const entry of entries) expect(entry.path).not.toContain('Library');
  });

  it('resolves the Windows table under LOCALAPPDATA', async () => {
    const f = await tree({
      ...DARWIN_TREE,
      'local/pnpm/store/v3/blob': file('p', { size: 2048 }),
      'local/npm-cache/_cacache/blob': file('n', { size: 2048 }),
      'local/Yarn/Cache/v6/blob': file('y', { size: 2048 }),
      'local/Pub/Cache/hosted/blob': file('u', { size: 2048 }),
    });
    const home = f.path('home');
    const local = f.path('local');
    const entries = await listCaches(envFor(f, 'win32', { LOCALAPPDATA: local }));

    expect(pathsOf(entries)).toEqual(
      [
        path.join(local, 'pnpm', 'store'),
        path.join(local, 'npm-cache'),
        path.join(local, 'Yarn', 'Cache'),
        path.join(local, 'Pub', 'Cache'),
        path.join(home, '.gradle', 'caches'),
        path.join(home, '.cargo', 'registry'),
      ].sort(),
    );
    for (const entry of entries) expect(entry.path).not.toContain('Developer');
  });

  it('falls back to AppData/Local when LOCALAPPDATA is unset', async () => {
    const f = await tree({
      'home/AppData/Local/pnpm/store/v3/blob': file('p', { size: 2048 }),
      'home/.gradle/caches/blob': file('g', { size: 2048 }),
    });
    const entries = await listCaches(envFor(f, 'win32'));

    expect(entryFor(entries, 'pnpm-store').path).toBe(
      path.join(f.path('home'), 'AppData', 'Local', 'pnpm', 'store'),
    );
  });

  it('treats an unrecognised POSIX platform like Linux rather than failing', async () => {
    const f = await tree({
      'home/.npm/_cacache/blob': file('n', { size: 2048 }),
      'home/.cache/yarn/blob': file('y', { size: 2048 }),
    });

    const entries = await listCaches(envFor(f, 'freebsd'));
    expect(pathsOf(entries)).toEqual(
      [path.join(f.path('home'), '.npm', '_cacache'), path.join(f.path('home'), '.cache', 'yarn')].sort(),
    );
  });
});

describe('listCaches — CoreSimulator', () => {
  it('offers only CoreSimulator/Caches, never CoreSimulator itself', async () => {
    const f = await tree({ ...DARWIN_TREE });
    const coreSimulator = path.join(f.path('home'), 'Library', 'Developer', 'CoreSimulator');
    const runtimes = path.join(coreSimulator, 'Devices');
    const entries = await listCaches(envFor(f, 'darwin'));

    expect(pathsOf(entries)).toContain(path.join(coreSimulator, 'Caches'));
    expect(pathsOf(entries)).not.toContain(coreSimulator);

    for (const entry of entries) {
      // Neither CoreSimulator itself nor any ancestor of it may be a delete target, or the
      // downloaded runtimes under Devices/ go with it.
      expect(entry.path).not.toBe(coreSimulator);
      expect(runtimes.startsWith(entry.path + path.sep)).toBe(false);
      expect(entry.path).not.toContain(`${path.sep}Devices`);
      if (entry.path.includes('CoreSimulator')) {
        expect(entry.path.endsWith(path.join('CoreSimulator', 'Caches'))).toBe(true);
      }
    }
  });
});

describe('listCaches — env overrides', () => {
  it('honours CARGO_HOME over ~/.cargo', async () => {
    const f = await tree({
      'cargo/registry/cache/blob': file('c', { size: 2048 }),
      'home/.cargo/registry/cache/blob': file('c', { size: 2048 }),
    });

    const entries = await listCaches(envFor(f, 'darwin', { CARGO_HOME: f.path('cargo') }));
    expect(entryFor(entries, 'cargo-registry').path).toBe(path.join(f.path('cargo'), 'registry'));
    expect(pathsOf(entries)).not.toContain(path.join(f.path('home'), '.cargo', 'registry'));
  });

  it('honours XDG_CACHE_HOME on Linux', async () => {
    const f = await tree({
      'xdg/yarn/v6/blob': file('y', { size: 2048 }),
      'home/.cache/yarn/v6/blob': file('y', { size: 2048 }),
    });

    const entries = await listCaches(envFor(f, 'linux', { XDG_CACHE_HOME: f.path('xdg') }));
    expect(entryFor(entries, 'yarn').path).toBe(path.join(f.path('xdg'), 'yarn'));
    expect(pathsOf(entries)).not.toContain(path.join(f.path('home'), '.cache', 'yarn'));
  });

  it('ignores empty and relative env overrides rather than resolving them against cwd', async () => {
    const f = await tree({
      'home/.cargo/registry/cache/blob': file('c', { size: 2048 }),
      'home/.cache/yarn/v6/blob': file('y', { size: 2048 }),
    });

    const entries = await listCaches(
      envFor(f, 'linux', { CARGO_HOME: '', XDG_CACHE_HOME: 'relative/cache' }),
    );

    expect(entryFor(entries, 'cargo-registry').path).toBe(
      path.join(f.path('home'), '.cargo', 'registry'),
    );
    expect(entryFor(entries, 'yarn').path).toBe(path.join(f.path('home'), '.cache', 'yarn'));
    for (const entry of entries) expect(path.isAbsolute(entry.path)).toBe(true);
  });
});

describe('listCaches — omission', () => {
  it('omits caches that are absent rather than listing them as zero', async () => {
    const f = await tree({
      'home/.npm/_cacache/index-v5/blob': file('n', { size: 4096 }),
      'home/Library/pnpm': dir(),
    });

    const entries = await listCaches(envFor(f, 'darwin'));
    expect(entries.map((entry) => entry.id)).toEqual(['npm-cache']);
    // `~/Library/pnpm` exists but `~/Library/pnpm/store` does not: presence of the parent
    // is not presence of the cache.
    expect(pathsOf(entries)).not.toContain(path.join(f.path('home'), 'Library', 'pnpm', 'store'));
  });

  it('returns an empty list when the home directory holds no caches at all', async () => {
    const f = await tree({ 'home/README.md': 'nothing to clean\n' });
    await expect(listCaches(envFor(f, 'darwin'))).resolves.toEqual([]);
  });

  it('returns an empty list, without throwing, when the home directory does not exist', async () => {
    const f = await tree({ 'placeholder': 'x' });
    await expect(
      listCaches({ platform: 'darwin', home: f.path('no-such-home'), env: {} }),
    ).resolves.toEqual([]);
  });

  it('omits a cache path that is a file rather than a directory', async () => {
    const f = await tree({
      'home/.pub-cache': 'a stray file, not a cache directory\n',
      'home/.npm/_cacache/blob': file('n', { size: 2048 }),
    });

    const entries = await listCaches(envFor(f, 'darwin'));
    expect(entries.map((entry) => entry.id)).toEqual(['npm-cache']);
  });

  it('omits a cache path that is a symlink, since links are never followed (invariant 2)', async () => {
    const f = await tree({
      'elsewhere/yarn/v6/blob': file('y', { size: 4096 }),
      // Relative to the link's own directory, `home/Library/Caches`.
      'home/Library/Caches/Yarn': symlink(path.join('..', '..', '..', 'elsewhere', 'yarn')),
      'home/.npm/_cacache/blob': file('n', { size: 2048 }),
    });

    const entries = await listCaches(envFor(f, 'darwin'));
    expect(entries.map((entry) => entry.id)).toEqual(['npm-cache']);
  });
});

describe('listCaches — entry shape', () => {
  it('populates id, label, note and a size measured from disk', async () => {
    const f = await tree({
      'home/.gradle/caches/modules-2/blob': file('g', { size: 64 * 1024 }),
    });

    const entries = await listCaches(envFor(f, 'darwin'));
    const gradle = entryFor(entries, 'gradle');

    expect(gradle.label.length).toBeGreaterThan(0);
    expect(gradle.note.length).toBeGreaterThan(0);
    expect(path.isAbsolute(gradle.path)).toBe(true);
    // `dirSize` may report allocated blocks rather than apparent size, so it is only ever
    // at least the bytes written.
    expect(gradle.bytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  it('names the pnpm store’s hardlink relationship in its note', async () => {
    const f = await tree({ 'home/Library/pnpm/store/v3/blob': file('p', { size: 2048 }) });
    const entries = await listCaches(envFor(f, 'darwin'));
    expect(entryFor(entries, 'pnpm-store').note.toLowerCase()).toContain('hardlink');
  });

  it('gives every entry a unique id and is stable across calls', async () => {
    const f = await tree({ ...DARWIN_TREE });
    const env = envFor(f, 'darwin');

    const first = await listCaches(env);
    const second = await listCaches(env);

    const ids = first.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);

    const identity = (list: readonly CacheEntry[]) =>
      list.map(({ id, label, path: p, note }) => ({ id, label, path: p, note }));
    expect(identity(second)).toEqual(identity(first));
  });

  it('never lists the same path twice, even when an override collides with a default', async () => {
    const f = await tree({
      'home/.cargo/registry/cache/blob': file('c', { size: 2048 }),
      'home/.npm/_cacache/blob': file('n', { size: 2048 }),
    });

    const entries = await listCaches(envFor(f, 'darwin', { CARGO_HOME: f.path('home', '.cargo') }));
    expect(new Set(pathsOf(entries)).size).toBe(entries.length);
  });
});

describe('currentCacheEnv', () => {
  it('reports the running platform, home directory and process environment', async () => {
    const f = await tree({ 'home/.npm/_cacache/blob': file('n', { size: 1024 }) });
    const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const saved = process.env[homeKey];
    const sentinel = 'dev-cleaner-sentinel-value';

    process.env[homeKey] = f.path('home');
    process.env['DEV_CLEANER_SENTINEL'] = sentinel;
    try {
      const env = currentCacheEnv();
      expect(env.platform).toBe(process.platform);
      expect(env.home).toBe(f.path('home'));
      expect(env.env['DEV_CLEANER_SENTINEL']).toBe(sentinel);
      expect(path.isAbsolute(env.home)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[homeKey];
      else process.env[homeKey] = saved;
      delete process.env['DEV_CLEANER_SENTINEL'];
    }
  });
});
