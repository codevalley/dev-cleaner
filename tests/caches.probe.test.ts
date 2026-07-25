/**
 * The incoming-hardlink probe, as a *cost* rather than only as an answer.
 *
 * `storeHasIncomingHardlinks` is what makes the upstream screening possible at all. The
 * boundary check in `cli.ts` could afford a slow answer — it runs once, after the user has
 * already committed. The cache table cannot: it runs during the scan, on the largest
 * directory on the disk, before a single row is shown. A probe that walked the whole store
 * would turn a 7.5 GB store into a second full pass and the screening would quietly be
 * dropped again as "too slow" — which is how the tool ended up promising 18.5G and
 * delivering 11G in the first place.
 *
 * So two properties are pinned here, and they are different properties:
 *
 * 1. **It finds a link wherever it is.** A probe that only looked at the top level would
 *    report a real store — which is nothing but nested directories — as clear, and clear is
 *    the direction that orphans links.
 * 2. **It stops at the first one.** This is invisible in the return value: every correct
 *    implementation, early-exiting or exhaustive, answers `true`. The only way to state it
 *    as a test is to count the syscalls, which is why this file mocks `node:fs/promises`
 *    and lives apart from `caches.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * Hoisted above the `vi.mock` factory, which vitest lifts above the imports. A plain
 * `const` declared below would still be in its temporal dead zone when the factory runs.
 */
const counts = vi.hoisted(() => ({ lstat: 0, readdir: 0 }));

/**
 * Everything is delegated to the real module — this is instrumentation, not a fake. The
 * fixtures below are built through the same mocked module, so a stubbed-out `lstat` would
 * break the tree before the probe ever saw it.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      counts.lstat += 1;
      return actual.lstat(...args);
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      counts.readdir += 1;
      return (actual.readdir as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { storeHasIncomingHardlinks } from '../src/caches.js';

interface Store {
  root: string;
  store: string;
  cleanup(): Promise<void>;
}

/**
 * A store shaped the way pnpm shapes one: a fan-out of two-character directories, files
 * only at the leaves. `depth` is what makes the difference between "the probe recurses"
 * and "the probe glanced at the top level and found nothing to stat".
 */
async function storeTree(options: {
  dirs: number;
  filesPerDir: number;
  depth?: number;
}): Promise<Store> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dev-cleaner-probe-'));
  const store = path.join(root, 'store');
  const depth = options.depth ?? 1;

  for (let d = 0; d < options.dirs; d += 1) {
    const segments = Array.from({ length: depth }, (_, level) => `d${d}-${level}`);
    const directory = path.join(store, 'files', ...segments);
    await mkdir(directory, { recursive: true });
    for (let fileIndex = 0; fileIndex < options.filesPerDir; fileIndex += 1) {
      await writeFile(path.join(directory, `blob${fileIndex}`), `${d}:${fileIndex}`);
    }
  }
  await mkdir(path.join(root, 'elsewhere'), { recursive: true });

  return {
    root,
    store,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Every regular file under `directory`, deepest-last. */
async function filesUnder(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const found: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    for (const entry of await readdir(next, { withFileTypes: true })) {
      const child = path.join(next, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) found.push(child);
    }
  }
  return found;
}

describe('storeHasIncomingHardlinks — the walk', () => {
  it('finds a hardlinked file however deep in the store it is buried', async () => {
    // Ten levels down, one file, linked from outside. A real store is *entirely* nested
    // like this: nothing but directories sits at its top level, so a probe that did not
    // recurse would call every store on every machine unreferenced — and unreferenced is
    // the answer that orphans links.
    const tree = await storeTree({ dirs: 1, filesPerDir: 1, depth: 10 });
    try {
      expect(await storeHasIncomingHardlinks(tree.store)).toBe(false);

      const [buried] = await filesUnder(tree.store);
      expect(buried).toBeDefined();
      // Ten directories deep, not one.
      expect(path.relative(tree.store, buried as string).split(path.sep)).toHaveLength(12);

      await link(buried as string, path.join(tree.root, 'elsewhere', 'node_modules-copy'));
      expect(await storeHasIncomingHardlinks(tree.store)).toBe(true);
    } finally {
      await tree.cleanup();
    }
  });

  it('stops at the first hardlink it finds instead of counting them all', async () => {
    // Every file is linked, so whichever one the walk reaches first is a hit. An
    // early-exiting probe therefore performs exactly one `lstat`; an exhaustive one
    // performs 120. The assertion is on the syscall count because the *answer* cannot
    // tell the two apart — both are `true`.
    const tree = await storeTree({ dirs: 12, filesPerDir: 10, depth: 2 });
    try {
      const files = await filesUnder(tree.store);
      expect(files).toHaveLength(120);
      for (const [index, file] of files.entries()) {
        await link(file, path.join(tree.root, 'elsewhere', `link${index}`));
      }

      counts.lstat = 0;
      expect(await storeHasIncomingHardlinks(tree.store)).toBe(true);

      expect(counts.lstat).toBe(1);
    } finally {
      await tree.cleanup();
    }
  });

  it('does not read the rest of the store once it has its answer', async () => {
    // The same property one level up: the directories below the hit are never opened
    // either. `find <store> -links +1 -print -quit` returns instantly on a 7.5 GB store
    // for exactly this reason, and the equivalent here has to keep that shape.
    const tree = await storeTree({ dirs: 12, filesPerDir: 10, depth: 2 });
    try {
      for (const [index, file] of (await filesUnder(tree.store)).entries()) {
        await link(file, path.join(tree.root, 'elsewhere', `link${index}`));
      }

      counts.readdir = 0;
      expect(await storeHasIncomingHardlinks(tree.store)).toBe(true);
      const stopped = counts.readdir;

      // For contrast: clearing the same store takes 25 readdirs (the store root, `files`,
      // 12 outer and 12 inner directories) and 120 lstats. The early exit is worth having
      // only if it is genuinely a small fraction of that.
      counts.readdir = 0;
      counts.lstat = 0;
      const clear = await storeTree({ dirs: 12, filesPerDir: 10, depth: 2 });
      try {
        expect(await storeHasIncomingHardlinks(clear.store)).toBe(false);
        expect(counts.lstat).toBe(120);
        expect(stopped).toBeLessThan(counts.readdir);
      } finally {
        await clear.cleanup();
      }
    } finally {
      await tree.cleanup();
    }
  });
});
