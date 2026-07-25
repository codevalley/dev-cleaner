/**
 * The suite `findNestedRepository` should have shipped with.
 *
 * `clean.ts` asks "is there a git repository here?" in three separate ways — the candidate
 * itself is a repository (`.git` a directory), the candidate is a linked worktree (`.git` a
 * file), and the candidate *contains* either one within a few levels. The three shared no
 * test, and the one test that existed (`clean.regressions.test.ts`, the `gh-pages` clone)
 * is satisfied by *either* the direct check or the contents scan, so deleting the direct
 * check left the suite green. Every case here therefore pins one mechanism in a situation
 * where the others cannot answer for it:
 *
 * - the direct `.git`-is-a-directory check is pinned on candidates the contents scan is
 *   exempt from (`node_modules`, and caches), where nothing else can catch it;
 * - the contents scan is pinned on candidates whose own `.git` does not exist at all;
 * - the depth limit is pinned at its documented maximum, so shortening it fails;
 * - the budget is pinned in both directions: an unfinished scan must refuse, and a
 *   finished one on the same tree must not.
 *
 * Three defects motivated the fixes these tests cover, all of them silent data loss:
 *
 * 1. **The exemption was the whole `deps` category.** The reasoning was about
 *    `node_modules` — git-installed npm packages leave reproducible `.git` directories
 *    everywhere — but `deps` also covers `.venv`, `venv`, `vendor/bundle` and `Pods`.
 *    `pip install -e git+ssh://…#egg=mylib` puts a clone with unpushed commits at
 *    `.venv/src/mylib/.git`, and `--preset aggressive` trashed it without a word.
 * 2. **The budget failed open on exactly the biggest directories.** 2,000 directories,
 *    breadth-first: the reference machine's 67 GB `target/` has 8,187 directories at depth
 *    ≤ 3, so the budget was gone before the walk finished depth 3 and every repository
 *    below that was invisible. Exhaustion returned "nothing found".
 * 3. **It ran on global caches.** `~/.pub-cache` stores every git-sourced Dart package as a
 *    full clone at `~/.pub-cache/git/<pkg>-<sha>/.git`, so the cache could never be cleaned
 *    by anyone, ever — and a guard nobody can satisfy is a guard that gets switched off.
 *
 * Nothing here deletes: the `TrashFn` records, and every refusal is paired with an
 * assertion that the recorder never saw the path.
 */

import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NESTED_SCAN_MAX_DIRS,
  clean,
  findNestedRepository,
  nestedScanBudget,
  type CleanOptions,
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
  TrashFn,
} from '../src/types.js';
import { fixture, worktree, type Fixture } from './fixture.js';

const KB = 1024;
const DORMANT: ActivityScore = { status: 'dormant', idleMs: 0, reason: 'test fixture' };

/** A `.git` file's pointer. Nothing reads it; what matters is that `.git` is a FILE. */
const DANGLING_GITDIR = '/nonexistent/repo/.git/worktrees/wip';

function artifactAt(root: string, rel: string, category: Category): Artifact {
  return { path: path.join(root, rel), relPath: rel, category, bytes: KB };
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

function cacheAt(id: string, label: string, target: string): CacheEntry {
  return { id, label, path: target, bytes: 8 * KB, note: 'test cache' };
}

function recordingTrash(): { trash: TrashFn; trashed: string[] } {
  const trashed: string[] = [];
  return { trash: async (paths) => void trashed.push(...paths), trashed };
}

let f: Fixture;

/**
 * Cleans one project artifact at `<root>/<rel>` and returns its single outcome plus what
 * the recorder saw. Everything the guards read is derived from the real fixture tree.
 */
async function cleanArtifact(
  root: string,
  rel: string,
  category: Category,
  overrides: Partial<CleanOptions> = {},
): Promise<{ outcome: CleanOutcome; trashed: string[] }> {
  const project = projectAt(f.path(root), root);
  const artifact = artifactAt(project.root, rel, category);
  project.artifacts = [artifact];

  const recorder = recordingTrash();
  const outcomes = await clean([{ kind: 'project', project, artifact } satisfies CleanTarget], {
    trash: recorder.trash,
    roots: [f.root],
    allowedCachePaths: [],
    unselectedNodeModules: [],
    ...overrides,
  });

  expect(outcomes).toHaveLength(1);
  return { outcome: outcomes[0] as CleanOutcome, trashed: recorder.trashed };
}

/** The same, for a global cache target, allowlisted exactly as the scan would have. */
async function cleanCache(
  rel: string,
  overrides: Partial<CleanOptions> = {},
): Promise<{ outcome: CleanOutcome; trashed: string[] }> {
  const cache = cacheAt('pub-cache', 'pub cache', f.path(rel));
  const recorder = recordingTrash();
  const outcomes = await clean([{ kind: 'cache', cache } satisfies CleanTarget], {
    trash: recorder.trash,
    roots: [f.root],
    allowedCachePaths: [cache.path],
    unselectedNodeModules: [],
    ...overrides,
  });

  expect(outcomes).toHaveLength(1);
  return { outcome: outcomes[0] as CleanOutcome, trashed: recorder.trashed };
}

beforeAll(async () => {
  f = await fixture({
    // ── defect 1: `deps` names that are NOT node_modules ─────────────────────────────
    // `pip install -e git+ssh://git@github.com/me/mylib#egg=mylib` — the documented way to
    // work on a dependency in place. The clone is real, and its commits may be unpushed.
    'pyapp/pyproject.toml': '[project]\nname = "pyapp"\n',
    'pyapp/.venv/pyvenv.cfg': 'home = /usr/bin\n',
    'pyapp/.venv/src/mylib/.git/HEAD': 'ref: refs/heads/main\n',
    'pyapp/.venv/src/mylib/mylib/__init__.py': '__version__ = "0.1.0"\n',

    // The other two `deps` names. Both are places a git checkout can land — a git-sourced
    // gem under `vendor/bundle`, a pod vendored under `Pods/`. Note that bundler's own
    // layout puts the checkout at `vendor/bundle/ruby/<ver>/bundler/gems/<gem>-<sha>`,
    // which is *deeper* than the scan looks: what these fixtures pin is that the names are
    // scanned at all, not that every arrangement beneath them is reachable.
    'rbapp/Gemfile': "source 'https://rubygems.org'\n",
    'rbapp/vendor/bundle/gems/mygem/.git/HEAD': 'ref: refs/heads/main\n',

    'iosapp/Podfile': "platform :ios, '17.0'\n",
    'iosapp/Pods/MyPod/.git/HEAD': 'ref: refs/heads/main\n',

    // The exemption that must SURVIVE: npm's git dependencies, reproducible by reinstall.
    'webapp/package.json': '{ "name": "webapp" }\n',
    'webapp/node_modules/left-pad/index.js': 'module.exports = 1;\n',
    'webapp/node_modules/forked-dep/.git/HEAD': 'ref: refs/heads/main\n',

    // ...but a `node_modules` that IS a repository, or IS a worktree, is still refused —
    // the contents scan is exempt there, so only the direct checks can catch these.
    'cloned/package.json': '{ "name": "cloned" }\n',
    'cloned/node_modules/.git/HEAD': 'ref: refs/heads/vendored\n',
    'cloned/node_modules/left-pad/index.js': 'module.exports = 1;\n',
    'wtdeps/package.json': '{ "name": "wtdeps" }\n',
    'wtdeps/node_modules': worktree(DANGLING_GITDIR),

    // ── the contents scan itself, on a candidate whose own .git does not exist ────────
    // `git worktree add build/wip feature` — real source, one level down.
    'site/package.json': '{ "name": "site" }\n',
    'site/build/assets/app.js': 'console.log(1);\n',
    'site/build/wip': worktree(DANGLING_GITDIR),
    'site/build/wip/index.html': '<!doctype html>\n',

    // The depth limit at its documented maximum: `wip` sits at depth 4 below `target`.
    'deep/Cargo.toml': '[package]\nname = "deep"\n',
    'deep/target/a/b/c/wip/.git/HEAD': 'ref: refs/heads/spike\n',

    // ── defect 2: the budget ─────────────────────────────────────────────────────────
    // A build tree with many shallow entries and a repository below them: what the old
    // 2,000-directory budget met on a real `target/`, in miniature.
    'rust/Cargo.toml': '[package]\nname = "rust"\n',
    'rust/target/debug/.fingerprint/aaa/lib-aaa': 'x',
    'rust/target/debug/.fingerprint/bbb/lib-bbb': 'x',
    'rust/target/debug/.fingerprint/ccc/lib-ccc': 'x',
    'rust/target/debug/build/ddd/output': 'x',
    'rust/target/debug/deps/eee/note': 'x',
    'rust/target/wip/.git/HEAD': 'ref: refs/heads/spike\n',

    // The same shape with NO repository anywhere: the control for "an unfinished scan
    // refuses", which must not be satisfiable by refusing everything.
    'plain/Cargo.toml': '[package]\nname = "plain"\n',
    'plain/target/debug/.fingerprint/aaa/lib-aaa': 'x',
    'plain/target/debug/.fingerprint/bbb/lib-bbb': 'x',
    'plain/target/debug/build/ccc/output': 'x',
    'plain/target/release/note': 'x',

    // ── defect 3: caches ─────────────────────────────────────────────────────────────
    // ~/.pub-cache's documented layout: every git-sourced Dart package is a full clone.
    'pub-cache/hosted/pub.dev/http-1.2.0/lib/http.dart': 'library http;\n',
    'pub-cache/git/mylib-9f8e7d6/.git/HEAD': 'ref: refs/heads/main\n',
    'pub-cache/git/mylib-9f8e7d6/lib/mylib.dart': 'library mylib;\n',

    // A "cache" that is itself a repository. Caches skip the contents scan, so the direct
    // `.git`-is-a-directory check is the only thing standing between this and the trash.
    'repo-cache/.git/HEAD': 'ref: refs/heads/main\n',
    'repo-cache/payload/blob': 'x',
  });
});

afterAll(async () => {
  await f?.cleanup();
});

describe('defect 1: the exemption is a NAME, not the `deps` category', () => {
  it('refuses a .venv holding an editable git install (pip install -e git+ssh://…)', async () => {
    // The scenario the category-wide exemption trashed: `.venv/src/mylib/.git` is a clone
    // whose commits may exist nowhere else, inside a `deps` artifact that is not
    // node_modules. Under `--preset aggressive` this was selected and deleted silently.
    const { outcome, trashed } = await cleanArtifact('pyapp', '.venv', 'deps');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    expect(outcome.detail).toContain(f.path('pyapp/.venv/src/mylib/.git'));
    expect(trashed).toHaveLength(0);
  });

  it.each([
    ['rbapp', path.join('vendor', 'bundle'), path.join('rbapp', 'vendor', 'bundle', 'gems', 'mygem', '.git')],
    ['iosapp', 'Pods', path.join('iosapp', 'Pods', 'MyPod', '.git')],
  ])('refuses %s/%s, which is `deps` but is not node_modules', async (root, rel, expected) => {
    // The category covers four names; the reasoning covered one. Every other name in it is
    // somewhere a real checkout can sit, so every other name must be scanned.
    const { outcome, trashed } = await cleanArtifact(root, rel, 'deps');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    expect(outcome.detail).toContain(f.path(expected));
    expect(trashed).toHaveLength(0);
  });

  it('still trashes a node_modules full of git-installed dependencies', async () => {
    // The other direction, without which the tests above could be passed by scanning
    // everything: npm's git dependencies leave `.git` directories throughout node_modules
    // and every one is reproducible by `npm install`. Refusing here would make the largest
    // category on the machine permanently unclearable.
    const { outcome, trashed } = await cleanArtifact('webapp', 'node_modules', 'deps');

    expect(outcome.outcome).toBe('trashed');
    expect(trashed).toEqual([f.path('webapp/node_modules')]);
  });

  it('exempts by real basename, so the category on the artifact cannot change the answer', async () => {
    // `category` is display-adjacent data the caller supplies; the exemption must not be
    // reachable by mislabelling. A `.venv` labelled `build` is still scanned, and a
    // node_modules labelled `build` is still exempt.
    const venv = await cleanArtifact('pyapp', '.venv', 'build');
    expect(venv.outcome.refusal).toBe('contains-repository');

    const deps = await cleanArtifact('webapp', 'node_modules', 'build');
    expect(deps.outcome.outcome).toBe('trashed');
  });
});

describe('the direct repository checks, pinned where the contents scan cannot help', () => {
  it('refuses a node_modules that is itself a git repository', async () => {
    // node_modules is exempt from the contents scan, so if the direct
    // `.git`-is-a-directory check is removed this is trashed and its history is gone.
    const { outcome, trashed } = await cleanArtifact('cloned', 'node_modules', 'deps');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    // The DIRECT wording, not the contents-scan wording: the two mechanisms are pinned
    // apart, so satisfying this with the scan alone is not possible.
    expect(outcome.detail).toContain('its .git is a directory');
    expect(trashed).toHaveLength(0);
  });

  it('refuses a node_modules that is a linked worktree (.git is a FILE)', async () => {
    // Invariant 6 at the deletion boundary, likewise unreachable by the contents scan.
    const { outcome, trashed } = await cleanArtifact('wtdeps', 'node_modules', 'deps');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('worktree-root');
    expect(trashed).toHaveLength(0);
  });

  it('refuses a cache directory that is itself a git repository', async () => {
    // Caches skip the contents scan entirely (defect 3), which leaves the direct check as
    // the only guard here. Deleting it deletes this repository.
    const { outcome, trashed } = await cleanCache('repo-cache');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    expect(outcome.detail).toContain('its .git is a directory');
    expect(trashed).toHaveLength(0);
  });
});

describe('the contents scan, pinned where the direct checks cannot help', () => {
  it('refuses a build/ containing a linked worktree one level down', async () => {
    // `git worktree add build/wip feature`. `build` itself has no `.git` of any kind, so
    // only the contents scan can see this; trashing `build` takes `wip` with it.
    const { outcome, trashed } = await cleanArtifact('site', 'build', 'build');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    expect(outcome.detail).toContain(f.path('site/build/wip/.git'));
    expect(trashed).toHaveLength(0);
  });

  it('looks all the way to the documented depth (a repository 4 levels down)', async () => {
    // `target/a/b/c/wip/.git`. Shortening the depth limit — to 0, or to 3 — passes every
    // other test in this file and fails this one.
    const { outcome, trashed } = await cleanArtifact('deep', 'target', 'build');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    expect(outcome.detail).toContain(f.path('deep/target/a/b/c/wip/.git'));
    expect(trashed).toHaveLength(0);
  });

  it('finds a repository behind many shallow siblings', async () => {
    // The shape of the real defect: `.fingerprint`, `build` and `deps` full of entries,
    // and `target/wip/.git` sitting beside them. With the budget intact this is a definite
    // answer, and the answer names the repository.
    const { outcome, trashed } = await cleanArtifact('rust', 'target', 'build');

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    expect(outcome.detail).toContain(f.path('rust/target/wip/.git'));
    expect(trashed).toHaveLength(0);
  });

  it('trashes a build tree with no repository in it', async () => {
    // The control for every refusal above: the guard is targeted, not a blanket "no".
    const { outcome, trashed } = await cleanArtifact('plain', 'target', 'build');

    expect(outcome.outcome).toBe('trashed');
    expect(trashed).toEqual([f.path('plain/target')]);
  });
});

describe('defect 2: an exhausted budget is not an answer', () => {
  it('reports `unverified`, never `clear`, when it runs out of directories', async () => {
    // One directory of budget cannot get past the candidate itself, whatever order the
    // filesystem returns entries in — so the result is "I do not know", not "nothing here".
    const scan = await findNestedRepository(f.path('rust/target'), 1);

    expect(scan).toEqual({ kind: 'unverified', visited: 1 });
  });

  it('never reports `clear` for a tree it could not finish, whatever the traversal order', async () => {
    // The order-independent safety property, stated against the tree whose repository is
    // deeper than the budget can reach: the one thing this must never return is `clear`.
    for (const budget of [0, 1, 2, 3]) {
      const scan = await findNestedRepository(f.path('rust/target'), budget);
      expect(scan.kind).not.toBe('clear');
    }
  });

  it('reports `clear` only when the whole tree was walked', async () => {
    // ...and the same scan, unbudgeted, on the tree with nothing in it. Without this the
    // test above passes against a scanner that never says `clear` at all.
    const scan = await findNestedRepository(f.path('plain/target'));

    expect(scan.kind).toBe('clear');
  });

  it('refuses through `clean` when the scan could not finish, even with no repository present', async () => {
    // The live path, and the whole point of the fix: `plain/target` has no repository, but
    // the scan did not get far enough to say so, and "we did not look" must not be reported
    // to the user as "safe to delete". A sibling with many entries must never cost a repo.
    const { outcome, trashed } = await cleanArtifact('plain', 'target', 'build', {
      nestedScanMaxDirs: 1,
    });

    expect(outcome.outcome).toBe('refused');
    expect(outcome.refusal).toBe('contains-repository');
    expect(outcome.detail).toMatch(/too large to verify/);
    expect(trashed).toHaveLength(0);
  });

  it('is a budget on directories, not a blanket refusal: the same tree passes when finished', async () => {
    // Same fixture, same code path, budget restored. A refusal that cannot be lifted by
    // giving the scan enough room would just be "never delete a build directory".
    const { outcome, trashed } = await cleanArtifact('plain', 'target', 'build');

    expect(outcome.outcome).toBe('trashed');
    expect(trashed).toEqual([f.path('plain/target')]);
  });

  it('keeps enough budget for the largest build tree on the reference machine', async () => {
    // The measurement the budget is chosen from: that machine's 67 GB `target/` presents
    // 11,423 directories at depth ≤ 4 (8,187 of them at depth ≤ 3, which is where the old
    // 2,000 was spent). A budget below that number makes the guard inert on precisely the
    // directories worth cleaning — the defect this file exists for.
    expect(NESTED_SCAN_MAX_DIRS).toBeGreaterThanOrEqual(2 * 11_423);
  });

  it('treats the budget option as tighten-only', () => {
    // Lower values only ever produce more refusals, so exposing the knob cannot widen the
    // guard: anything at or above the shipped budget — and anything that does not compare,
    // like NaN — collapses to the shipped budget, and negatives clamp to 0 (refuse).
    expect(nestedScanBudget(undefined)).toBe(NESTED_SCAN_MAX_DIRS);
    expect(nestedScanBudget(NESTED_SCAN_MAX_DIRS + 1)).toBe(NESTED_SCAN_MAX_DIRS);
    expect(nestedScanBudget(Number.POSITIVE_INFINITY)).toBe(NESTED_SCAN_MAX_DIRS);
    expect(nestedScanBudget(Number.NaN)).toBe(NESTED_SCAN_MAX_DIRS);
    expect(nestedScanBudget(7)).toBe(7);
    expect(nestedScanBudget(7.9)).toBe(7);
    expect(nestedScanBudget(-1)).toBe(0);
  });
});

describe('defect 3: global caches are allowlisted by path, not scanned', () => {
  it('cleans ~/.pub-cache even though its documented layout is full of clones', async () => {
    // Every git-sourced Dart package lives at `git/<pkg>-<sha>/.git`. Scanning caches made
    // this cache permanently unclearable, for every user, with nothing they could do about
    // it — and an unsatisfiable guard is one that gets switched off wholesale.
    const { outcome, trashed } = await cleanCache('pub-cache');

    expect(outcome.outcome).toBe('trashed');
    expect(trashed).toEqual([f.path('pub-cache')]);
  });

  it('still refuses a cache path this scan did not produce', async () => {
    // What actually protects caches: the exact-path allowlist. It has to be shown working
    // in the same file that removes the contents scan from them.
    const recorder = recordingTrash();
    const cache = cacheAt('pub-cache', 'pub cache', f.path('pub-cache'));
    const outcomes = await clean([{ kind: 'cache', cache } satisfies CleanTarget], {
      trash: recorder.trash,
      roots: [f.root],
      allowedCachePaths: [f.path('some/other/cache')],
      unselectedNodeModules: [],
    });

    expect(outcomes[0]?.outcome).toBe('refused');
    expect(outcomes[0]?.refusal).toBe('unknown-cache');
    expect(recorder.trashed).toHaveLength(0);
  });
});
