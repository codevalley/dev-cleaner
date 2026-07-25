/**
 * Two guards in `discover.ts` that every existing fixture agrees with by accident.
 *
 * **(1) The scan-root-is-a-worktree branch.** `discover` asks `isLinkedWorktree(scanRoot)`
 * before it hands the root to `walkDirectory`, because `walkDirectory` can only ever say
 * `isWorktree: false` — its own worktree handling lives in the *child* loop, which the root
 * never passes through. Delete the branch and a scan root that is a linked worktree keeps
 * being discovered (it holds `package.json`, so it declares a type) but is flagged as an
 * ordinary project. Nothing about the *shape* of the result changes, which is why a fixture
 * that only counts projects or compares roots cannot see it: the flag is the whole defect,
 * and the flag is what scoring, grouping and the TUI's worktree column read.
 *
 * The second case removes the type marker: without it, a deleted branch degrades the
 * worktree from "one project rolled up at the worktree root" to "a container whose inner
 * directories are projects", which moves the root and renames the entry.
 *
 * **(2) The `.git`-kind check in `walkDirectory`.** `hasGitDirectory` requires the entry to
 * be a *directory* and not a symlink. The file case is masked by guard (1) — a `.git` file
 * is exactly what `isLinkedWorktree` matches, so with the branch in place `walkDirectory`
 * never meets one — but the **symlink** case is reachable and independent: `lstat` does not
 * follow links, so a symlinked `.git` is not a worktree either, and the dirent reports
 * `isDirectory() === false`. Drop the kind check and any directory holding a `.git`
 * *symlink* is promoted to a project root in its own right, swallowing the real projects
 * beneath it (invariant 2: a symlink is never followed, never trusted).
 *
 * Kept as separate cases on purpose: the two guards are only caught *together* by the
 * damage report, and a single test that removing both breaks would let either survive alone.
 */

import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discover } from '../src/discover.js';
import type { Category, DiscoveredProject } from '../src/types.js';
import { dir, fixture, symlink, worktree, type Fixture } from './fixture.js';

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const ALL: readonly Category[] = ['build', 'deps', 'cache'];

async function collect(roots: readonly string[]): Promise<DiscoveredProject[]> {
  const found: DiscoveredProject[] = [];
  for await (const project of discover(roots, new Set<Category>(ALL))) found.push(project);
  return found;
}

describe('scan root that is itself a linked worktree', () => {
  it('is flagged isWorktree even though it also declares a type', async () => {
    // `dev-cleaner .` from inside `git worktree add ../feature-x feature`.
    const f = await tree({
      'feature-x/.git': worktree('/repo/.git/worktrees/feature-x'),
      'feature-x/package.json': '{}',
      'feature-x/node_modules/left-pad/index.js': 'x',
    });

    const projects = await collect([f.path('feature-x')]);

    expect(projects).toHaveLength(1);
    expect(projects[0]?.root).toBe(f.path('feature-x'));
    // The whole defect: `package.json` makes `walkDirectory` emit it as an ordinary
    // project, so only the dedicated branch in `discover` can set this flag.
    expect(projects[0]?.isWorktree).toBe(true);
    expect(projects[0]?.artifacts.map((artifact) => artifact.relPath)).toEqual(['node_modules']);
  });

  it('rolls its subtree up at the worktree root when it declares no type of its own', async () => {
    const f = await tree({
      'feature-x/.git': worktree('/repo/.git/worktrees/feature-x'),
      'feature-x/crates/core/Cargo.toml': '',
      'feature-x/crates/core/target/debug/app': 'x',
    });

    const projects = await collect([f.path('feature-x')]);

    expect(projects).toHaveLength(1);
    // Without the branch this is `<root>/feature-x/crates/core`, named `crates/core`:
    // the worktree becomes a container and its inner crate becomes the project.
    expect(projects[0]?.root).toBe(f.path('feature-x'));
    expect(projects[0]?.name).toBe('feature-x');
    expect(projects[0]?.isWorktree).toBe(true);
    expect(projects[0]?.artifacts.map((artifact) => artifact.relPath)).toEqual([
      path.join('crates', 'core', 'target'),
    ]);
  });

  it('flags a worktree scan root even when it is also reachable as a container child', async () => {
    const f = await tree({
      'work/app/package.json': '{}',
      'work/app/dist/main.js': 'x',
      'work/feature-x/.git': worktree('/repo/.git/worktrees/feature-x'),
      'work/feature-x/package.json': '{}',
    });

    const projects = await collect([f.path('work', 'feature-x'), f.path('work')]);
    const feature = projects.find((project) => project.root === f.path('work', 'feature-x'));

    expect(feature).toBeDefined();
    expect(feature?.isWorktree).toBe(true);
    // `seen` keeps the second root from re-emitting it, so the flag set by the first
    // (worktree) pass is the one that ships.
    expect(projects.filter((project) => project.root === f.path('work', 'feature-x'))).toHaveLength(
      1,
    );
  });
});

describe('.git kind decides whether a directory is a project root', () => {
  it('does not make a directory a root when its .git is a symlink to a directory', async () => {
    // A `.git` symlink is neither a worktree pointer (`lstat` says symlink, not file) nor a
    // git directory (the dirent says symlink, not directory). Invariant 2: it is not
    // followed, and it does not confer roothood on the directory holding it.
    const f = await tree({
      'store/gitdir/HEAD': 'ref: refs/heads/main\n',
      'repo/.git': symlink('../store/gitdir'),
      'repo/inner/package.json': '{}',
      'repo/inner/node_modules/left-pad/index.js': 'x',
    });

    const projects = await collect([f.path('repo')]);

    expect(projects).toHaveLength(1);
    // Drop the kind check and `repo` itself is emitted, rolling `inner` up into it:
    // root becomes `<root>/repo` and the artifact becomes `inner/node_modules`.
    expect(projects[0]?.root).toBe(f.path('repo', 'inner'));
    expect(projects[0]?.name).toBe('inner');
    expect(projects[0]?.isWorktree).toBe(false);
    expect(projects[0]?.artifacts.map((artifact) => artifact.relPath)).toEqual(['node_modules']);
  });

  it('does not make a directory a root when its .git symlink dangles', async () => {
    const f = await tree({
      'repo/.git': symlink('/nonexistent/gitdir'),
      'repo/pkg/Cargo.toml': '',
      'repo/pkg/target/debug/app': 'x',
      'repo/empty': dir(),
    });

    const projects = await collect([f.path('repo')]);

    expect(projects.map((project) => project.root)).toEqual([f.path('repo', 'pkg')]);
    expect(projects[0]?.name).toBe('pkg');
  });
});
