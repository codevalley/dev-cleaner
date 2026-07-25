/**
 * The adversarial suite for `clean.ts` — the deletion boundary.
 *
 * Every case here constructs the **dangerous** input, not the safe one. A guard that is
 * only ever handed valid targets is untested, and a test that asserts "the good target was
 * trashed" passes just as happily against a module with no guards at all.
 *
 * The subtle ones, and why each is written the way it is:
 *
 * - **Invariant 2, the ancestor chain.** The cache case puts the symlink in an
 *   *intermediate* component (`<fix>/link/store`, `<fix>/link -> <fix>/real`). The test
 *   asserts first that a terminal `lstat` reports a plain directory — so an implementation
 *   that checks only the last component passes that check and must still refuse.
 * - **Invariant 6, at the deletion boundary.** The worktree is named `build`, a name the
 *   artifact table claims. A worktree named `namespace-foundation` is refused by the
 *   allowlist and proves nothing.
 * - **Invariant 5, the dependency.** A rank-0 `node_modules` that *fails*, with a store
 *   prune also selected. Sorting alone leaves the store prune to proceed, orphaning the
 *   hardlinks of a project that is still on disk — which is the exact thing the ordering
 *   exists to prevent. The suite therefore asserts both directions: refused when a
 *   node_modules did not succeed, trashed when they all did.
 *
 * Nothing is ever deleted: the `TrashFn` records, and every assertion about a refusal is
 * paired with an assertion that the recorder never saw the path.
 */

import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clean } from '../src/clean.js';
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
import { dir, file, fixture, symlink, worktree, type Fixture } from './fixture.js';

const KB = 1024;

const DORMANT: ActivityScore = { status: 'dormant', idleMs: 0, reason: 'test fixture' };

const HOME = os.homedir();

/** A `.git` file's pointer. Nothing reads it; what matters is that `.git` is a FILE. */
const DANGLING_GITDIR = '/nonexistent/repo/.git/worktrees/build';

function artifactAt(root: string, rel: string, category: Category = 'deps', bytes = KB): Artifact {
  return { path: path.join(root, rel), relPath: rel, category, bytes };
}

/** An artifact whose absolute path is *not* under the project root it is attached to. */
function artifactElsewhere(absolute: string, relPath: string): Artifact {
  return { path: absolute, relPath, category: 'deps', bytes: KB };
}

function projectAt(root: string, name: string, artifacts: Artifact[] = []): Project {
  return {
    root,
    name,
    types: new Set<ProjectType>(['node']),
    artifacts,
    bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    activity: DORMANT,
  };
}

function cacheAt(id: string, label: string, target: string, bytes = KB): CacheEntry {
  return { id, label, path: target, bytes, note: 'test cache' };
}

function projectTarget(project: Project, artifact: Artifact): CleanTarget {
  return { kind: 'project', project, artifact };
}

function cacheTarget(cache: CacheEntry): CleanTarget {
  return { kind: 'cache', cache };
}

/** Records instead of deleting; `failOn` makes a specific path throw, as EPERM would. */
function recordingTrash(failOn: readonly string[] = []): { trash: TrashFn; trashed: string[] } {
  const trashed: string[] = [];
  const trash: TrashFn = async (paths) => {
    for (const target of paths) {
      if (failOn.includes(target)) {
        throw new Error(`EPERM: operation not permitted, unlink '${target}'`);
      }
    }
    trashed.push(...paths);
  };
  return { trash, trashed };
}

function only(outcomes: readonly CleanOutcome[]): CleanOutcome {
  expect(outcomes).toHaveLength(1);
  return outcomes[0] as CleanOutcome;
}

let f: Fixture;

beforeAll(async () => {
  f = await fixture({
    // A perfectly ordinary project, used as the "control" root for the guards.
    'app/package.json': '{ "name": "app" }\n',
    'app/src/index.ts': 'export const x = 1;\n',
    'app/node_modules/left-pad/index.js': file('m', { size: 4 * KB }),

    // Invariant 1: a real node_modules that belongs to nobody the caller named.
    'elsewhere/node_modules/rogue/index.js': file('r', { size: 2 * KB }),

    // Invariant 2a: an artifact-named SYMLINK pointing at the user's home directory.
    'linked/package.json': '{ "name": "linked" }\n',
    'linked/node_modules': symlink(HOME),

    // Invariant 2b: a symlink as an *intermediate* component of a cache path.
    'real/store/v3/files/00/abcdef': file('s', { size: 4 * KB }),
    'link': symlink('real'),

    // Invariant 2c: the same trick inside a project — a symlinked subdirectory whose
    // node_modules is a perfectly real directory.
    'proj/package.json': '{ "name": "proj" }\n',
    'proj/outside/node_modules/pkg/index.js': file('o', { size: 2 * KB }),
    'proj/sub': symlink('outside'),

    // Invariant 6: a linked worktree named `build` — a name the artifact table claims.
    'repo/Cargo.toml': '[package]\nname = "repo"\n',
    'repo/build': worktree(DANGLING_GITDIR),
    'repo/build/Cargo.toml': '[package]\nname = "repo"\n',
    'repo/build/src/lib.rs': 'pub fn feature() {}\n',

    // Invariant 5: a project whose node_modules will fail, and a store to prune.
    'fragile/package.json': '{ "name": "fragile" }\n',
    'fragile/node_modules/dep/index.js': file('d', { size: 4 * KB }),
    'fragile/dist/bundle.js': file('b', { size: KB }),
    'pnpm/store/v3/files/00/abcdef': file('p', { size: 8 * KB }),

    // A source directory, to prove the allowlist refuses what the table does not name.
    'app/src/components': dir(),

    // A project whose ROOT is named like an artifact — the case where the allowlist
    // cannot help and only strict containment refuses.
    'named/dist/package.json': '{ "name": "dist" }\n',
    'named/dist/src/index.ts': 'export const y = 2;\n',
  });
});

afterAll(async () => {
  await f?.cleanup();
});

function optionsWith(trash: TrashFn, overrides: Partial<CleanOptions> = {}): CleanOptions {
  return { trash, roots: [f.root], allowedCachePaths: [], unselectedNodeModules: [], ...overrides };
}

describe('invariant 1: allowlist, and containment within a project root', () => {
  it('refuses a node_modules that lies outside the project root it is attached to', async () => {
    const app = projectAt(f.path('app'), 'app');
    const rogue = artifactElsewhere(f.path('elsewhere/node_modules'), 'node_modules');

    const recorder = recordingTrash();
    const outcome = only(await clean([projectTarget(app, rogue)], optionsWith(recorder.trash)));

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('outside-project-root');
    expect(recorder.trashed).toEqual([]);
    // Still there: a refusal is a refusal, not a delayed delete.
    expect((await lstat(rogue.path)).isDirectory()).toBe(true);
  });

  it('refuses a project root that lies outside every scan root', async () => {
    const outside = projectAt(f.path('elsewhere'), 'elsewhere');
    const artifact = artifactAt(outside.root, 'node_modules');

    const recorder = recordingTrash();
    const outcome = only(
      await clean(
        [projectTarget(outside, artifact)],
        optionsWith(recorder.trash, { roots: [f.path('app')] }),
      ),
    );

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('outside-project-root');
    expect(recorder.trashed).toEqual([]);
  });

  it('refuses the project root itself, even when the root is NAMED like an artifact', async () => {
    // A project directory called `dist` is ordinary enough, and it is the one shape where
    // the allowlist cannot save us: the basename is in the table, so only *strict*
    // containment stands between the guard and deleting the repository.
    const named = projectAt(f.path('named/dist'), 'named/dist');
    const itself: Artifact = { path: named.root, relPath: '.', category: 'build', bytes: KB };

    const recorder = recordingTrash();
    const outcome = only(await clean([projectTarget(named, itself)], optionsWith(recorder.trash)));

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('outside-project-root');
    expect(recorder.trashed).toEqual([]);
    expect((await lstat(f.path('named/dist/package.json'))).isFile()).toBe(true);
  });

  it('refuses a directory the artifact table does not name', async () => {
    const app = projectAt(f.path('app'), 'app');
    const source = artifactAt(app.root, path.join('src', 'components'), 'build');

    const recorder = recordingTrash();
    const outcome = only(await clean([projectTarget(app, source)], optionsWith(recorder.trash)));

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('not-in-artifact-table');
    expect(recorder.trashed).toEqual([]);
    expect((await lstat(source.path)).isDirectory()).toBe(true);
  });

  it('refuses a cache that the scan did not produce', async () => {
    const unlisted = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    const recorder = recordingTrash();
    const outcome = only(
      await clean([cacheTarget(unlisted)], optionsWith(recorder.trash, { allowedCachePaths: [] })),
    );

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('unknown-cache');
    expect(recorder.trashed).toEqual([]);
  });
});

describe('invariant 2: no symlink traversal, over the whole path', () => {
  it('refuses an artifact that is itself a symlink to $HOME', async () => {
    const linked = projectAt(f.path('linked'), 'linked');
    const artifact = artifactAt(linked.root, 'node_modules');

    expect((await lstat(artifact.path)).isSymbolicLink()).toBe(true);

    const recorder = recordingTrash();
    const outcome = only(await clean([projectTarget(linked, artifact)], optionsWith(recorder.trash)));

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('symlink');
    expect(recorder.trashed).toEqual([]);
    expect(recorder.trashed).not.toContain(HOME);
    // The link, and the home directory it points at, are both untouched.
    expect((await lstat(artifact.path)).isSymbolicLink()).toBe(true);
    expect((await lstat(HOME)).isDirectory()).toBe(true);
  });

  it('refuses a cache whose PARENT component is a symlink', async () => {
    const viaLink = f.path('link/store');

    // The premise of the test: a terminal check sees an ordinary directory and passes.
    expect((await lstat(viaLink)).isSymbolicLink()).toBe(false);
    expect((await lstat(viaLink)).isDirectory()).toBe(true);
    expect((await lstat(f.path('link'))).isSymbolicLink()).toBe(true);

    const store = cacheAt('pnpm-store', 'pnpm store', viaLink, 4 * KB);
    const recorder = recordingTrash();
    const outcome = only(
      await clean(
        [cacheTarget(store)],
        optionsWith(recorder.trash, { allowedCachePaths: [store.path] }),
      ),
    );

    // Allowlisted, existing, a real directory — the ancestor chain is the only thing that
    // can refuse it.
    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('symlink');
    expect(recorder.trashed).toEqual([]);
    expect((await lstat(f.path('real/store'))).isDirectory()).toBe(true);
  });

  it('refuses a project artifact reached through a symlinked subdirectory', async () => {
    const proj = projectAt(f.path('proj'), 'proj');
    const artifact = artifactAt(proj.root, path.join('sub', 'node_modules'));

    expect((await lstat(artifact.path)).isSymbolicLink()).toBe(false);
    expect((await lstat(f.path('proj/sub'))).isSymbolicLink()).toBe(true);

    const recorder = recordingTrash();
    const outcome = only(await clean([projectTarget(proj, artifact)], optionsWith(recorder.trash)));

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('symlink');
    expect(recorder.trashed).toEqual([]);
    expect((await lstat(f.path('proj/outside/node_modules'))).isDirectory()).toBe(true);
  });
});

describe('invariant 3: guarded paths at the deletion boundary', () => {
  it('refuses every artifact of a project rooted at $HOME, even when $HOME is the scan root', async () => {
    const home = projectAt(HOME, 'home');
    const artifact = artifactAt(HOME, 'node_modules');

    const recorder = recordingTrash();
    // The scan root is $HOME too, so containment passes and only the guard can refuse.
    const outcome = only(
      await clean(
        [projectTarget(home, artifact)],
        optionsWith(recorder.trash, { roots: [HOME] }),
      ),
    );

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('guarded-path');
    expect(recorder.trashed).toEqual([]);
  });

  it('refuses a project rooted at the filesystem root', async () => {
    const root = path.parse(f.root).root;
    const project = projectAt(root, 'root');
    const artifact = artifactAt(root, 'node_modules');

    const recorder = recordingTrash();
    const outcome = only(
      await clean(
        [projectTarget(project, artifact)],
        optionsWith(recorder.trash, { roots: [root] }),
      ),
    );

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('guarded-path');
    expect(recorder.trashed).toEqual([]);
  });

  it('refuses a delete target at depth ≤ 1 from the filesystem root', async () => {
    // Through a cache, because a *project* artifact that shallow implies a project root at
    // the filesystem root, which the previous case already covers. Allowlisted on purpose:
    // the depth guard has to hold even when the caller says the path is expected.
    const shallow = path.join(path.parse(f.root).root, 'Library');
    const bogus = cacheAt('gradle', 'Gradle caches', shallow, KB);

    const recorder = recordingTrash();
    const outcome = only(
      await clean(
        [cacheTarget(bogus)],
        optionsWith(recorder.trash, { allowedCachePaths: [shallow] }),
      ),
    );

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('guarded-path');
    expect(recorder.trashed).toEqual([]);
  });

  it('refuses a cache path equal to $HOME, allowlisted or not', async () => {
    const bogus = cacheAt('pnpm-store', 'pnpm store', HOME, KB);

    const recorder = recordingTrash();
    const outcome = only(
      await clean(
        [cacheTarget(bogus)],
        optionsWith(recorder.trash, { allowedCachePaths: [HOME] }),
      ),
    );

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('guarded-path');
    expect(recorder.trashed).toEqual([]);
  });
});

describe('invariant 6: a worktree is never a delete target (second enforcement)', () => {
  it('refuses a target whose .git is a FILE, even when the table claims its name', async () => {
    const repo = projectAt(f.path('repo'), 'repo');
    const wt = artifactAt(repo.root, 'build', 'build');

    // The trap, exactly: `git worktree add build feature`. The basename is in the table,
    // the directory is real, it sits inside the project root — every other guard passes.
    expect((await lstat(path.join(wt.path, '.git'))).isFile()).toBe(true);

    const recorder = recordingTrash();
    const outcome = only(await clean([projectTarget(repo, wt)], optionsWith(recorder.trash)));

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('worktree-root');
    expect(recorder.trashed).toEqual([]);
    // The checkout, and the uncommitted work it might hold, survives.
    expect((await lstat(f.path('repo/build/src/lib.rs'))).isFile()).toBe(true);
  });

  it('refuses a worktree offered as a cache target too', async () => {
    const wt = cacheAt('pnpm-store', 'pnpm store', f.path('repo/build'), KB);

    const recorder = recordingTrash();
    const outcome = only(
      await clean([cacheTarget(wt)], optionsWith(recorder.trash, { allowedCachePaths: [wt.path] })),
    );

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('worktree-root');
    expect(recorder.trashed).toEqual([]);
  });
});

describe('invariant 5: the store prune is a dependency, not a sequence', () => {
  const storePath = (): string => f.path('pnpm/store');

  function fragileTargets(): {
    project: Project;
    nodeModules: Artifact;
    dist: Artifact;
    store: CacheEntry;
    targets: CleanTarget[];
  } {
    const project = projectAt(f.path('fragile'), 'fragile');
    const nodeModules = artifactAt(project.root, 'node_modules', 'deps', 4 * KB);
    const dist = artifactAt(project.root, 'dist', 'build', KB);
    project.artifacts = [nodeModules, dist];
    const store = cacheAt('pnpm-store', 'pnpm store', storePath(), 8 * KB);
    return {
      project,
      nodeModules,
      dist,
      store,
      // Passed store-first, so nothing here depends on the caller ordering correctly.
      targets: [
        cacheTarget(store),
        projectTarget(project, dist),
        projectTarget(project, nodeModules),
      ],
    };
  }

  it('refuses the store prune when a node_modules FAILED to trash', async () => {
    const { nodeModules, store, targets } = fragileTargets();
    const recorder = recordingTrash([nodeModules.path]);

    const outcomes = await clean(
      targets,
      optionsWith(recorder.trash, { allowedCachePaths: [store.path] }),
    );
    const byLabel = new Map(outcomes.map((outcome) => [outcome.label, outcome]));

    expect(byLabel.get('fragile/node_modules')?.outcome).toBe('failed');
    // The whole point: sorting alone would have pruned the store right after the failure,
    // orphaning the hardlinks of a node_modules that is still on disk.
    expect(byLabel.get('pnpm store')?.outcome).toBe('refused');
    expect(byLabel.get('pnpm store')?.refusal).toBe('store-prune-unsafe');
    expect(recorder.trashed).not.toContain(store.path);
    expect((await lstat(store.path)).isDirectory()).toBe(true);

    // Everything else still runs: one failure must not cancel unrelated work.
    expect(byLabel.get('fragile/dist')?.outcome).toBe('trashed');
  });

  it('refuses the store prune when a node_modules was REFUSED rather than failing', async () => {
    const linked = projectAt(f.path('linked'), 'linked');
    const symlinked = artifactAt(linked.root, 'node_modules');
    const store = cacheAt('pnpm-store', 'pnpm store', storePath(), 8 * KB);

    const recorder = recordingTrash();
    const outcomes = await clean(
      [cacheTarget(store), projectTarget(linked, symlinked)],
      optionsWith(recorder.trash, { allowedCachePaths: [store.path] }),
    );
    const byLabel = new Map(outcomes.map((outcome) => [outcome.label, outcome]));

    expect(byLabel.get('linked/node_modules')?.refusal).toBe('symlink');
    expect(byLabel.get('pnpm store')?.refusal).toBe('store-prune-unsafe');
    expect(recorder.trashed).not.toContain(store.path);
  });

  it('prunes the store when every node_modules succeeded', async () => {
    // The other direction, without which "always refuse" would pass the two tests above.
    const app = projectAt(f.path('app'), 'app');
    const nodeModules = artifactAt(app.root, 'node_modules', 'deps', 4 * KB);
    const store = cacheAt('pnpm-store', 'pnpm store', storePath(), 8 * KB);

    const recorder = recordingTrash();
    const outcomes = await clean(
      [cacheTarget(store), projectTarget(app, nodeModules)],
      optionsWith(recorder.trash, { allowedCachePaths: [store.path] }),
    );

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['trashed', 'trashed']);
    expect(recorder.trashed).toEqual([nodeModules.path, store.path]);
  });

  it('prunes the store when a non-node_modules artifact fails', async () => {
    // The dependency is specifically about hardlinks into the store. A failed `dist` says
    // nothing about them, and blocking on it would make the guard mean something else.
    const app = projectAt(f.path('app'), 'app');
    const nodeModules = artifactAt(app.root, 'node_modules', 'deps', 4 * KB);
    const dist = artifactAt(f.path('fragile'), 'dist', 'build', KB);
    const fragile = projectAt(f.path('fragile'), 'fragile');
    const store = cacheAt('pnpm-store', 'pnpm store', storePath(), 8 * KB);

    const recorder = recordingTrash([dist.path]);
    const outcomes = await clean(
      [cacheTarget(store), projectTarget(fragile, dist), projectTarget(app, nodeModules)],
      optionsWith(recorder.trash, { allowedCachePaths: [store.path] }),
    );
    const byLabel = new Map(outcomes.map((outcome) => [outcome.label, outcome]));

    expect(byLabel.get('fragile/dist')?.outcome).toBe('failed');
    expect(byLabel.get('pnpm store')?.outcome).toBe('trashed');
  });
});
