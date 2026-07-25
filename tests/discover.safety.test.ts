/**
 * The adversarial half of the walk: the cases where a plausible implementation satisfies
 * the wording of a rule while defeating its purpose.
 *
 * Two invariants carry this file.
 *
 * **Invariant 6 — worktree detection precedes artifact matching.** `git worktree add build
 * feature` produces a linked checkout at `build/`. A walk that asks "is this basename in
 * the artifact table?" before "is this a worktree?" prunes it as build output, never lists
 * it as a project, and — at the deletion boundary — offers real source with uncommitted
 * work for deletion. The fixtures below therefore name their worktrees **`build`, `target`
 * and `dist`**, the three names the table actually claims. A fixture named
 * `namespace-foundation` passes while the invariant is broken, which is exactly how this
 * defect survives review.
 *
 * **Invariant 3 — root guards operate on the real path.** `path.resolve` normalises `..`
 * lexically but does not follow links, so `<tmp>/deep/nested/link -> /` presents as a
 * comfortable depth-5 path and sails through a lexical guard. Only `realpath` catches it,
 * and the resolved value is what the scan must then use.
 */

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { discover, isLinkedWorktree, resolveScanRoot } from '../src/discover.js';
import { SafetyError } from '../src/types.js';
import type { Category, DiscoveredProject } from '../src/types.js';
import { dir, file, fixture, symlink, worktree, type Fixture } from './fixture.js';

const execFileAsync = promisify(execFile);

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const ALL: Set<Category> = new Set<Category>(['build', 'deps', 'cache']);

async function collect(roots: readonly string[]): Promise<DiscoveredProject[]> {
  const found: DiscoveredProject[] = [];
  for await (const project of discover(roots, new Set(ALL))) found.push(project);
  return found;
}

const rootsOf = (projects: readonly DiscoveredProject[]): string[] =>
  projects.map((project) => project.root).sort();

function require_(projects: readonly DiscoveredProject[], root: string): DiscoveredProject {
  const project = projects.find((candidate) => candidate.root === root);
  expect(project, `no project discovered at ${root}`).toBeDefined();
  return project as DiscoveredProject;
}

const artifactPathsOf = (project: DiscoveredProject): string[] =>
  project.artifacts.map((artifact) => artifact.path).sort();

/** True when trashing `ancestor` would take `descendant` with it. */
const covers = (ancestor: string, descendant: string): boolean =>
  descendant === ancestor || descendant.startsWith(ancestor + path.sep);

/** Path segments below the filesystem root — the quantity invariant 3's depth guard uses. */
function depth(target: string): number {
  const { root } = path.parse(target);
  return target
    .slice(root.length)
    .split(path.sep)
    .filter((segment) => segment.length > 0).length;
}

/** A `gitdir:` pointer that intentionally goes nowhere: only `.git` being a FILE matters. */
const danglingGitdir = (name: string): string => `/nonexistent/repo/.git/worktrees/${name}`;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Fixture');
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-m', 'initial', '--no-verify');
}

// ─── invariant 3 ────────────────────────────────────────────────────────────────────────

describe('resolveScanRoot (invariant 3)', () => {
  it('refuses the filesystem root', async () => {
    await expect(resolveScanRoot(path.parse(process.cwd()).root)).rejects.toThrow(SafetyError);
    await expect(resolveScanRoot(path.parse(process.cwd()).root)).rejects.toMatchObject({
      reason: 'root-is-filesystem-root',
    });
  });

  it('refuses the user’s home directory', async () => {
    await expect(resolveScanRoot(os.homedir())).rejects.toMatchObject({
      reason: 'root-is-home',
    });
  });

  it('refuses a path one level below the filesystem root', async () => {
    const f = await tree({ placeholder: dir() });
    const fsRoot = path.parse(f.root).root;
    const firstSegment = f.root
      .slice(fsRoot.length)
      .split(path.sep)
      .filter((segment) => segment.length > 0)[0];
    const shallow = path.join(fsRoot, firstSegment!);

    expect(depth(shallow), 'the fixture must actually be shallow').toBeLessThanOrEqual(1);
    await expect(resolveScanRoot(shallow)).rejects.toMatchObject({ reason: 'root-too-shallow' });
  });

  it('refuses a SYMLINK pointing at the filesystem root — the case path.resolve passes', async () => {
    const f = await tree({ 'deep/nested/projects': symlink(path.parse(process.cwd()).root) });
    const link = f.path('deep/nested/projects');

    // Everything a lexical guard can see says this root is fine.
    expect(path.resolve(link)).toBe(link);
    expect(depth(path.resolve(link)), 'lexically deep, and therefore lexically safe').toBeGreaterThan(
      1,
    );
    expect(path.resolve(link)).not.toBe(path.parse(link).root);

    // realpath is what turns it back into `/`.
    await expect(resolveScanRoot(link)).rejects.toMatchObject({
      reason: 'root-is-filesystem-root',
    });
  });

  it('refuses a SYMLINK pointing at the home directory', async () => {
    const f = await tree({ 'deep/nested/projects': symlink(os.homedir()) });

    await expect(resolveScanRoot(f.path('deep/nested/projects'))).rejects.toMatchObject({
      reason: 'root-is-home',
    });
  });

  it('returns the REAL path of an acceptable root, not the lexical one', async () => {
    // `clean.ts` checks containment against these roots. A lexical `/var/...` root would
    // fail to contain a discovered `/private/var/...` project, and every delete would be
    // refused — the guard working by accident, in the wrong direction.
    const f = await tree({ 'projects/alpha/package.json': '{ "name": "alpha" }\n' });
    const { symlink: makeLink } = await import('node:fs/promises');
    await makeLink(f.path('projects'), f.path('link'));

    await expect(resolveScanRoot(f.path('link'))).resolves.toBe(f.path('projects'));
    await expect(resolveScanRoot(f.path('projects'))).resolves.toBe(f.path('projects'));
  });

  it('normalises `..` and a trailing separator without following them anywhere odd', async () => {
    const f = await tree({ 'projects/alpha/package.json': '{ "name": "alpha" }\n' });

    await expect(resolveScanRoot(f.path('projects/alpha/..'))).resolves.toBe(f.path('projects'));
    await expect(resolveScanRoot(`${f.path('projects')}${path.sep}`)).resolves.toBe(
      f.path('projects'),
    );
  });

  it('propagates out of discover() rather than being swallowed per-root', async () => {
    // `scan.ts` documents this: refusing to scan `/` is not a per-project failure.
    await expect(collect([os.homedir()])).rejects.toBeInstanceOf(SafetyError);
  });
});

// ─── isLinkedWorktree ───────────────────────────────────────────────────────────────────

describe('isLinkedWorktree', () => {
  it('is true when .git is a FILE and false when it is a DIRECTORY', async () => {
    const f = await tree({
      'wt': worktree(danglingGitdir('wt')),
      'main/.git/HEAD': 'ref: refs/heads/main\n',
      plain: dir(),
    });

    expect((await lstat(f.path('wt/.git'))).isFile()).toBe(true);
    await expect(isLinkedWorktree(f.path('wt'))).resolves.toBe(true);
    await expect(isLinkedWorktree(f.path('main'))).resolves.toBe(false);
    await expect(isLinkedWorktree(f.path('plain'))).resolves.toBe(false);
  });

  it('is false, never a throw, for a path that does not exist', async () => {
    await expect(isLinkedWorktree('/definitely/not/here')).resolves.toBe(false);
  });

  it('agrees with a real `git worktree add`', async () => {
    const f = await tree({
      'repo/Cargo.toml': '[package]\nname = "repo"\n',
      'repo/src/main.rs': 'fn main() {}\n',
    });
    await initRepo(f.path('repo'));
    await git(f.path('repo'), 'worktree', 'add', '-b', 'feature', 'build');

    await expect(isLinkedWorktree(f.path('repo/build'))).resolves.toBe(true);
    await expect(isLinkedWorktree(f.path('repo'))).resolves.toBe(false);
  });
});

// ─── invariant 6 ────────────────────────────────────────────────────────────────────────

describe('discover: worktrees named after artifacts (invariant 6)', () => {
  // These three names are the whole test. Any other name passes with the checks reversed.
  for (const name of ['build', 'target', 'dist'] as const) {
    it(`treats a linked worktree named \`${name}\` as a project root, never an artifact`, async () => {
      const f = await tree({
        // Declares node AND rust, so `build`, `dist` and `target` are all names the
        // artifact table claims inside this project.
        'repo/package.json': '{ "name": "repo" }\n',
        'repo/Cargo.toml': '[package]\nname = "repo"\n',
        'repo/src/main.rs': 'fn main() {}\n',
        'repo/node_modules/dep/index.js': file('n', { size: 1024 }),

        [`repo/${name}`]: worktree(danglingGitdir(name)),
        [`repo/${name}/package.json`]: '{ "name": "repo" }\n',
        [`repo/${name}/src/app.js`]: 'export const uncommitted = true;\n',
        [`repo/${name}/node_modules/dep/index.js`]: file('w', { size: 2048 }),
      });

      const worktreeRoot = f.path(`repo/${name}`);
      const projects = await collect([f.root]);

      // 1. It is a root of its own.
      expect(rootsOf(projects), `\`${name}\` must be a project root`).toEqual(
        [f.path('repo'), worktreeRoot].sort(),
      );
      expect(require_(projects, worktreeRoot).isWorktree).toBe(true);
      expect(require_(projects, f.path('repo')).isWorktree).toBe(false);

      // 2. The parent never claims it — directly or by containment.
      const parentArtifacts = artifactPathsOf(require_(projects, f.path('repo')));
      expect(parentArtifacts).toEqual([f.path('repo/node_modules')]);
      for (const artifact of parentArtifacts) {
        expect(covers(artifact, worktreeRoot), `${artifact} would delete the worktree`).toBe(
          false,
        );
      }

      // 3. Nothing anywhere offers the worktree root itself as a delete target. This is
      //    the invariant stated as the consequence it prevents.
      for (const project of projects) {
        for (const artifact of artifactPathsOf(project)) {
          expect(
            covers(artifact, worktreeRoot),
            `${artifact} would delete the worktree root ${worktreeRoot}`,
          ).toBe(false);
          expect(
            covers(artifact, f.path(`repo/${name}/src/app.js`)),
            `${artifact} would delete uncommitted source`,
          ).toBe(false);
        }
      }

      // 4. Its own build output is still reclaimable — protection is of the checkout, not
      //    of the artifacts beside it.
      expect(artifactPathsOf(require_(projects, worktreeRoot))).toEqual([
        f.path(`repo/${name}/node_modules`),
      ]);
    });
  }

  it('treats a worktree named `build` sitting directly in a container as a root', async () => {
    // The same ordering has to hold in the container walk, where no project encloses it.
    const f = await tree({
      'build': worktree(danglingGitdir('build')),
      'build/Cargo.toml': '[package]\nname = "detached"\n',
      'build/target/debug/app': file('t', { size: 1024 }),
      'other/package.json': '{ "name": "other" }\n',
    });

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual([f.path('build'), f.path('other')].sort());
    expect(artifactPathsOf(require_(projects, f.path('build')))).toEqual([
      f.path('build/target'),
    ]);
  });
});

describe('discover: nested worktrees', () => {
  it('emerges as its own root rather than being absorbed into the parent', async () => {
    const f = await tree({
      'tinysync/Cargo.toml': '[package]\nname = "tinysync"\n',
      'tinysync/src/main.rs': 'fn main() {}\n',
      'tinysync/target/debug/tinysync': file('t', { size: 1024 }),
      'tinysync/.worktrees/build': worktree(danglingGitdir('build')),
      'tinysync/.worktrees/build/Cargo.toml': '[package]\nname = "tinysync"\n',
      'tinysync/.worktrees/build/src/lib.rs': 'pub fn feature() {}\n',
      'tinysync/.worktrees/build/target/debug/huge.rlib': file('w', { size: 4096 }),
    });
    const worktreeRoot = f.path('tinysync/.worktrees/build');

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual([f.path('tinysync'), worktreeRoot].sort());
    expect(require_(projects, worktreeRoot).isWorktree).toBe(true);
  });

  it('attributes the worktree’s artifacts to IT, not to the parent', async () => {
    const f = await tree({
      'tinysync/Cargo.toml': '[package]\nname = "tinysync"\n',
      'tinysync/target/debug/tinysync': file('t', { size: 1024 }),
      'tinysync/.worktrees/build': worktree(danglingGitdir('build')),
      'tinysync/.worktrees/build/Cargo.toml': '[package]\nname = "tinysync"\n',
      'tinysync/.worktrees/build/target/debug/huge.rlib': file('w', { size: 4096 }),
    });
    const worktreeRoot = f.path('tinysync/.worktrees/build');

    const projects = await collect([f.root]);

    expect(artifactPathsOf(require_(projects, f.path('tinysync')))).toEqual([
      f.path('tinysync/target'),
    ]);
    expect(artifactPathsOf(require_(projects, worktreeRoot))).toEqual([
      f.path('tinysync/.worktrees/build/target'),
    ]);
  });

  it('still yields a DORMANT worktree inside an ACTIVE parent', async () => {
    // The regression to hold onto (spec, "Worktree cases"). Under plain roll-up the
    // worktree's output is attributed to the parent and inherits the parent's recency, so
    // the single largest reclaimable item on the reference machine disappears from the
    // list. `discover` does not score — what it must guarantee is that the worktree is a
    // separate root, which is the only thing that lets `activity.ts` score it separately.
    const now = Date.now();
    const fresh = now - 60_000; // parent source touched a minute ago
    const stale = now - 300 * 24 * 60 * 60 * 1000; // worktree untouched for ~10 months

    const f = await tree({
      'mono/Cargo.toml': file('[package]\nname = "mono"\n', { mtime: fresh }),
      'mono/src/main.rs': file('fn main() {}\n', { mtime: fresh }),
      'mono/target/debug/mono': file('t', { size: 1024, mtime: fresh }),
      'mono/.worktrees/build': worktree(danglingGitdir('build')),
      'mono/.worktrees/build/Cargo.toml': file('[package]\nname = "mono"\n', { mtime: stale }),
      'mono/.worktrees/build/src/lib.rs': file('pub fn old() {}\n', { mtime: stale }),
      'mono/.worktrees/build/target/debug/huge.rlib': file('w', { size: 8192, mtime: stale }),
    });
    const worktreeRoot = f.path('mono/.worktrees/build');

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toContain(worktreeRoot);
    const wt = require_(projects, worktreeRoot);
    expect(wt.isWorktree).toBe(true);
    expect(artifactPathsOf(wt), 'the dormant output is still offered').toEqual([
      f.path('mono/.worktrees/build/target'),
    ]);
    // The parent's own artifacts are separate, so the two can be scored independently.
    expect(artifactPathsOf(require_(projects, f.path('mono')))).toEqual([f.path('mono/target')]);
  });

  it('does not let a worktree’s markers leak into the parent’s type set', async () => {
    const f = await tree({
      'repo/Cargo.toml': '[package]\nname = "repo"\n',
      'repo/dist': worktree(danglingGitdir('dist')),
      // Only the worktree declares node; the parent must stay pure rust.
      'repo/dist/package.json': '{ "name": "web" }\n',
      'repo/dist/node_modules/dep/index.js': file('n', { size: 512 }),
    });

    const projects = await collect([f.root]);

    expect([...require_(projects, f.path('repo')).types].sort()).toEqual(['rust']);
    expect([...require_(projects, f.path('repo/dist')).types].sort()).toEqual(['node']);
  });

  it('finds a worktree nested inside another worktree', async () => {
    const f = await tree({
      'repo/Cargo.toml': '[package]\nname = "repo"\n',
      'repo/build': worktree(danglingGitdir('build')),
      'repo/build/Cargo.toml': '[package]\nname = "repo"\n',
      'repo/build/target': worktree(danglingGitdir('target')),
      'repo/build/target/Cargo.toml': '[package]\nname = "repo"\n',
      'repo/build/target/target/debug/app': file('x', { size: 512 }),
    });

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual(
      [f.path('repo'), f.path('repo/build'), f.path('repo/build/target')].sort(),
    );
    expect(artifactPathsOf(require_(projects, f.path('repo/build/target')))).toEqual([
      f.path('repo/build/target/target'),
    ]);
  });

  it('handles a real `git worktree add build feature` end to end', async () => {
    const f = await tree({
      'projects/mono/Cargo.toml': '[package]\nname = "mono"\n',
      'projects/mono/src/main.rs': 'fn main() {}\n',
      'projects/mono/.gitignore': 'target/\n',
    });
    const mono = f.path('projects/mono');
    await initRepo(mono);
    await git(mono, 'worktree', 'add', '-b', 'feature', 'build');

    const projects = await collect([f.path('projects')]);

    expect(rootsOf(projects)).toEqual([mono, f.path('projects/mono/build')].sort());
    expect(require_(projects, f.path('projects/mono/build')).isWorktree).toBe(true);
    // The checkout git just created holds the repository's source. Nothing may cover it.
    for (const project of projects) {
      for (const artifact of artifactPathsOf(project)) {
        expect(covers(artifact, f.path('projects/mono/build/src/main.rs'))).toBe(false);
      }
    }
  });
});

// ─── invariant 2, at the walk ───────────────────────────────────────────────────────────

describe('discover: symlinks are never followed', () => {
  it('does not discover a project reachable only through a symlink', async () => {
    const f = await tree({
      'outside/hidden-project/package.json': '{ "name": "hidden" }\n',
      'outside/hidden-project/dist/out.js': file('d', { size: 512 }),
      'scan/real/Cargo.toml': '[package]\nname = "real"\n',
    });
    const { symlink: makeLink } = await import('node:fs/promises');
    await makeLink(f.path('outside'), f.path('scan/link'));

    const projects = await collect([f.path('scan')]);

    expect(rootsOf(projects)).toEqual([f.path('scan/real')]);
    expect(rootsOf(projects)).not.toContain(f.path('scan/link/hidden-project'));
  });

  it('never turns an artifact-named symlink into an artifact', async () => {
    // `~/develop/magicalll/build -> $HOME`. Following it sizes, then trashes, the user's
    // whole home directory.
    const f = await tree({
      'proj/package.json': '{ "name": "proj" }\n',
      'proj/node_modules/dep/index.js': file('n', { size: 512 }),
      'proj/build': symlink(os.homedir()),
      'proj/dist': symlink(os.homedir()),
    });

    const project = require_(await collect([f.root]), f.path('proj'));

    expect((await lstat(f.path('proj/build'))).isSymbolicLink()).toBe(true);
    expect(artifactPathsOf(project)).toEqual([f.path('proj/node_modules')]);
    expect(artifactPathsOf(project)).not.toContain(f.path('proj/build'));
    expect(artifactPathsOf(project)).not.toContain(os.homedir());
  });

  it('does not collect types through a symlink inside a project', async () => {
    // The declaration walk is the other place a link can be followed, and its damage is
    // quieter: a link to a Flutter tree makes this rust project claim `build`,
    // `.dart_tool` and `Pods` everywhere inside itself.
    const f = await tree({
      'outside/flutter-app/pubspec.yaml': 'name: app\n',
      'outside/flutter-app/lib/main.dart': 'void main() {}\n',
      'proj/Cargo.toml': '[package]\nname = "proj"\n',
      'proj/src/main.rs': 'fn main() {}\n',
      'proj/target/debug/proj': file('t', { size: 512 }),
      // A directory that is emphatically NOT an artifact name, so nothing else prunes it.
      'proj/vendored/keep': dir(),
    });
    const { rm, symlink: makeLink } = await import('node:fs/promises');
    await rm(f.path('proj/vendored/keep'), { recursive: true });
    await makeLink(f.path('outside/flutter-app'), f.path('proj/vendored/linked'));

    const project = require_(await collect([f.path('proj')]), f.path('proj'));

    expect([...project.types].sort(), 'flutter leaked in through the link').toEqual(['rust']);
    expect(artifactPathsOf(project)).toEqual([f.path('proj/target')]);
  });

  it('terminates on a symlink cycle inside a project', async () => {
    // `proj/self -> proj`. A walk that follows links recurses until the process dies; the
    // failure mode is a hang, so the assertion is simply that this returns.
    const f = await tree({
      'proj/Cargo.toml': '[package]\nname = "proj"\n',
      'proj/src/main.rs': 'fn main() {}\n',
      'proj/target/debug/proj': file('t', { size: 512 }),
    });
    const { symlink: makeLink } = await import('node:fs/promises');
    await makeLink(f.path('proj'), f.path('proj/self'));

    const project = require_(await collect([f.path('proj')]), f.path('proj'));

    expect(artifactPathsOf(project)).toEqual([f.path('proj/target')]);
  });

  it('does not treat a symlinked project directory as a root, even at the scan root', async () => {
    const f = await tree({ 'real/package.json': '{ "name": "real" }\n' });
    const { symlink: makeLink } = await import('node:fs/promises');
    await makeLink(f.path('real'), f.path('alias'));

    // Reached as a *child* of the scan root, the link is skipped outright...
    expect(rootsOf(await collect([f.root]))).toEqual([f.path('real')]);
    // ...and named as the scan root it is resolved to its real path, never duplicated.
    expect(rootsOf(await collect([f.path('alias')]))).toEqual([f.path('real')]);
  });
});
