/**
 * Pins three guards in `clean.ts` that are *correct* but **unpinned**.
 *
 * Mutation testing found that each of the three can be broken outright while all 344 tests
 * stay green. That is not a gap in coverage — every one of these lines is executed by the
 * existing suite — it is a gap in *discrimination*: the fixtures only ever build the shape
 * where the guard and its broken form agree. A line that is executed but never
 * distinguished is untested, and the defect class that produces exactly these holes is the
 * one this file exists to close.
 *
 * Each case below constructs the input the existing fixtures never build:
 *
 * 1. **The containment separator.** `contains()` compares against `ancestor + path.sep`.
 *    Every fixture project sits in a directory whose siblings are unrelated names, so
 *    `d.startsWith(a)` — without the separator — answers identically. It stops answering
 *    identically the moment a sibling's name has the root as a *prefix*: `app` and
 *    `app-old`. Then the separator is the only thing standing between "inside the project"
 *    and "some other project entirely".
 * 2. **`node_modules` below the project root.** Invariant 5's hardlink-source detection
 *    reads the artifact's real basename, never its `relPath`. Every fixture puts
 *    `node_modules` directly at a project root, where basename and `relPath` are the same
 *    string — so a `relPath`-based check (the exact thing the module header forbids:
 *    "`relPath` … never gate a decision") passes everything. A pnpm workspace is the
 *    ordinary case that separates them: `mono/packages/api/node_modules`.
 * 3. **Both arms of `isStorePruneTarget`.** It matches by cache id *or* by path shape, and
 *    the comment says the redundancy is deliberate — "renaming an id in `caches.ts` cannot
 *    silently switch the dependency off". Every fixture cache satisfies both arms at once,
 *    which makes each arm individually deletable while the suite stays green, i.e. makes
 *    the deliberate redundancy unenforced. One case here matches only the id, one matches
 *    only the path.
 *
 * Nothing here deletes: the `TrashFn` is injected, as everywhere else in the clean suite.
 * Each describe block also carries a control in the opposite direction, so no case can be
 * satisfied by a `clean` that simply refuses everything.
 */

import { access } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clean, orderTargets } from '../src/clean.js';
import type { CleanOptions } from '../src/clean.js';
import type {
  ActivityScore,
  Artifact,
  CacheEntry,
  CleanTarget,
  Project,
  ProjectType,
  TrashFn,
} from '../src/types.js';
import { file, fixture, type Fixture } from './fixture.js';

const KB = 1024;
const DORMANT: ActivityScore = { status: 'dormant', idleMs: 400 * 86_400_000, reason: 'test' };

let f: Fixture;

beforeAll(async () => {
  f = await fixture({
    // (1) Two sibling projects whose names share a prefix: `app-old` starts with `app`.
    'app/package.json': '{ "name": "app" }\n',
    'app/dist/bundle.js': file('a', { size: KB }),
    'app-old/package.json': '{ "name": "app-old" }\n',
    'app-old/dist/bundle.js': file('o', { size: KB }),

    // (2) A pnpm workspace: the hardlink source is two levels below the project root.
    'mono/package.json': '{ "name": "mono" }\n',
    'mono/pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'mono/dist/bundle.js': file('m', { size: KB }),
    'mono/packages/api/package.json': '{ "name": "@mono/api" }\n',
    'mono/packages/api/node_modules/left-pad/index.js': file('n', { size: 2 * KB }),

    // (3) A project whose node_modules is left behind, plus two store-shaped caches:
    // one recognisable only by its id, one only by its path.
    'proj/package.json': '{ "name": "proj" }\n',
    'proj/node_modules/dep/index.js': file('d', { size: KB }),
    'blobs/content-addressed/aa/deadbeef': file('s', { size: 4 * KB }),
    'caches/pnpm/store/v3/files/aa/deadbeef': file('s', { size: 4 * KB }),
    'caches/npm/_cacache/index-v5/00/aa': file('c', { size: KB }),
  });
});

afterAll(async () => {
  await f?.cleanup();
});

function artifactAt(
  root: string,
  rel: string,
  category: Artifact['category'],
  bytes = KB,
): Artifact {
  return { path: path.join(root, rel), relPath: rel, category, bytes };
}

function projectAt(root: string, name: string, artifacts: Artifact[]): Project {
  return {
    root,
    name,
    types: new Set<ProjectType>(['node']),
    artifacts,
    bytes: artifacts.reduce((sum, a) => sum + a.bytes, 0),
    activity: DORMANT,
  };
}

function cacheAt(id: string, label: string, target: string, bytes = 4 * KB): CacheEntry {
  return { id, label, path: target, bytes, note: 'test cache' };
}

function projectTarget(project: Project, artifact: Artifact): CleanTarget {
  return { kind: 'project', project, artifact };
}

function cacheTarget(cache: CacheEntry): CleanTarget {
  return { kind: 'cache', cache };
}

function recordingTrash(): { trash: TrashFn; trashed: string[] } {
  const trashed: string[] = [];
  const trash: TrashFn = async (paths) => {
    trashed.push(...paths);
  };
  return { trash, trashed };
}

/** Records like `recordingTrash`, but throws for one path — a real-world EPERM. */
function trashFailingOn(failPath: string): { trash: TrashFn; trashed: string[] } {
  const trashed: string[] = [];
  const trash: TrashFn = async (paths) => {
    if (paths.some((candidate) => candidate === failPath)) {
      throw new Error(`EPERM: operation not permitted, rename '${failPath}'`);
    }
    trashed.push(...paths);
  };
  return { trash, trashed };
}

function optionsWith(trash: TrashFn, overrides: Partial<CleanOptions> = {}): CleanOptions {
  return { trash, roots: [f.root], allowedCachePaths: [], unselectedNodeModules: [], ...overrides };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe('invariant 1: containment is separated, not merely prefixed', () => {
  it('refuses a sibling project whose name has the root as a prefix (app-old vs app)', async () => {
    // `<x>/app` and `<x>/app-old` are two different projects. Without the separator,
    // `<x>/app-old/dist`.startsWith(`<x>/app`) is true and the target is accepted as
    // belonging to `app` — a delete inside a project the user never selected. Nothing in
    // the existing fixtures builds a sibling whose name is a prefix of the root, so the
    // separator is free to disappear.
    const app = projectAt(f.path('app'), 'app', []);
    const sibling = f.path('app-old');

    // The fixture must actually exhibit the prefix relation, or this test asserts nothing.
    expect(path.basename(sibling).startsWith(path.basename(app.root))).toBe(true);
    expect(sibling.startsWith(app.root)).toBe(true);
    expect(sibling.startsWith(app.root + path.sep)).toBe(false);

    // A hand-built target, which is exactly what the guard layer exists to catch: the path
    // points into the sibling while `relPath` claims the innocent `dist`.
    const strayDist: Artifact = {
      path: path.join(sibling, 'dist'),
      relPath: 'dist',
      category: 'build',
      bytes: KB,
    };
    app.artifacts = [strayDist];

    const recorder = recordingTrash();
    const [outcome] = await clean(
      [projectTarget(app, strayDist)],
      optionsWith(recorder.trash),
    );

    expect(outcome?.outcome).toBe('refused');
    expect(outcome?.refusal).toBe('outside-project-root');
    expect(recorder.trashed).toEqual([]);
    // The refusal has to have been effective, not merely reported.
    expect(await exists(path.join(sibling, 'dist'))).toBe(true);
  });

  it('still cleans the project’s own dist, so the refusal above is not a blanket one', async () => {
    const app = projectAt(f.path('app'), 'app', []);
    const dist = artifactAt(app.root, 'dist', 'build');
    app.artifacts = [dist];

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(app, dist)], optionsWith(recorder.trash));

    expect(outcome?.outcome).toBe('trashed');
    expect(recorder.trashed).toEqual([dist.path]);
  });
});

describe('invariant 5: node_modules is a hardlink source at any depth', () => {
  const nestedRel = path.join('packages', 'api', 'node_modules');

  it('ranks a workspace node_modules first, even behind another rank-1 target', () => {
    const mono = projectAt(f.path('mono'), 'mono', []);
    const nested = artifactAt(mono.root, nestedRel, 'deps', 2 * KB);
    const dist = artifactAt(mono.root, 'dist', 'build');
    mono.artifacts = [nested, dist];
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('caches/pnpm/store'));

    // The distinguishing input: `relPath` is NOT `node_modules`, only the basename is.
    expect(nested.relPath).not.toBe('node_modules');
    expect(path.basename(nested.path)).toBe('node_modules');

    const nestedTarget = projectTarget(mono, nested);
    const distTarget = projectTarget(mono, dist);
    const storeTarget = cacheTarget(store);

    // Ordered so that a demoted node_modules (rank 1 instead of 0) would land *after*
    // `dist`, which is rank 1 and comes earlier in the input. Putting it last is what
    // makes the rank observable rather than the caller's order.
    const ordered = orderTargets([storeTarget, distTarget, nestedTarget]);

    expect(ordered[0]).toBe(nestedTarget);
    expect(ordered.at(-1)).toBe(storeTarget);
  });

  it('gates the store prune when a workspace node_modules fails to be trashed', async () => {
    // The harm this prevents: `mono/packages/api/node_modules` is still on disk,
    // hardlinking into the store, when the prune would run. Ordering alone does not stop
    // it — `clean` has to *observe* the failure, which it can only do if it recognises the
    // nested directory as a hardlink source in the first place.
    const mono = projectAt(f.path('mono'), 'mono', []);
    const nested = artifactAt(mono.root, nestedRel, 'deps', 2 * KB);
    const dist = artifactAt(mono.root, 'dist', 'build');
    mono.artifacts = [nested, dist];
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('caches/pnpm/store'));

    const recorder = trashFailingOn(nested.path);
    const outcomes = await clean(
      [cacheTarget(store), projectTarget(mono, dist), projectTarget(mono, nested)],
      optionsWith(recorder.trash, { allowedCachePaths: [store.path] }),
    );

    const nestedOutcome = outcomes.find(
      (o) => o.target.kind === 'project' && o.target.artifact === nested,
    );
    expect(nestedOutcome?.outcome).toBe('failed');
    expect(nestedOutcome?.detail).toMatch(/EPERM/);

    const storeOutcome = outcomes.find((o) => o.target.kind === 'cache');
    expect(storeOutcome?.outcome).toBe('refused');
    expect(storeOutcome?.refusal).toBe('store-prune-unsafe');
    expect(recorder.trashed).not.toContain(store.path);
    expect(await exists(store.path)).toBe(true);

    // Targeted, not a halt: the unrelated build artifact is still cleaned.
    expect(recorder.trashed).toContain(dist.path);
  });

  it('prunes the store when the workspace node_modules is trashed successfully', async () => {
    // The opposite direction, so the case above cannot pass by refusing every prune.
    const mono = projectAt(f.path('mono'), 'mono', []);
    const nested = artifactAt(mono.root, nestedRel, 'deps', 2 * KB);
    mono.artifacts = [nested];
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('caches/pnpm/store'));

    const recorder = recordingTrash();
    const outcomes = await clean(
      [cacheTarget(store), projectTarget(mono, nested)],
      optionsWith(recorder.trash, { allowedCachePaths: [store.path] }),
    );

    expect(outcomes.every((o) => o.outcome === 'trashed')).toBe(true);
    expect(recorder.trashed.indexOf(nested.path)).toBeLessThan(
      recorder.trashed.indexOf(store.path),
    );
  });
});

describe('invariant 5: each arm of isStorePruneTarget holds on its own', () => {
  /** A `node_modules` the scan saw and the preset did not select — the gate's trigger. */
  const leftBehind = (): string[] => [f.path('proj/node_modules')];

  const ordinaryCache = (): CacheEntry =>
    cacheAt('npm-cache', 'npm cache', f.path('caches/npm/_cacache'), KB);

  describe('matched by id alone, at a path nothing would recognise', () => {
    const byId = (): CacheEntry =>
      cacheAt('pnpm-store', 'pnpm store', f.path('blobs/content-addressed'));

    it('is not matchable by path shape, so only the id arm can claim it', () => {
      expect(byId().path).not.toMatch(/[\\/]pnpm[\\/]store[\\/]?$/i);
    });

    it('gates the store prune', async () => {
      const store = byId();
      const recorder = recordingTrash();
      const [outcome] = await clean(
        [cacheTarget(store)],
        optionsWith(recorder.trash, {
          allowedCachePaths: [store.path],
          unselectedNodeModules: leftBehind(),
        }),
      );

      expect(outcome?.outcome).toBe('refused');
      expect(outcome?.refusal).toBe('store-prune-unsafe');
      expect(recorder.trashed).toEqual([]);
      expect(await exists(store.path)).toBe(true);
    });

    it('sorts last, after an ordinary cache', () => {
      const store = cacheTarget(byId());
      const npm = cacheTarget(ordinaryCache());
      expect(orderTargets([store, npm])).toEqual([npm, store]);
    });
  });

  describe('matched by path shape alone, under an id nothing would recognise', () => {
    // The scenario the comment names: someone renames the id in `caches.ts`. The path is
    // still `.../pnpm/store`, and the dependency must survive the rename.
    const byPath = (): CacheEntry =>
      cacheAt('pnpm-content-addressable-store', 'pnpm store', f.path('caches/pnpm/store'));

    it('carries an id no id list in the module knows, so only the path arm can claim it', () => {
      expect(byPath().id).not.toBe('pnpm-store');
      expect(byPath().path).toMatch(/[\\/]pnpm[\\/]store$/);
    });

    it('gates the store prune', async () => {
      const store = byPath();
      const recorder = recordingTrash();
      const [outcome] = await clean(
        [cacheTarget(store)],
        optionsWith(recorder.trash, {
          allowedCachePaths: [store.path],
          unselectedNodeModules: leftBehind(),
        }),
      );

      expect(outcome?.outcome).toBe('refused');
      expect(outcome?.refusal).toBe('store-prune-unsafe');
      expect(recorder.trashed).toEqual([]);
      expect(await exists(store.path)).toBe(true);
    });

    it('sorts last, after an ordinary cache', () => {
      const store = cacheTarget(byPath());
      const npm = cacheTarget(ordinaryCache());
      expect(orderTargets([store, npm])).toEqual([npm, store]);
    });
  });

  it('leaves a cache that is neither a store nor a hardlink farm alone', async () => {
    // The control: the gate is about hardlink farms, not about caches in general. Without
    // this, both cases above would pass against a `clean` that refused every cache
    // whenever any node_modules was left behind.
    const npm = ordinaryCache();
    const recorder = recordingTrash();
    const [outcome] = await clean(
      [cacheTarget(npm)],
      optionsWith(recorder.trash, {
        allowedCachePaths: [npm.path],
        unselectedNodeModules: leftBehind(),
      }),
    );

    expect(outcome?.outcome).toBe('trashed');
    expect(recorder.trashed).toEqual([npm.path]);
  });
});
