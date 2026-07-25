/**
 * A second round of pins for guards in `clean.ts` that are *correct* but **unpinned**:
 * each one can be deleted outright and the suite stays green, because no existing fixture
 * builds the shape where the guard and its absence disagree.
 *
 * 1. **The allowlist reads the real basename, not `relPath`.** The module header states the
 *    rule — "`relPath`, `bytes`, `name` and `label` are display data and never gate a
 *    decision" — and `lexicalRejection` obeys it by asking `isArtifactBasename` about
 *    `path.basename(deletePath)`. Every fixture in the suite builds an artifact whose
 *    `relPath` *is* its basename, so re-pointing the check at `target.artifact.relPath`
 *    changes nothing anywhere. The two cases here separate them in both directions: a path
 *    ending in `src` that claims to be `dist` must be refused, and a path ending in `dist`
 *    that claims to be `src` must still be cleaned.
 *
 * 2. **The ancestor `lstat` walk (invariant 2).** The walk and the parent-`realpath`
 *    disagreement check that follows it are two spellings of the same question, and on
 *    every existing fixture both answer. The fixture below is one only the walk can answer:
 *    the symlinked ancestor **dangles**, so `realpath` cannot resolve the parent at all and
 *    `safeRealpath` returns `undefined`, leaving the walk as the only mechanism in play.
 *    A second case pins the walk's precedence and its message on a *live* symlink, where
 *    both mechanisms are armed.
 *
 *    The converse fixture — one only the `realpath` check can refuse — does not exist on a
 *    POSIX filesystem, and this file deliberately does not fake one. `realpath` rewrites a
 *    component only when that component is a symlink, so a disagreement implies some prefix
 *    of the parent is a symlink; the walk visits exactly those prefixes, shallowest first,
 *    and runs first. And whenever the walk stops early (`safeLstat` failed on a prefix),
 *    `realpath` must fail on the parent too, since it has to traverse the same prefix — so
 *    the fallback is silent there as well. Measured, not assumed: macOS `realpath` does not
 *    canonicalise case (`.../proj` stays `.../proj` beside an on-disk `.../Proj`) and does
 *    not rewrite firmlinks (`/System/Volumes/Data/...` resolves to itself), and
 *    `/Volumes/Macintosh HD`, the one path on this machine that does resolve elsewhere, is
 *    itself a symlink and so is caught by the walk. The check is genuine defence in depth
 *    against a bug in `ancestorsOf`/`safeLstat`; it is not independently observable, and a
 *    test claiming otherwise would be the very thing this round of work exists to remove.
 *
 * 3. **A cache that contains a scan root is not a cache.** `lexicalRejection` refuses an
 *    otherwise-allowlisted cache whose path swallows one of the scan roots. Every fixture
 *    cache sits outside the roots entirely, so the comparison never has anything to find.
 *
 * 4. **A candidate that is not a directory fails.** The artifacts module notes that
 *    "`build` is very often an executable build *script*"; `filesystemRejection` ends with
 *    the check that turns such a candidate into a `failed` outcome rather than a delete.
 *    Nothing exercised it, so `clean` was free to hand a shell script to the trash.
 *
 * Nothing here deletes: the `TrashFn` is injected, as everywhere else in the clean suite,
 * and every case asserts the target is still on disk afterwards. Every describe block
 * carries a control in the opposite direction, so no case can be satisfied by a `clean`
 * that simply refuses everything.
 */

import { access, chmod, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clean } from '../src/clean.js';
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
import { file, fixture, symlink, type Fixture } from './fixture.js';

const KB = 1024;
const DORMANT: ActivityScore = { status: 'dormant', idleMs: 400 * 86_400_000, reason: 'test' };

/** A target that exists on no machine, so the symlink naming it is guaranteed to dangle. */
const NOWHERE = '/dev-cleaner-no-such-volume-8f3c1e/gone';

let f: Fixture;

beforeAll(async () => {
  f = await fixture({
    // (1) `src` is real source; `dist` is a real build artifact. The tests below cross the
    // two over so that the basename and the claimed `relPath` name different things.
    'lying/package.json': '{ "name": "lying" }\n',
    'lying/src/index.ts': file('s', { size: KB }),
    'lying/dist/bundle.js': file('d', { size: KB }),

    // (2) A dangling symlink on the path to the candidate: `lstat` still sees a symlink,
    // `realpath` sees ENOENT. Relative target so it points nowhere on every machine.
    'dangling/package.json': '{ "name": "dangling" }\n',
    'dangling/gone': symlink(NOWHERE),
    'dangling/dist/bundle.js': file('g', { size: KB }),

    // ...and a live one, where both invariant-2 mechanisms are armed at once.
    'linked/package.json': '{ "name": "linked" }\n',
    'linked/real/dist/bundle.js': file('l', { size: KB }),
    'linked/via': symlink('real'),

    // (3) A scan root nested inside the fixture, so a cache can be its *parent* without
    // reaching for anything outside the temporary tree.
    'workspace/projects/app/package.json': '{ "name": "app" }\n',
    'workspace/projects/app/dist/bundle.js': file('w', { size: KB }),
    'workspace/sibling-cache/blob': file('c', { size: KB }),

    // (4) `build` as an executable shell script rather than a directory.
    'script/package.json': '{ "name": "script" }\n',
    'script/build': file('#!/bin/sh\nexec node ./scripts/build.mjs "$@"\n'),
    'script/dist/bundle.js': file('b', { size: KB }),
  });

  // The fixture helper writes plain files; the mode is what makes this a build *script*.
  await chmod(f.path('script/build'), 0o755);
});

afterAll(async () => {
  await f?.cleanup();
});

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

/**
 * Deliberately *not* derived: `path` and `relPath` are supplied separately so a test can
 * make them disagree, which is the whole point of the first group.
 */
function artifact(target: string, relPath: string, category: Artifact['category']): Artifact {
  return { path: target, relPath, category, bytes: KB };
}

function projectTarget(project: Project, art: Artifact): CleanTarget {
  return { kind: 'project', project, artifact: art };
}

function cacheAt(id: string, label: string, target: string): CacheEntry {
  return { id, label, path: target, bytes: 4 * KB, note: 'test cache' };
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

describe('invariant 1: the allowlist reads the real basename, never relPath', () => {
  it('refuses a path ending in src even when relPath claims dist', async () => {
    // The hand-built target the guard layer exists to catch: `relPath` is display data a
    // caller writes, and here it launders real source past an allowlist that trusted it.
    const project = projectAt(f.path('lying'), 'lying', []);
    const lying = artifact(f.path('lying/src'), 'dist', 'build');
    project.artifacts = [lying];

    // Without this disagreement the case asserts nothing.
    expect(path.basename(lying.path)).toBe('src');
    expect(lying.relPath).toBe('dist');

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(project, lying)], optionsWith(recorder.trash));

    expect(outcome?.outcome).toBe('refused');
    expect(outcome?.refusal).toBe('not-in-artifact-table');
    // The message must name what was actually inspected, or the refusal is unreviewable.
    expect(outcome?.detail).toContain('src is not a name');
    expect(recorder.trashed).toEqual([]);
    expect(await exists(f.path('lying/src/index.ts'))).toBe(true);
  });

  it('cleans a path ending in dist even when relPath claims src', async () => {
    // The same disagreement, mirrored. A `relPath`-based check refuses this one, so the
    // pair brackets the guard from both sides: neither reading can satisfy both cases.
    const project = projectAt(f.path('lying'), 'lying', []);
    const honest = artifact(f.path('lying/dist'), 'src', 'build');
    project.artifacts = [honest];

    expect(path.basename(honest.path)).toBe('dist');
    expect(honest.relPath).toBe('src');

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(project, honest)], optionsWith(recorder.trash));

    expect(outcome?.outcome).toBe('trashed');
    expect(recorder.trashed).toEqual([f.path('lying/dist')]);
  });
});

describe('invariant 2: the ancestor lstat walk, on its own', () => {
  it('refuses a candidate below a dangling symlink, which realpath cannot resolve', async () => {
    // Rooted *at* the stale link, so `relPath` is the plain `dist` the table claims and
    // this case turns on the walk alone rather than on any other guard.
    const project = projectAt(f.path('dangling/gone'), 'dangling', []);
    const below = artifact(f.path('dangling/gone/dist'), 'dist', 'build');
    project.artifacts = [below];

    // The fixture must isolate the walk, or this case is just another symlink test.
    const link = await lstat(f.path('dangling/gone'));
    expect(link.isSymbolicLink()).toBe(true);
    await expect(realpath(path.dirname(below.path))).rejects.toThrow();

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(project, below)], optionsWith(recorder.trash));

    // Not `failed: no longer exists`, which is what is left once the walk is gone: the
    // parent is a link, so nothing about the candidate's absence is reassuring.
    expect(outcome?.outcome).toBe('refused');
    expect(outcome?.refusal).toBe('symlink');
    expect(outcome?.detail).toContain(f.path('dangling/gone'));
    expect(outcome?.detail).toContain('is a symbolic link on the path to');
    expect(recorder.trashed).toEqual([]);
  });

  it('answers a live symlinked ancestor from the walk, before realpath is consulted', async () => {
    // Here both mechanisms are armed, and the walk runs first. Pinning *which* one answered
    // is what keeps the walk from quietly becoming dead weight behind its own fallback.
    const project = projectAt(f.path('linked/via'), 'linked', []);
    const viaLink = artifact(f.path('linked/via/dist'), 'dist', 'build');
    project.artifacts = [viaLink];

    const parent = path.dirname(viaLink.path);
    expect((await lstat(parent)).isSymbolicLink()).toBe(true);
    // The fallback is genuinely armed on this fixture: realpath disagrees with the lexical
    // parent. That it never gets to speak is the point.
    expect(await realpath(parent)).toBe(f.path('linked/real'));

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(project, viaLink)], optionsWith(recorder.trash));

    expect(outcome?.outcome).toBe('refused');
    expect(outcome?.refusal).toBe('symlink');
    expect(outcome?.detail).toContain('is a symbolic link on the path to');
    expect(outcome?.detail).not.toContain('really resolves to');
    expect(recorder.trashed).toEqual([]);
    expect(await exists(f.path('linked/real/dist/bundle.js'))).toBe(true);
  });

  it('cleans a sibling artifact reached without traversing any link', async () => {
    // The control: the refusals above are about the path, not about the project.
    const project = projectAt(f.path('dangling'), 'dangling', []);
    const plain = artifact(f.path('dangling/dist'), 'dist', 'build');
    project.artifacts = [plain];

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(project, plain)], optionsWith(recorder.trash));

    expect(outcome?.outcome).toBe('trashed');
    expect(recorder.trashed).toEqual([f.path('dangling/dist')]);
  });
});

describe('invariant 3: a cache that contains a scan root is not a cache', () => {
  const scanRoot = (): string => f.path('workspace/projects');

  it('refuses an allowlisted cache whose path is the parent of the scan root', async () => {
    const swallower = cacheAt('swallower', 'workspace', f.path('workspace'));

    // Allowlisted and unguarded, so the containment comparison is the only thing left that
    // can refuse it — otherwise this would pass on `unknown-cache` or `guarded-path` alone.
    expect(scanRoot().startsWith(swallower.path + path.sep)).toBe(true);

    const recorder = recordingTrash();
    const [outcome] = await clean(
      [cacheTarget(swallower)],
      optionsWith(recorder.trash, {
        roots: [scanRoot()],
        allowedCachePaths: [swallower.path],
      }),
    );

    expect(outcome?.outcome).toBe('refused');
    expect(outcome?.refusal).toBe('guarded-path');
    expect(outcome?.detail).toContain('contains the scan root');
    expect(outcome?.detail).toContain(scanRoot());
    expect(recorder.trashed).toEqual([]);
    // The scan root and the project inside it are untouched.
    expect(await exists(f.path('workspace/projects/app/dist/bundle.js'))).toBe(true);
  });

  it('cleans an allowlisted cache that sits beside the scan root', async () => {
    // The control: caches outside the roots are the normal case and must still go.
    const beside = cacheAt('sibling', 'sibling cache', f.path('workspace/sibling-cache'));

    const recorder = recordingTrash();
    const [outcome] = await clean(
      [cacheTarget(beside)],
      optionsWith(recorder.trash, {
        roots: [scanRoot()],
        allowedCachePaths: [beside.path],
      }),
    );

    expect(outcome?.outcome).toBe('trashed');
    expect(recorder.trashed).toEqual([beside.path]);
  });
});

describe('a candidate that is not a directory', () => {
  it('fails, rather than trashing an executable build script named build', async () => {
    const project = projectAt(f.path('script'), 'script', []);
    const script = artifact(f.path('script/build'), 'build', 'build');
    project.artifacts = [script];

    // The shape the artifacts module warns about: a name the table claims, on a file.
    const stats = await lstat(script.path);
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o111).not.toBe(0);

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(project, script)], optionsWith(recorder.trash));

    // `failed`, not `refused`: nothing unsafe was proposed, the candidate simply is not the
    // kind of thing this tool removes. The distinction is what the summary reports.
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.refusal).toBeUndefined();
    expect(outcome?.detail).toContain('is not a directory');
    expect(outcome?.detail).toContain(script.path);
    expect(recorder.trashed).toEqual([]);
    expect(await exists(script.path)).toBe(true);
    expect((await lstat(script.path)).mode & 0o111).not.toBe(0);
  });

  it('cleans the same project’s dist, which is a directory', async () => {
    // The control: the failure above is about the candidate's shape, not the project.
    const project = projectAt(f.path('script'), 'script', []);
    const dist = artifact(f.path('script/dist'), 'dist', 'build');
    project.artifacts = [dist];

    const recorder = recordingTrash();
    const [outcome] = await clean([projectTarget(project, dist)], optionsWith(recorder.trash));

    expect(outcome?.outcome).toBe('trashed');
    expect(recorder.trashed).toEqual([f.path('script/dist')]);
  });
});
