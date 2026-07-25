/**
 * Sizing is the one place where a fast path and a fallback compute the same number by
 * different means, so the tests hold both to the *same* fixture and assert they agree. A
 * suite that only exercised `dirSize` would test whichever path happened to win on the
 * machine running it, and the other could rot undetected until a Windows user hit it.
 *
 * `duSize` and `walkSize` are internals exported for exactly this reason (see src/size.ts).
 */

import { link, lstat } from 'node:fs/promises';
import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultConcurrency, dirSize, duSize, newestMtimeMs, walkSize } from '../src/size.js';
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

/** `du` exists everywhere dev-cleaner is developed; only Windows lacks it. */
const HAS_DU = process.platform !== 'win32';

const KIB = 1024;

describe('defaultConcurrency', () => {
  it('stays within [4, 16] whatever the machine reports', () => {
    const value = defaultConcurrency();
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(4);
    expect(value).toBeLessThanOrEqual(16);
  });

  it('clamps the reported parallelism rather than inventing a number', () => {
    const cores = os.availableParallelism();
    expect(defaultConcurrency()).toBe(Math.min(16, Math.max(4, cores)));
  });

  /**
   * Without the mock this machine's own core count decides whether the clamp is exercised
   * at all — on a 10-core laptop both bounds are untested and a missing clamp ships green.
   */
  it('applies both bounds, on a machine of any size', () => {
    const spy = vi.spyOn(os, 'availableParallelism');
    try {
      spy.mockReturnValue(1);
      expect(defaultConcurrency()).toBe(4);
      spy.mockReturnValue(128);
      expect(defaultConcurrency()).toBe(16);
      spy.mockReturnValue(8);
      expect(defaultConcurrency()).toBe(8);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('dirSize', () => {
  /**
   * Every file is a whole number of 4 KiB blocks and holds real (non-zero) bytes, so
   * apparent size and allocated size coincide and the expected total is exact. Sizes that
   * were not block multiples would make `du`'s block accounting and the walker's differ by
   * filesystem-dependent padding, and the test would be asserting the filesystem rather
   * than the code.
   */
  const known = {
    'proj/target/a.bin': file('a', { size: 64 * KIB }),
    'proj/target/deep/b.bin': file('b', { size: 128 * KIB }),
    'proj/target/deep/nested/c.bin': file('c', { size: 4 * KIB }),
    'proj/target/empty': dir(),
  };
  const KNOWN_BYTES = (64 + 128 + 4) * KIB;

  it('measures a tree of known byte size', async () => {
    const f = await tree(known);
    expect(await dirSize(f.path('proj/target'))).toBe(KNOWN_BYTES);
  });

  it('the du fast path and the walker fallback agree', async () => {
    const f = await tree(known);
    const target = f.path('proj/target');

    const walked = await walkSize(target);
    const du = await duSize(target);

    expect(walked).toBe(KNOWN_BYTES);
    expect(HAS_DU).toBe(true); // otherwise the comparison below is vacuous
    expect(du).toBe(walked);
  });

  it('agrees between paths at every concurrency setting', async () => {
    const f = await tree(known);
    const target = f.path('proj/target');
    for (const concurrency of [1, 4, 64]) {
      expect(await walkSize(target, { concurrency })).toBe(KNOWN_BYTES);
      expect(await dirSize(target, { concurrency })).toBe(KNOWN_BYTES);
    }
  });

  /**
   * The block-aligned fixture above would pass even if the walker summed apparent sizes,
   * because there the two coincide. A 5-byte file is the case that separates them: it
   * occupies a whole block, `du` says so, and a `stat.size` walker would report 5.
   */
  it('the two paths agree on a file smaller than a block', async () => {
    const f = await tree({ 'proj/target/tiny.txt': file('hello') });
    const target = f.path('proj/target');

    const walked = await walkSize(target);
    expect(HAS_DU).toBe(true);
    expect(await duSize(target)).toBe(walked);
    expect(walked).toBeGreaterThan(5);
  });

  it('counts a hardlinked file once, as du does', async () => {
    const f = await tree({
      'proj/target/a.bin': file('a', { size: 64 * KIB }),
    });
    const target = f.path('proj/target');
    await link(f.path('proj/target/a.bin'), f.path('proj/target/same.bin'));

    const walked = await walkSize(target);
    expect(walked).toBe(64 * KIB);
    if (HAS_DU) expect(await duSize(target)).toBe(walked);
  });

  describe('symlinks (invariant 2)', () => {
    /** 4 MiB parked outside the measured directory; following the link would find it. */
    const bait = {
      'bait/huge.bin': file('h', { size: 4096 * KIB }),
      'proj/target/keep.bin': file('k', { size: 64 * KIB }),
      'proj/target/link': symlink('../../bait'),
    };

    it('neither path follows a symlink into a large tree', async () => {
      const f = await tree(bait);
      const target = f.path('proj/target');

      // Sanity: the bait really is huge, and really is reachable through the link.
      expect(await dirSize(f.path('bait'))).toBeGreaterThanOrEqual(4096 * KIB);
      expect((await lstat(f.path('proj/target/link'))).isSymbolicLink()).toBe(true);

      const walked = await walkSize(target);
      const du = await duSize(target);

      expect(walked).toBeGreaterThanOrEqual(64 * KIB);
      expect(walked).toBeLessThan(128 * KIB); // the 4 MiB tree was not counted
      expect(HAS_DU).toBe(true);
      expect(du).toBe(walked);
      expect(await dirSize(target)).toBe(walked);
    });

    it('returns 0 for a symlink handed to it directly', async () => {
      const f = await tree({
        'bait/huge.bin': file('h', { size: 4096 * KIB }),
        'proj/link': symlink('../bait'),
        'proj/home': symlink(os.homedir()),
      });
      expect(await dirSize(f.path('proj/link'))).toBe(0);
      expect(await walkSize(f.path('proj/link'))).toBe(0);
      expect(await dirSize(f.path('proj/home'))).toBe(0);
    });
  });

  it('sizes a regular file by its own allocation', async () => {
    const f = await tree({ 'proj/a.bin': file('a', { size: 64 * KIB }) });
    expect(await dirSize(f.path('proj/a.bin'))).toBe(64 * KIB);
  });

  it('reports 0 for an empty directory', async () => {
    const f = await tree({ 'proj/target': dir() });
    expect(await walkSize(f.path('proj/target'))).toBe(0);
    expect(await dirSize(f.path('proj/target'))).toBe(0);
  });

  it('reports 0 rather than throwing for a directory that is not there', async () => {
    const f = await tree({ 'proj/keep': dir() });
    expect(await dirSize(f.path('proj/gone'))).toBe(0);
    expect(await walkSize(f.path('proj/gone'))).toBe(0);
  });
});

describe('newestMtimeMs', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const old = now - 30 * DAY;
  const older = now - 90 * DAY;

  it('excluding an artifact directory actually excludes its subtree', async () => {
    const f = await tree({
      'proj/src/main.rs': file('fn main() {}', { mtime: old }),
      'proj/README.md': file('#', { mtime: older }),
      'proj/target/debug/deps/app.o': file('o', { mtime: now }),
      'proj/target/CACHEDIR.TAG': file('t', { mtime: now }),
    });

    const withArtifacts = await newestMtimeMs(f.path('proj'), []);
    const sourceOnly = await newestMtimeMs(f.path('proj'), [f.path('proj/target')]);

    expect(withArtifacts).toBeGreaterThan(old + DAY);
    expect(Math.abs(sourceOnly - old)).toBeLessThan(2000);
  });

  it('accepts exclusions relative to the root', async () => {
    const f = await tree({
      'proj/src/main.rs': file('fn main() {}', { mtime: old }),
      'proj/target/app.o': file('o', { mtime: now }),
    });
    expect(Math.abs((await newestMtimeMs(f.path('proj'), ['target'])) - old)).toBeLessThan(2000);
  });

  it('excludes several artifact directories at once', async () => {
    const f = await tree({
      'proj/lib.ts': file('export {}', { mtime: older }),
      'proj/dist/lib.js': file('x', { mtime: now }),
      'proj/node_modules/dep/index.js': file('x', { mtime: now }),
    });
    const excluded = [f.path('proj/dist'), f.path('proj/node_modules')];
    expect(Math.abs((await newestMtimeMs(f.path('proj'), excluded)) - older)).toBeLessThan(2000);
  });

  /**
   * `.git` is object storage, not source. A `git fetch` or `gc` on an untouched repo
   * rewrites it, and counting that would make every fetched-but-unedited project look
   * like it was worked on minutes ago — the exact misreading `newestSourceMs` exists to
   * avoid. Pruned here rather than left to the caller, since the caller passes artifact
   * directories and `.git` is not one.
   */
  it('ignores .git, which changes without any source being edited', async () => {
    const f = await tree({
      'proj/src/main.rs': file('fn main() {}', { mtime: old }),
      'proj/.git/HEAD': file('ref: refs/heads/main', { mtime: now }),
      'proj/.git/objects/ab/cdef': file('x', { mtime: now }),
    });
    expect(Math.abs((await newestMtimeMs(f.path('proj'), [])) - old)).toBeLessThan(2000);
  });

  it('never follows a symlink to find a newer file', async () => {
    const f = await tree({
      'fresh/new.txt': file('new', { mtime: now }),
      'proj/src/main.rs': file('fn main() {}', { mtime: old }),
      'proj/link': symlink('../fresh'),
    });
    expect(Math.abs((await newestMtimeMs(f.path('proj'), [])) - old)).toBeLessThan(2000);
  });

  it('returns 0 when there is nothing readable to measure', async () => {
    const f = await tree({ 'proj/empty': dir() });
    expect(await newestMtimeMs(f.path('proj'), [])).toBe(0);
    expect(await newestMtimeMs(f.path('nope'), [])).toBe(0);
  });

  it('excluding the root itself yields 0', async () => {
    const f = await tree({ 'proj/src/main.rs': file('fn main() {}', { mtime: old }) });
    expect(await newestMtimeMs(f.path('proj'), [f.path('proj')])).toBe(0);
  });
});
