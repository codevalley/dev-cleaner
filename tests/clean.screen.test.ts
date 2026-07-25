/**
 * `screenTargets` — the guards of the deletion boundary, asked *before* consent.
 *
 * The defect this exists to close: the report shows what is **selected**, `clean` decides
 * what is **deletable**, and when those two are computed by different code the tool
 * promises space it then refuses. One instance (the pnpm store) was screened by hand in
 * `caches.ts`; a hand-written screen is the same bug waiting to be reintroduced, because
 * nothing makes it track the boundary it is predicting.
 *
 * So the suite is organised around two claims, and the second is the load-bearing one:
 *
 * 1. **Coverage.** Every `Refusal` the boundary can produce is predicted, and each one is
 *    tested in both directions — a target that screens refused *and* a target that screens
 *    clean. A one-directional test is satisfied by `return everything` or `return []`, and
 *    a screen that refuses everything is exactly as useless as one that refuses nothing:
 *    the first promises nothing, the second promises what it cannot deliver.
 * 2. **Equivalence.** For a mixed set, `screenTargets`' verdicts equal — same targets, same
 *    codes, same detail strings, same order — what `clean` actually refuses when handed
 *    that same set. This is the test that prevents the two paths drifting apart again: any
 *    future guard added to one and not the other fails here, and no amount of per-reason
 *    coverage substitutes for it.
 *
 * Plus the two properties without which none of the above is worth anything:
 *
 * - **The screen never mutates.** The fixture tree is snapshotted (every path, type, size
 *   and mtime) before and after, and the options handed to the screen carry a `TrashFn`
 *   that throws if it is ever called.
 * - **The tiers are real.** `'cheap'` must genuinely not walk subtrees — proved by a
 *   nested repository it therefore cannot see, and by a scan budget so tight that *running*
 *   the scan would refuse — while still catching every reason that does not need a walk.
 *
 * Nothing here deletes: `clean` is only ever given a recording `TrashFn`.
 */

import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clean,
  screenTargets,
  screenTargetsCheaply,
  targetLabel,
  type CleanOptions,
  type Screening,
} from '../src/clean.js';
import type {
  ActivityScore,
  Artifact,
  CacheEntry,
  Category,
  CleanOutcome,
  CleanTarget,
  Project,
  ProjectType,
  Refusal,
  TrashFn,
} from '../src/types.js';
import { file, fixture, symlink, worktree, type Fixture } from './fixture.js';

const KB = 1024;
const DORMANT: ActivityScore = { status: 'dormant', idleMs: 0, reason: 'test fixture' };
const HOME = os.homedir();

/** A `.git` file's pointer. Nothing reads it; what matters is that `.git` is a FILE. */
const DANGLING_GITDIR = '/nonexistent/repo/.git/worktrees/build';

function artifactAt(root: string, rel: string, category: Category = 'deps', bytes = KB): Artifact {
  return { path: path.join(root, rel), relPath: rel, category, bytes };
}

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

/**
 * The `TrashFn` every screening test gets. `screenTargets` is documented never to delete;
 * a stub that throws turns "it happened not to call it" into "it cannot call it".
 */
const forbiddenTrash: TrashFn = async () => {
  throw new Error('screenTargets must never delete anything');
};

let f: Fixture;

beforeAll(async () => {
  f = await fixture({
    // ── Clean controls ────────────────────────────────────────────────────────────────
    'app/package.json': '{ "name": "app" }\n',
    'app/node_modules/left-pad/index.js': file('m', { size: 4 * KB }),
    'app/dist/bundle.js': file('b', { size: 2 * KB }),
    // A directory the artifact table does not name.
    'app/src/components/Button.tsx': 'export const Button = () => null;\n',

    // ── outside-project-root ──────────────────────────────────────────────────────────
    'elsewhere/node_modules/rogue/index.js': file('r', { size: 2 * KB }),

    // ── symlink ───────────────────────────────────────────────────────────────────────
    'linked/package.json': '{ "name": "linked" }\n',
    'linked/node_modules': symlink(HOME),

    // ── worktree-root, with a clean sibling in the same project ───────────────────────
    'repo/Cargo.toml': '[package]\nname = "repo"\n',
    'repo/build': worktree(DANGLING_GITDIR),
    'repo/build/src/lib.rs': 'pub fn feature() {}\n',
    'repo/dist/out.js': file('o', { size: KB }),

    // ── contains-repository, the DIRECT form: `git clone -b gh-pages <repo> dist` ──────
    'deploy/package.json': '{ "name": "deploy" }\n',
    'deploy/dist/.git/HEAD': 'ref: refs/heads/gh-pages\n',
    'deploy/dist/index.html': '<!doctype html>\n',

    // ── contains-repository, the NESTED form: `git worktree add build/wip` ────────────
    'nested/package.json': '{ "name": "nested" }\n',
    'nested/build/main.js': file('n', { size: KB }),
    'nested/build/wip/.git/HEAD': 'ref: refs/heads/wip\n',

    // ── contains-repository, the UNVERIFIED form: needs a subdirectory to run out of
    //    budget on, and holds no repository at all so the default budget clears it.
    'wide/package.json': '{ "name": "wide" }\n',
    'wide/build/a/b/c.txt': file('w', { size: KB }),

    // ── A node_modules that is simply not there: `failed`, not a refusal — but still a
    //    hardlink source that will not be removed. Invariant 5 counts it.
    'ghost/package.json': '{ "name": "ghost" }\n',

    // ── The store prune ───────────────────────────────────────────────────────────────
    'pnpm/store/v3/files/00/abcdef': file('p', { size: 8 * KB }),
  });
});

afterAll(async () => {
  await f?.cleanup();
});

function optionsWith(trash: TrashFn, overrides: Partial<CleanOptions> = {}): CleanOptions {
  return { trash, roots: [f.root], allowedCachePaths: [], unselectedNodeModules: [], ...overrides };
}

/** Options for a screen: the same shape `clean` takes, with a `TrashFn` that must not run. */
function screenOptions(overrides: Partial<CleanOptions> = {}): CleanOptions {
  return optionsWith(forbiddenTrash, overrides);
}

/** `[label, refusal]` for every verdict, which is what the per-reason tests assert on. */
function codes(screenings: readonly Screening[]): Array<[string, Refusal]> {
  return screenings.map((screening) => [targetLabel(screening.target), screening.refusal]);
}

/** The same shape, read out of what `clean` actually did. */
function refusalsOf(outcomes: readonly CleanOutcome[]): Array<[string, Refusal]> {
  return outcomes
    .filter((outcome) => outcome.outcome === 'refused')
    .map((outcome) => [outcome.label, outcome.refusal as Refusal]);
}

/** Full verdicts, details included — the comparison the equivalence test makes. */
function verdicts(screenings: readonly Screening[]): Array<Record<string, unknown>> {
  return screenings.map((screening) => ({
    label: targetLabel(screening.target),
    refusal: screening.refusal,
    detail: screening.detail,
  }));
}

function refusedVerdicts(outcomes: readonly CleanOutcome[]): Array<Record<string, unknown>> {
  return outcomes
    .filter((outcome) => outcome.outcome === 'refused')
    .map((outcome) => ({ label: outcome.label, refusal: outcome.refusal, detail: outcome.detail }));
}

/** Every path under `root`, with the facts a mutation would disturb. */
async function snapshot(root: string): Promise<string[]> {
  const seen: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const stats = await lstat(absolute);
      const kind = stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir' : 'file';
      seen.push(
        `${path.relative(root, absolute)}|${kind}|${stats.isDirectory() ? 0 : stats.size}|` +
          `${stats.mtimeMs}`,
      );
      if (!stats.isSymbolicLink() && stats.isDirectory()) await walk(absolute);
    }
  };
  await walk(root);
  return seen;
}

/* ─────────────────────────────── coverage, reason by reason ─────────────────────────── */

describe('every refusal the boundary can produce is predicted, in both directions', () => {
  it('not-in-artifact-table: refuses a source directory, clears a dist', async () => {
    const app = projectAt(f.path('app'), 'app');
    const source = artifactAt(app.root, path.join('src', 'components'), 'build');
    const dist = artifactAt(app.root, 'dist', 'build');

    expect(codes(await screenTargets([projectTarget(app, source)], screenOptions()))).toEqual([
      ['app/src/components', 'not-in-artifact-table'],
    ]);
    expect(await screenTargets([projectTarget(app, dist)], screenOptions())).toEqual([]);
  });

  it('outside-project-root: refuses a node_modules attached to the wrong project', async () => {
    const app = projectAt(f.path('app'), 'app');
    const rogue = artifactElsewhere(f.path('elsewhere/node_modules'), 'node_modules');
    const own = artifactAt(app.root, 'node_modules');

    expect(codes(await screenTargets([projectTarget(app, rogue)], screenOptions()))).toEqual([
      ['app/node_modules', 'outside-project-root'],
    ]);
    expect(await screenTargets([projectTarget(app, own)], screenOptions())).toEqual([]);
  });

  it('symlink: refuses an artifact that is a link to $HOME, clears a real directory', async () => {
    const linked = projectAt(f.path('linked'), 'linked');
    const link = artifactAt(linked.root, 'node_modules');
    const app = projectAt(f.path('app'), 'app');
    const real = artifactAt(app.root, 'node_modules');

    // The premise: it really is a symlink, and it really does point at $HOME.
    expect((await lstat(link.path)).isSymbolicLink()).toBe(true);

    expect(codes(await screenTargets([projectTarget(linked, link)], screenOptions()))).toEqual([
      ['linked/node_modules', 'symlink'],
    ]);
    expect(await screenTargets([projectTarget(app, real)], screenOptions())).toEqual([]);
  });

  it('guarded-path: refuses $HOME as a cache even when allowlisted, clears an ordinary cache', async () => {
    const home = cacheAt('pnpm-store', 'home', HOME, KB);
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    expect(
      codes(
        await screenTargets(
          [cacheTarget(home)],
          screenOptions({ allowedCachePaths: [HOME, store.path] }),
        ),
      ),
    ).toEqual([['home', 'guarded-path']]);
    expect(
      await screenTargets([cacheTarget(store)], screenOptions({ allowedCachePaths: [store.path] })),
    ).toEqual([]);
  });

  it('worktree-root: refuses a `build` whose .git is a FILE, clears its sibling `dist`', async () => {
    const repo = projectAt(f.path('repo'), 'repo');
    const wt = artifactAt(repo.root, 'build', 'build');
    const dist = artifactAt(repo.root, 'dist', 'build');

    expect((await lstat(path.join(wt.path, '.git'))).isFile()).toBe(true);

    expect(codes(await screenTargets([projectTarget(repo, wt)], screenOptions()))).toEqual([
      ['repo/build', 'worktree-root'],
    ]);
    expect(await screenTargets([projectTarget(repo, dist)], screenOptions())).toEqual([]);
  });

  it('unknown-cache: refuses a cache this scan did not produce, clears one it did', async () => {
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    expect(codes(await screenTargets([cacheTarget(store)], screenOptions()))).toEqual([
      ['pnpm store', 'unknown-cache'],
    ]);
    expect(
      await screenTargets([cacheTarget(store)], screenOptions({ allowedCachePaths: [store.path] })),
    ).toEqual([]);
  });

  it('contains-repository (direct): refuses a gh-pages clone, clears a plain dist', async () => {
    const deploy = projectAt(f.path('deploy'), 'deploy');
    const clone = artifactAt(deploy.root, 'dist', 'build');
    const app = projectAt(f.path('app'), 'app');
    const plain = artifactAt(app.root, 'dist', 'build');

    expect((await lstat(path.join(clone.path, '.git'))).isDirectory()).toBe(true);

    const screened = await screenTargets([projectTarget(deploy, clone)], screenOptions());
    expect(codes(screened)).toEqual([['deploy/dist', 'contains-repository']]);
    expect(screened[0]?.detail).toContain('is a git repository');
    expect(await screenTargets([projectTarget(app, plain)], screenOptions())).toEqual([]);
  });

  it('contains-repository (nested): refuses a build holding a worktree, clears one that is not', async () => {
    const nested = projectAt(f.path('nested'), 'nested');
    const build = artifactAt(nested.root, 'build', 'build');
    const wide = projectAt(f.path('wide'), 'wide');
    const clear = artifactAt(wide.root, 'build', 'build');

    const screened = await screenTargets([projectTarget(nested, build)], screenOptions());
    expect(codes(screened)).toEqual([['nested/build', 'contains-repository']]);
    expect(screened[0]?.detail).toContain('contains a git repository');
    // Same depth of tree, no repository in it: the scan finishes and says so.
    expect(await screenTargets([projectTarget(wide, clear)], screenOptions())).toEqual([]);
  });

  it('contains-repository (unverified): refuses what it could not finish checking', async () => {
    const wide = projectAt(f.path('wide'), 'wide');
    const build = artifactAt(wide.root, 'build', 'build');

    // One directory of budget against a tree that has more: the scan cannot rule a
    // repository out, and "I do not know" is a refusal, not a clean bill of health.
    const screened = await screenTargets(
      [projectTarget(wide, build)],
      screenOptions({ nestedScanMaxDirs: 1 }),
    );
    expect(codes(screened)).toEqual([['wide/build', 'contains-repository']]);
    expect(screened[0]?.detail).toContain('too large to verify');

    // The same target, the shipped budget: clear.
    expect(await screenTargets([projectTarget(wide, build)], screenOptions())).toEqual([]);
  });

  it('store-prune-unsafe: refuses the prune when a node_modules is left behind, clears it otherwise', async () => {
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);
    const allowedCachePaths = [store.path];

    const screened = await screenTargets(
      [cacheTarget(store)],
      screenOptions({
        allowedCachePaths,
        unselectedNodeModules: [f.path('app/node_modules'), f.path('linked/node_modules')],
      }),
    );
    expect(codes(screened)).toEqual([['pnpm store', 'store-prune-unsafe']]);
    expect(screened[0]?.detail).toContain('is not being cleaned');
    expect(screened[0]?.detail).toContain('(and 1 more)');

    expect(
      await screenTargets([cacheTarget(store)], screenOptions({ allowedCachePaths })),
    ).toEqual([]);
  });

  it('store-prune-unsafe: sees a node_modules that is refused *within the screened set*', async () => {
    // The set-level half of invariant 5, and the reason the screen is `screenTargets` and
    // not `screenTarget`: nothing about the store prune itself says it is unsafe. The
    // verdict comes from another row of the same hypothetical selection.
    const linked = projectAt(f.path('linked'), 'linked');
    const symlinked = artifactAt(linked.root, 'node_modules');
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    const screened = await screenTargets(
      // Store first, to prove the screen orders internally rather than trusting the caller.
      [cacheTarget(store), projectTarget(linked, symlinked)],
      screenOptions({ allowedCachePaths: [store.path] }),
    );

    expect(codes(screened)).toEqual([
      ['linked/node_modules', 'symlink'],
      ['pnpm store', 'store-prune-unsafe'],
    ]);
    expect(screened[1]?.detail).toContain('linked/node_modules was not trashed (symlink)');
  });

  it('store-prune-unsafe: counts a node_modules that is missing, which is `failed`, not refused', async () => {
    // A `failed` target is not a refusal and must not appear as one — but it is still a
    // hardlink source that will not be removed, so the prune is still unsafe. A screen that
    // only tracked refusals would promise this prune and `clean` would refuse it.
    const ghost = projectAt(f.path('ghost'), 'ghost');
    const missing = artifactAt(ghost.root, 'node_modules');
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    const screened = await screenTargets(
      [cacheTarget(store), projectTarget(ghost, missing)],
      screenOptions({ allowedCachePaths: [store.path] }),
    );

    expect(codes(screened)).toEqual([['pnpm store', 'store-prune-unsafe']]);
    expect(screened[0]?.detail).toContain('ghost/node_modules was not trashed (failed)');
  });
});

/* ────────────────────────────────── read-only, provably ─────────────────────────────── */

describe('the screen reads and nothing else', () => {
  it('leaves every byte, mode and mtime of the tree exactly as it found them', async () => {
    const app = projectAt(f.path('app'), 'app');
    const deploy = projectAt(f.path('deploy'), 'deploy');
    const linked = projectAt(f.path('linked'), 'linked');
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    const before = await snapshot(f.root);

    const screened = await screenTargets(
      [
        projectTarget(app, artifactAt(app.root, 'node_modules')),
        projectTarget(app, artifactAt(app.root, 'dist', 'build')),
        projectTarget(deploy, artifactAt(deploy.root, 'dist', 'build')),
        projectTarget(linked, artifactAt(linked.root, 'node_modules')),
        cacheTarget(store),
      ],
      // The `TrashFn` here throws if called, so a screen that deleted would fail loudly
      // rather than quietly taking the tree with it.
      screenOptions({ allowedCachePaths: [store.path] }),
    );

    // It really did run — an empty result would make the snapshot comparison vacuous.
    expect(screened.length).toBeGreaterThan(0);
    expect(await snapshot(f.root)).toEqual(before);
    expect((await lstat(f.path('app/node_modules'))).isDirectory()).toBe(true);
    expect((await lstat(f.path('pnpm/store'))).isDirectory()).toBe(true);
  });
});

/* ──────────────────────────────────── the two tiers ─────────────────────────────────── */

describe('the cheap tier is genuinely cheap', () => {
  it('does not walk the subtree: it cannot see a nested repository the full screen refuses', async () => {
    const nested = projectAt(f.path('nested'), 'nested');
    const build = artifactAt(nested.root, 'build', 'build');
    const targets = [projectTarget(nested, build)];

    expect(await screenTargetsCheaply(targets, screenOptions())).toEqual([]);
    expect(codes(await screenTargets(targets, screenOptions()))).toEqual([
      ['nested/build', 'contains-repository'],
    ]);
  });

  it('does not run the scan at all, even where running it would refuse', async () => {
    // A budget of one directory makes the scan refuse anything with a subdirectory. The
    // cheap tier is silent, which is only possible if the scan never started — a tier that
    // "walked a little" would produce the `unverified` refusal here.
    const wide = projectAt(f.path('wide'), 'wide');
    const build = artifactAt(wide.root, 'build', 'build');
    const targets = [projectTarget(wide, build)];
    const options = screenOptions({ nestedScanMaxDirs: 1 });

    expect(await screenTargetsCheaply(targets, options)).toEqual([]);
    expect(codes(await screenTargets(targets, options))).toEqual([
      ['wide/build', 'contains-repository'],
    ]);
  });

  it('still catches every reason that needs no walk, including a repository at the top', async () => {
    const app = projectAt(f.path('app'), 'app');
    const deploy = projectAt(f.path('deploy'), 'deploy');
    const linked = projectAt(f.path('linked'), 'linked');
    const repo = projectAt(f.path('repo'), 'repo');
    const home = cacheAt('gradle', 'home', HOME, KB);
    const unlisted = cacheAt('gradle', 'Gradle caches', f.path('repo/dist'), KB);
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    const screened = await screenTargetsCheaply(
      [
        projectTarget(app, artifactAt(app.root, path.join('src', 'components'), 'build')),
        projectTarget(app, artifactElsewhere(f.path('elsewhere/node_modules'), 'node_modules')),
        projectTarget(linked, artifactAt(linked.root, 'node_modules')),
        projectTarget(repo, artifactAt(repo.root, 'build', 'build')),
        projectTarget(deploy, artifactAt(deploy.root, 'dist', 'build')),
        cacheTarget(home),
        cacheTarget(unlisted),
        cacheTarget(store),
      ],
      screenOptions({ allowedCachePaths: [HOME, store.path] }),
    );

    // Every reason there is — the contents scan adds no *new* code, only new sightings —
    // from a screen that never walks a subtree.
    expect(new Set(screened.map((screening) => screening.refusal))).toEqual(
      new Set<Refusal>([
        'not-in-artifact-table',
        'outside-project-root',
        'symlink',
        'worktree-root',
        'contains-repository',
        'guarded-path',
        'unknown-cache',
        'store-prune-unsafe',
      ]),
    );
  });
});

/* ─────────────────────── the property that stops the paths drifting ─────────────────── */

describe('equivalence: the screen predicts exactly what clean refuses', () => {
  /** One of everything: every refusal reason, several clean targets, one `failed`. */
  function mixedTargets(): { targets: CleanTarget[]; store: CacheEntry } {
    const app = projectAt(f.path('app'), 'app');
    const deploy = projectAt(f.path('deploy'), 'deploy');
    const ghost = projectAt(f.path('ghost'), 'ghost');
    const linked = projectAt(f.path('linked'), 'linked');
    const nested = projectAt(f.path('nested'), 'nested');
    const repo = projectAt(f.path('repo'), 'repo');
    const wide = projectAt(f.path('wide'), 'wide');
    const home = cacheAt('gradle', 'home', HOME, KB);
    const unlisted = cacheAt('gradle', 'Gradle caches', f.path('repo/dist'), KB);
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);

    return {
      store,
      targets: [
        // Deliberately unordered: both paths must impose `orderTargets` themselves.
        cacheTarget(store),
        projectTarget(linked, artifactAt(linked.root, 'node_modules')), // symlink
        projectTarget(app, artifactAt(app.root, 'dist', 'build')), // clean
        projectTarget(app, artifactAt(app.root, path.join('src', 'components'), 'build')),
        projectTarget(app, artifactElsewhere(f.path('elsewhere/node_modules'), 'node_modules')),
        projectTarget(repo, artifactAt(repo.root, 'build', 'build')), // worktree-root
        projectTarget(deploy, artifactAt(deploy.root, 'dist', 'build')), // repository
        projectTarget(nested, artifactAt(nested.root, 'build', 'build')), // nested repository
        projectTarget(wide, artifactAt(wide.root, 'build', 'build')), // clean
        projectTarget(ghost, artifactAt(ghost.root, 'node_modules')), // failed, not refused
        cacheTarget(home), // guarded-path
        cacheTarget(unlisted), // unknown-cache
        projectTarget(app, artifactAt(app.root, 'node_modules')), // clean
      ],
    };
  }

  it('produces the same verdicts, in the same order, with the same details', async () => {
    const { targets, store } = mixedTargets();
    const options = { allowedCachePaths: [store.path, HOME] };

    const screened = await screenTargets(targets, screenOptions(options));

    const recorder = recordingTrash();
    const outcomes = await clean(targets, optionsWith(recorder.trash, options));

    // The load-bearing assertion: not "both refuse something", but the same targets, the
    // same codes, the same detail strings, in the same order.
    expect(verdicts(screened)).toEqual(refusedVerdicts(outcomes));
    expect(screened.map((screening) => screening.target)).toEqual(
      outcomes.filter((outcome) => outcome.outcome === 'refused').map((outcome) => outcome.target),
    );

    // And the negative half: everything the screen stayed silent about was trashed or
    // failed — never refused. A screen that returned every target would pass the equality
    // above only if `clean` refused everything, which this pins it did not.
    expect(recorder.trashed.length).toBeGreaterThan(0);
    expect(codes(screened)).toEqual(refusalsOf(outcomes));
    expect(codes(screened).map(([, refusal]) => refusal).sort()).toEqual(
      [
        'contains-repository',
        'contains-repository',
        'guarded-path',
        'not-in-artifact-table',
        'outside-project-root',
        'store-prune-unsafe',
        'symlink',
        'unknown-cache',
        'worktree-root',
      ].sort(),
    );
  });

  it('agrees under a budget too tight to finish, where "I could not check" is the verdict', async () => {
    // The `unverified` path through the same equality: a scan that runs out of budget must
    // refuse in both, with the same wording. This is the refusal most likely to be quietly
    // dropped from a screen, because it is the one that feels like a false positive.
    const { targets, store } = mixedTargets();
    const options = { allowedCachePaths: [store.path, HOME], nestedScanMaxDirs: 1 };

    const screened = await screenTargets(targets, screenOptions(options));
    const outcomes = await clean(targets, optionsWith(recordingTrash().trash, options));

    expect(verdicts(screened)).toEqual(refusedVerdicts(outcomes));
    expect(screened.some((screening) => screening.detail.includes('too large to verify'))).toBe(
      true,
    );
  });

  it('agrees on a set with nothing wrong in it at all', async () => {
    // The other direction of the same property. Without this, `screenTargets` could return
    // every target it is given and the equality above would still hold whenever `clean`
    // happened to refuse everything.
    const app = projectAt(f.path('app'), 'app');
    const wide = projectAt(f.path('wide'), 'wide');
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);
    const targets = [
      cacheTarget(store),
      projectTarget(app, artifactAt(app.root, 'node_modules')),
      projectTarget(app, artifactAt(app.root, 'dist', 'build')),
      projectTarget(wide, artifactAt(wide.root, 'build', 'build')),
    ];
    const options = { allowedCachePaths: [store.path] };

    const screened = await screenTargets(targets, screenOptions(options));
    const recorder = recordingTrash();
    const outcomes = await clean(targets, optionsWith(recorder.trash, options));

    expect(screened).toEqual([]);
    expect(refusedVerdicts(outcomes)).toEqual([]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      'trashed',
      'trashed',
      'trashed',
      'trashed',
    ]);
  });

  it('agrees on the store prune under an unselected node_modules, both ways', async () => {
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);
    const targets = [cacheTarget(store)];
    const shared = { allowedCachePaths: [store.path] };

    for (const unselectedNodeModules of [[], [f.path('app/node_modules')]]) {
      const options = { ...shared, unselectedNodeModules };
      const screened = await screenTargets(targets, screenOptions(options));
      const outcomes = await clean(targets, optionsWith(recordingTrash().trash, options));
      expect(verdicts(screened)).toEqual(refusedVerdicts(outcomes));
    }
  });

  it('the one documented divergence is a TrashFn that fails, and it can only ADD a refusal', async () => {
    // No read-only check can know that EPERM is waiting. `clean` may therefore produce one
    // `store-prune-unsafe` the screen did not — the safe direction: the screen never
    // promises fewer refusals than it can prove, and reality only ever adds.
    const app = projectAt(f.path('app'), 'app');
    const nodeModules = artifactAt(app.root, 'node_modules');
    const store = cacheAt('pnpm-store', 'pnpm store', f.path('pnpm/store'), 8 * KB);
    const targets = [cacheTarget(store), projectTarget(app, nodeModules)];
    const options = { allowedCachePaths: [store.path] };

    expect(await screenTargets(targets, screenOptions(options))).toEqual([]);

    const recorder = recordingTrash([nodeModules.path]);
    const outcomes = await clean(targets, optionsWith(recorder.trash, options));
    expect(refusalsOf(outcomes)).toEqual([['pnpm store', 'store-prune-unsafe']]);
    expect(recorder.trashed).not.toContain(store.path);
  });
});
