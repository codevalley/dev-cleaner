/**
 * `clean.ts` on the ordinary path: labels, ordering, and a run in which everything works.
 *
 * The adversarial cases — every refusal, and the ordering *dependency* that a sorted loop
 * does not provide — live in `clean.safety.test.ts`. This file establishes the baseline
 * those tests are read against: without a run that actually trashes, a module that refused
 * everything would pass the whole safety suite.
 *
 * Nothing here deletes: the `TrashFn` is injected and records. That seam is the entire
 * difference between the tested path and the shipped one (`systemTrash`).
 */

import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clean, orderTargets, systemTrash, targetLabel } from '../src/clean.js';
import type { CleanOptions } from '../src/clean.js';
import type {
  ActivityScore,
  Artifact,
  CacheEntry,
  Category,
  CleanOutcome,
  CleanTarget,
  Project,
  ProjectType,
  TrashFn,
} from '../src/types.js';
import { file, fixture, type Fixture } from './fixture.js';

const KB = 1024;

const DORMANT: ActivityScore = { status: 'dormant', idleMs: 0, reason: 'test fixture' };

function artifactAt(root: string, rel: string, category: Category, bytes: number): Artifact {
  return { path: path.join(root, rel), relPath: rel, category, bytes };
}

function projectAt(root: string, name: string, artifacts: Artifact[]): Project {
  return {
    root,
    name,
    types: new Set<ProjectType>(['node']),
    artifacts,
    bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    activity: DORMANT,
  };
}

function cacheAt(id: string, label: string, target: string, bytes: number): CacheEntry {
  return { id, label, path: target, bytes, note: 'test cache' };
}

function projectTarget(project: Project, artifact: Artifact): CleanTarget {
  return { kind: 'project', project, artifact };
}

function cacheTarget(cache: CacheEntry): CleanTarget {
  return { kind: 'cache', cache };
}

/** Records instead of deleting, and remembers the call boundaries as well as the paths. */
function recordingTrash(): { trash: TrashFn; trashed: string[]; calls: string[][] } {
  const trashed: string[] = [];
  const calls: string[][] = [];
  const trash: TrashFn = async (paths) => {
    calls.push([...paths]);
    trashed.push(...paths);
  };
  return { trash, trashed, calls };
}

describe('targetLabel', () => {
  it('names a project artifact by project and relative path', () => {
    const project = projectAt('/tmp/dev/v2/zerolist', 'v2/zerolist', []);
    const artifact = artifactAt(project.root, 'node_modules', 'deps', 64 * KB);
    expect(targetLabel(projectTarget(project, artifact))).toBe('v2/zerolist/node_modules');
  });

  it('keeps a nested artifact’s whole relative path, so two `build`s are distinguishable', () => {
    const project = projectAt('/tmp/dev/notchpad', 'notchpad', []);
    const nested = artifactAt(project.root, path.join('android', 'app', 'build'), 'build', KB);
    expect(targetLabel(projectTarget(project, nested))).toBe('notchpad/android/app/build');
  });

  it('falls back to the directory name when a project has no display name', () => {
    const project = projectAt('/tmp/dev/orphan', '', []);
    const artifact = artifactAt(project.root, 'dist', 'build', KB);
    expect(targetLabel(projectTarget(project, artifact))).toBe('orphan/dist');
  });

  it('names a cache by its label', () => {
    expect(targetLabel(cacheTarget(cacheAt('pnpm-store', 'pnpm store', '/tmp/store', KB)))).toBe(
      'pnpm store',
    );
  });
});

describe('orderTargets', () => {
  const project = projectAt('/tmp/dev/app', 'app', []);
  const nodeModules = artifactAt(project.root, 'node_modules', 'deps', 8 * KB);
  const other = projectAt('/tmp/dev/other', 'other', []);
  const otherNodeModules = artifactAt(other.root, 'node_modules', 'deps', 4 * KB);
  const dist = artifactAt(project.root, 'dist', 'build', 2 * KB);
  const store = cacheAt('pnpm-store', 'pnpm store', '/tmp/caches/pnpm/store', 16 * KB);
  const npm = cacheAt('npm-cache', 'npm cache', '/tmp/caches/npm/_cacache', KB);

  const shuffled: CleanTarget[] = [
    cacheTarget(store),
    projectTarget(project, dist),
    cacheTarget(npm),
    projectTarget(other, otherNodeModules),
    projectTarget(project, nodeModules),
  ];

  it('puts every project node_modules before any store prune (invariant 5)', () => {
    const ordered = orderTargets(shuffled);
    const labels = ordered.map(targetLabel);

    const storeAt = labels.indexOf('pnpm store');
    expect(storeAt).toBeGreaterThanOrEqual(0);
    for (const nm of ['app/node_modules', 'other/node_modules']) {
      expect(labels.indexOf(nm), `${nm} must precede the store prune`).toBeLessThan(storeAt);
    }
    // Last, not merely "somewhere after": anything trashed later could hardlink into it.
    expect(labels.at(-1)).toBe('pnpm store');
  });

  it('leaves ordinary caches and build output between the two, order preserved', () => {
    const labels = orderTargets(shuffled).map(targetLabel);
    expect(labels).toEqual([
      'other/node_modules',
      'app/node_modules',
      'app/dist',
      'npm cache',
      'pnpm store',
    ]);
  });

  it('is stable within a rank, so equal targets keep the caller’s order', () => {
    const a = projectTarget(project, nodeModules);
    const b = projectTarget(other, otherNodeModules);
    expect(orderTargets([a, b]).map(targetLabel)).toEqual(['app/node_modules', 'other/node_modules']);
    expect(orderTargets([b, a]).map(targetLabel)).toEqual(['other/node_modules', 'app/node_modules']);
  });

  it('returns a new array and does not mutate the caller’s', () => {
    const input = [...shuffled];
    const ordered = orderTargets(input);
    expect(ordered).not.toBe(input);
    expect(input).toEqual(shuffled);
  });

  it('handles an empty list', () => {
    expect(orderTargets([])).toEqual([]);
  });
});

describe('clean, when everything succeeds', () => {
  let f: Fixture;
  let options: CleanOptions;
  let recorder: ReturnType<typeof recordingTrash>;
  let outcomes: CleanOutcome[];
  let app: Project;
  let nodeModules: Artifact;
  let dist: Artifact;
  let store: CacheEntry;

  beforeAll(async () => {
    f = await fixture({
      'app/package.json': '{ "name": "app" }\n',
      'app/src/index.ts': 'export const x = 1;\n',
      'app/node_modules/left-pad/index.js': file('m', { size: 4 * KB }),
      'app/dist/bundle.js': file('d', { size: 2 * KB }),
      'caches/pnpm/store/v3/files/00/abcdef': file('s', { size: 8 * KB }),
    });

    app = projectAt(f.path('app'), 'app', []);
    nodeModules = artifactAt(app.root, 'node_modules', 'deps', 4 * KB);
    dist = artifactAt(app.root, 'dist', 'build', 2 * KB);
    app.artifacts = [nodeModules, dist];
    store = cacheAt('pnpm-store', 'pnpm store', f.path('caches/pnpm/store'), 8 * KB);

    recorder = recordingTrash();
    options = {
      trash: recorder.trash,
      roots: [f.root],
      allowedCachePaths: [store.path],
      unselectedNodeModules: [],
    };

    // Deliberately in the dangerous order: the store first, node_modules last.
    outcomes = await clean(
      [cacheTarget(store), projectTarget(app, dist), projectTarget(app, nodeModules)],
      options,
    );
  });

  afterAll(async () => {
    await f?.cleanup();
  });

  it('trashes every target and refuses none', () => {
    expect(outcomes.map((outcome) => `${outcome.label}:${outcome.outcome}`)).toEqual([
      'app/node_modules:trashed',
      'app/dist:trashed',
      'pnpm store:trashed',
    ]);
    expect(outcomes.every((outcome) => outcome.refusal === undefined)).toBe(true);
  });

  it('calls the injected TrashFn once per target, with the resolved path', () => {
    expect(recorder.calls).toEqual([[nodeModules.path], [dist.path], [store.path]]);
  });

  it('trashes node_modules before the store, whatever order the caller passed', () => {
    expect(recorder.trashed.indexOf(nodeModules.path)).toBeLessThan(
      recorder.trashed.indexOf(store.path),
    );
  });

  it('reports the bytes and the originating target on every outcome', () => {
    const byLabel = new Map(outcomes.map((outcome) => [outcome.label, outcome]));
    expect(byLabel.get('app/node_modules')?.bytes).toBe(4 * KB);
    expect(byLabel.get('pnpm store')?.bytes).toBe(8 * KB);

    const cacheOutcome = byLabel.get('pnpm store');
    expect(cacheOutcome?.target.kind).toBe('cache');
    const projectOutcome = byLabel.get('app/dist');
    expect(projectOutcome?.target.kind).toBe('project');
    if (projectOutcome?.target.kind === 'project') {
      expect(projectOutcome.target.artifact).toBe(dist);
      expect(projectOutcome.target.project).toBe(app);
    }
  });

  it('does nothing at all for an empty target list', async () => {
    const quiet = recordingTrash();
    const none = await clean([], { ...options, trash: quiet.trash });
    expect(none).toEqual([]);
    expect(quiet.calls).toEqual([]);
  });

  it('reports a TrashFn failure as `failed`, without a refusal code', async () => {
    const angry: TrashFn = async () => {
      throw new Error('EPERM: operation not permitted');
    };
    const result = await clean([projectTarget(app, dist)], { ...options, trash: angry });
    expect(result[0]?.outcome).toBe('failed');
    expect(result[0]?.refusal).toBeUndefined();
    expect(result[0]?.detail).toMatch(/EPERM/);
  });

  it('reports a target that has already gone as `failed`, never as trashed', async () => {
    // A name the artifact table does claim, so the refusal cannot be the allowlist's.
    const absent = artifactAt(app.root, '.next', 'build', KB);
    const quiet = recordingTrash();
    const result = await clean([projectTarget(app, absent)], { ...options, trash: quiet.trash });
    expect(result[0]?.outcome).toBe('failed');
    expect(quiet.calls).toEqual([]);
  });
});

describe('systemTrash', () => {
  it('is the production TrashFn, and a no-op on an empty list', async () => {
    // Called with nothing on purpose: this is the one assertion that can touch the real
    // trash implementation without risking a deletion.
    expect(typeof systemTrash).toBe('function');
    await expect(systemTrash([])).resolves.toBeUndefined();
  });
});
