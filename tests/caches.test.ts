import { link } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { currentCacheEnv, listCaches, type CacheEnv } from '../src/caches.js';
import type { CacheEntry, Category } from '../src/types.js';
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

/**
 * The screening, done where the entry is *produced*.
 *
 * The bug these pin: a first run against a real 133 GB tree offered `pnpm store 7.5G`,
 * preselected it, promised `18.5G` in the total — and then `clean.ts` refused the prune,
 * correctly, because 31 `node_modules` on the machine still hardlinked into the store. The
 * user was promised 18.5G and would have got ~11G. Nothing was ever at risk; what was at
 * risk was the user's willingness to believe the next refusal.
 *
 * So the same question `cli.ts` asks at the deletion boundary is asked here, before the row
 * is offered. Both remain: the one here is about honesty, the one there is about safety.
 */
describe('listCaches — screening the package store before it is offered', () => {
  const STORE_TREE = {
    'home/Library/pnpm/store/files/aa/blob': file('p', { size: 8192 }),
    'home/.npm/_cacache/index-v5/aa/blob': file('n', { size: 2048 }),
    'home/.gradle/caches/modules-2/blob': file('g', { size: 2048 }),
  } as const;

  it('marks the store blocked, with a reason, when something still hardlinks into it', async () => {
    const f = await tree({ ...STORE_TREE });

    const entries = await listCaches(envFor(f, 'darwin'), { probeStore: async () => true });
    const store = entryFor(entries, 'pnpm-store');

    expect(store.blocked).toBeDefined();
    expect(store.blocked?.reason.length).toBeGreaterThan(0);
    // The reason has to name the machine-wide fact, because that is what the user would
    // have to act on: the fix is to remove a `node_modules` elsewhere, not to re-run.
    expect(store.blocked?.reason.toLowerCase()).toContain('node_modules');
    expect(store.blocked?.reason.toLowerCase()).toContain('hardlink');
  });

  it('leaves it unblocked when nothing on the machine links into it', async () => {
    const f = await tree({ ...STORE_TREE });

    const entries = await listCaches(envFor(f, 'darwin'), { probeStore: async () => false });
    const store = entryFor(entries, 'pnpm-store');

    // Absent, not `undefined`: `'blocked' in entry` has to read truthfully.
    expect('blocked' in store).toBe(false);
  });

  it('still lists a blocked store, at its real size — it exists and it occupies disk', async () => {
    const f = await tree({ ...STORE_TREE });

    const entries = await listCaches(envFor(f, 'darwin'), { probeStore: async () => true });
    const store = entryFor(entries, 'pnpm-store');

    expect(store.path).toBe(f.path('home', 'Library', 'pnpm', 'store'));
    expect(store.bytes).toBeGreaterThanOrEqual(8192);
  });

  it('blocks when the probe itself throws, rather than assuming the store is free', async () => {
    const f = await tree({ ...STORE_TREE });

    const entries = await listCaches(envFor(f, 'darwin'), {
      probeStore: async () => {
        throw new Error('permission denied');
      },
    });

    expect(entryFor(entries, 'pnpm-store').blocked).toBeDefined();
  });

  it('probes the store and nothing else', async () => {
    // Every other cache is self-contained. Walking a 20 GB Gradle cache to learn a fact
    // that cannot apply to it would make every scan slower for no answer at all.
    const f = await tree({ ...STORE_TREE });
    const probed: string[] = [];

    const entries = await listCaches(envFor(f, 'darwin'), {
      probeStore: async (storePath) => {
        probed.push(storePath);
        return false;
      },
    });

    expect(probed).toEqual([f.path('home', 'Library', 'pnpm', 'store')]);
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      if (entry.id !== 'pnpm-store') expect(entry.blocked).toBeUndefined();
    }
  });

  it('screens with the real filesystem when no probe is injected', async () => {
    // The default is the shipped behaviour. A default nothing exercises is a default that
    // can be replaced with `async () => false` without a single test noticing.
    const f = await tree({ ...STORE_TREE });
    const blob = f.path('home', 'Library', 'pnpm', 'store', 'files', 'aa', 'blob');

    const clear = await listCaches(envFor(f, 'darwin'));
    expect(entryFor(clear, 'pnpm-store').blocked).toBeUndefined();

    await link(blob, f.path('home', 'project-node_modules-copy'));

    const linked = await listCaches(envFor(f, 'darwin'));
    expect(entryFor(linked, 'pnpm-store').blocked).toBeDefined();
  });
});

/**
 * The note is a claim about *this run*, so it cannot be a constant.
 *
 * The shipped string was "hardlink target for project node_modules — those are trashed
 * first". That describes `aggressive`. Under the default `recommended` preset the `deps`
 * category is excluded, so no `node_modules` is trashed at all — which is precisely why the
 * prune then gets refused. The note was not merely vague; it named the reason the prune
 * would succeed, in the one preset where that reason does not hold.
 */
describe('listCaches — what the store’s note claims about the run', () => {
  const STORE = { 'home/Library/pnpm/store/files/aa/blob': file('p', { size: 4096 }) } as const;

  const RECOMMENDED = new Set<Category>(['build', 'cache']);
  const AGGRESSIVE = new Set<Category>(['build', 'deps', 'cache']);

  async function noteFor(
    f: Fixture,
    categories: ReadonlySet<Category> | undefined,
    referenced: boolean,
  ): Promise<string> {
    const entries = await listCaches(envFor(f, 'darwin'), {
      ...(categories === undefined ? {} : { categories }),
      probeStore: async () => referenced,
    });
    return entryFor(entries, 'pnpm-store').note;
  }

  it('never claims node_modules are trashed under a preset that does not trash them', async () => {
    const f = await tree({ ...STORE });
    const note = await noteFor(f, RECOMMENDED, true);

    expect(note).toContain('does not trash node_modules');
    // The exact wording that was false: `recommended` excludes `deps`, so nothing is
    // "trashed first" and the store's fate has nothing to do with the order of anything.
    expect(note).not.toContain('trashed first');
    expect(note).not.toContain('trashes those first');
  });

  it('says what aggressive actually does — trashes them, and the store still stays', async () => {
    const f = await tree({ ...STORE });
    const note = await noteFor(f, AGGRESSIVE, true);

    expect(note).toContain('trashes those first');
    // The half the old note left out, and the reason it read as a promise: trashing is a
    // rename (invariant 4), so a trashed `node_modules` keeps its links into the store.
    expect(note.toLowerCase()).toContain('hardlink');
    expect(note).toContain('store stays');
  });

  it('claims nothing about a preset when the caller named none', async () => {
    const f = await tree({ ...STORE });
    const note = await noteFor(f, undefined, true);

    expect(note).toContain('store stays');
    expect(note).not.toContain('trashes those first');
    expect(note).not.toContain('does not trash node_modules');
  });

  it('says so when the store can in fact be pruned', async () => {
    const f = await tree({ ...STORE });

    for (const categories of [RECOMMENDED, AGGRESSIVE, undefined]) {
      const note = await noteFor(f, categories, false);
      expect(note).toContain('nothing on this machine still links into it');
      expect(note).not.toContain('store stays');
    }
  });

  it('still names the hardlink relationship, whatever the run', async () => {
    const f = await tree({ ...STORE });

    for (const referenced of [true, false]) {
      for (const categories of [RECOMMENDED, AGGRESSIVE, undefined]) {
        expect((await noteFor(f, categories, referenced)).toLowerCase()).toContain('hardlink');
      }
    }
  });
});

/**
 * A refusal a user cannot act on reads as the tool being broken.
 *
 * The shipped refusal was "node_modules elsewhere on this machine still hardlink into it …
 * so pruning it would orphan those links". True, and the verdict behind it is invariant 5
 * working exactly as designed — but a user who had selected 7.5 G of pnpm store read the
 * short form of it on the confirmation screen and replied "why?". It says which rule fired.
 * It does not say how many, and it does not say what to do.
 *
 * Both halves are added here, and both are worded to stay *true* under the thing that makes
 * this hard: the probe's fact is machine-wide (some file under the store has a link count
 * above one, wherever its other name lives) while the count is scoped to the roots that were
 * walked. They are stated side by side, attributed, rather than merged into one claim
 * neither can support.
 */
describe('listCaches — a store refusal the user can act on', () => {
  const STORE = { 'home/Library/pnpm/store/files/aa/blob': file('p', { size: 4096 }) } as const;
  const RECOMMENDED_CATEGORIES = new Set<Category>(['build', 'cache']);
  const AGGRESSIVE_CATEGORIES = new Set<Category>(['build', 'deps', 'cache']);

  async function storeFor(
    f: Fixture,
    options: { found?: number; categories?: ReadonlySet<Category>; referenced?: boolean } = {},
  ): Promise<CacheEntry> {
    const entries = await listCaches(envFor(f, 'darwin'), {
      ...(options.found === undefined ? {} : { nodeModulesFound: options.found }),
      ...(options.categories === undefined ? {} : { categories: options.categories }),
      probeStore: async () => options.referenced ?? true,
    });
    return entryFor(entries, 'pnpm-store');
  }

  it('says how many node_modules the scan found, and whose count it is', async () => {
    const f = await tree({ ...STORE });
    const store = await storeFor(f, { found: 31 });

    expect(store.blocked?.reason).toContain('31 node_modules found in this scan');
    expect(store.note).toContain('31 found in this scan');
  });

  it('states no count when the scan supplied none, rather than inventing a zero', async () => {
    const f = await tree({ ...STORE });

    for (const found of [undefined, 0]) {
      const store = await storeFor(f, found === undefined ? {} : { found });

      // A store the probe reports as held is held by *something*. "0 node_modules" beside it
      // would be a contradiction; the uncounted wording already says "elsewhere".
      expect(store.blocked?.reason).not.toContain('0 node_modules');
      expect(store.note).not.toContain('0 found');
      expect(store.blocked?.reason).toContain('node_modules elsewhere on this machine');
    }
  });

  /**
   * The step the interface had never explained, and the reason "just delete node_modules"
   * does not work: trashing is a rename (invariant 4), so a `node_modules` in the Trash
   * still holds every hardlink it held before. Advice that stops at "clean node_modules"
   * sends the user round the loop to be refused a second time for a reason nobody told them.
   */
  it('names emptying the Trash as a step, and says why it is one', async () => {
    const f = await tree({ ...STORE });
    const reason = (await storeFor(f, { found: 31 })).blocked?.reason ?? '';

    expect(reason).toContain('clean node_modules');
    expect(reason).toContain('empty the Trash');
    expect(reason).toContain('a trashed node_modules keeps its hardlinks');
    expect(reason).toContain('pruned on the next run');
  });

  it('gives the same advice whatever the preset, since the fix does not depend on it', async () => {
    const f = await tree({ ...STORE });
    const reasons = await Promise.all(
      [RECOMMENDED_CATEGORIES, AGGRESSIVE_CATEGORIES, undefined].map(async (categories) =>
        (await storeFor(f, { found: 31, ...(categories === undefined ? {} : { categories }) }))
          .blocked?.reason,
      ),
    );

    expect(new Set(reasons).size).toBe(1);
    for (const reason of reasons) expect(reason).toContain('empty the Trash');
  });

  it('says nothing to act on when there is nothing to act on', async () => {
    const f = await tree({ ...STORE });
    const store = await storeFor(f, { found: 31, referenced: false });

    // Unblocked. Advice attached to a row that is not refused is noise, and the count is
    // beside the point once nothing links into the store.
    expect('blocked' in store).toBe(false);
    expect(store.note).toContain('nothing on this machine still links into it');
    expect(store.note).not.toContain('empty the Trash');
  });

  it('adds the Trash step to the note of the one preset that trashes node_modules', async () => {
    const f = await tree({ ...STORE });

    const aggressive = await storeFor(f, { found: 31, categories: AGGRESSIVE_CATEGORIES });
    // `aggressive` does trash them — and the old note stopped there, which reads as a
    // promise that this run frees the store. It does not: the links go to the Trash intact.
    expect(aggressive.note).toContain('trashes those first');
    expect(aggressive.note).toContain('store stays until you empty the Trash');
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
