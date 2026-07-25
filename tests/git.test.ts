/**
 * `readGitInfo` is the one module that runs a subprocess with `cwd` set to a directory the
 * walk merely *found*. That makes it the tool's only remote-code-execution surface, and
 * **safety invariant 7 is the whole point of the module**: a repository the user downloaded
 * rather than authored can set `core.fsmonitor` in its own `.git/config` to an arbitrary
 * command, which `git status` executes during index refresh — arbitrary code running during
 * what the user believes is a read-only disk survey. `core.hooksPath` is a second vector.
 *
 * The tests below are therefore in two halves.
 *
 * 1. **Behaviour**, against real repositories built with real `git` — branch, last commit,
 *    a dirty tree, a real `git worktree add`, and the several ways a directory can fail to
 *    be a repository at all. No mocks: the module's entire job is interpreting what `git`
 *    says, so a fake `git` would test only the fake.
 *
 * 2. **Invariant 7**, twice over:
 *    - a repository whose `.git/config` points `core.fsmonitor` at a sentinel-writing
 *      script. The test first proves the fixture is *genuinely dangerous* by running an
 *      unhardened `git status` and asserting the sentinel appears — otherwise a future git
 *      release that ignores the setting would turn this into a test that passes while
 *      proving nothing — then removes it and asserts `readGitInfo` leaves none.
 *    - a `git` **shim first on `PATH`** that records the argv and environment of *every*
 *      invocation. The sentinel test only covers the call that happens to refresh the
 *      index; the plan's warning is "miss one call site and the hole is open", so the
 *      hardening is asserted per-invocation rather than per-vector.
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  rm,
  symlink as fsSymlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { readGitInfo } from '../src/git.js';
import { file, fixture, worktree, type Fixture } from './fixture.js';

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

/**
 * Real `git`, for building fixtures. Deliberately NOT the module's hardened runner — a
 * fixture built with the code under test would be blind to the bug it is meant to catch.
 * The identity variables keep commits deterministic whatever the machine's global config.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
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
  return stdout;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Fixture');
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-m', 'initial', '--no-verify');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** A minimal node project, committed. */
async function repoFixture(): Promise<Fixture> {
  const f = await tree({
    'repo/package.json': '{ "name": "repo" }\n',
    'repo/.gitignore': 'node_modules/\n',
    'repo/src/index.js': 'export const a = 1;\n',
    'repo/node_modules/dep/index.js': file('n', { size: 512 }),
  });
  await initRepo(f.path('repo'));
  return f;
}

describe('readGitInfo: repositories', () => {
  it('reads the branch and the last commit time of a real repository', async () => {
    const f = await repoFixture();

    const info = await readGitInfo(f.path('repo'));

    expect(info, 'a repository yields git info').toBeDefined();
    expect(info!.branch).toBe('main');
    expect(info!.lastCommitMs, 'last commit is epoch milliseconds, not seconds').toBeGreaterThan(
      Date.now() - 5 * 60_000,
    );
    expect(info!.lastCommitMs).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(info!.hasUncommittedChanges, 'a freshly committed tree is clean').toBe(false);
    expect(info!.isWorktree, 'a main checkout has a .git DIRECTORY').toBe(false);
    expect(info!.worktree, 'worktree context is for linked worktrees only').toBeUndefined();
  });

  it('reports a modified tracked file as uncommitted changes', async () => {
    const f = await repoFixture();
    await appendFile(f.path('repo/src/index.js'), 'export const b = 2;\n');

    const info = await readGitInfo(f.path('repo'));

    expect(info).toBeDefined();
    expect(info!.hasUncommittedChanges).toBe(true);
  });

  it('reports an untracked file as uncommitted changes', async () => {
    const f = await repoFixture();
    await writeFile(f.path('repo/src/added.js'), 'export const c = 3;\n');

    const info = await readGitInfo(f.path('repo'));

    expect(info).toBeDefined();
    expect(info!.hasUncommittedChanges, 'untracked work counts as work').toBe(true);
  });

  it('ignores files the repository ignores', async () => {
    const f = await repoFixture();
    // node_modules is gitignored: build output must never make a project look active.
    await writeFile(f.path('repo/node_modules/dep/extra.js'), 'module.exports = 1;\n');

    const info = await readGitInfo(f.path('repo'));

    expect(info).toBeDefined();
    expect(info!.hasUncommittedChanges).toBe(false);
  });

  it('survives a repository with no commits yet', async () => {
    const f = await tree({ 'repo/package.json': '{ "name": "repo" }\n' });
    await git(f.path('repo'), 'init', '-b', 'main');

    const info = await readGitInfo(f.path('repo'));

    expect(info, 'an unborn HEAD is still a repository').toBeDefined();
    expect(info!.branch, 'the branch exists before any commit does').toBe('main');
    expect(info!.lastCommitMs, '0 is the documented no-commit sentinel').toBe(0);
    expect(info!.hasUncommittedChanges, 'an uncommitted file is uncommitted work').toBe(true);
  });

  it('reports a detached HEAD without throwing', async () => {
    const f = await repoFixture();
    await git(f.path('repo'), 'checkout', '--detach');

    const info = await readGitInfo(f.path('repo'));

    expect(info).toBeDefined();
    expect(info!.branch, 'what `git rev-parse --abbrev-ref HEAD` itself reports').toBe('HEAD');
    expect(info!.lastCommitMs).toBeGreaterThan(0);
  });
});

describe('readGitInfo: not a repository', () => {
  it('yields undefined for a directory with no .git at all', async () => {
    const f = await tree({ 'plain/Cargo.toml': '[package]\nname = "plain"\n' });

    expect(await readGitInfo(f.path('plain'))).toBeUndefined();
  });

  it('yields undefined for a directory that does not exist', async () => {
    const f = await tree({ 'plain/Cargo.toml': '[package]\n' });

    // Fails closed: a vanished directory must not throw a scan down mid-walk.
    expect(await readGitInfo(f.path('plain/nowhere'))).toBeUndefined();
  });

  it('yields undefined for a worktree whose gitdir has gone missing', async () => {
    // Exactly the shape `tests/e2e.test.ts` builds: `.git` is a FILE pointing nowhere.
    const f = await tree({
      'orphan/build': worktree('/nonexistent/main/.git/worktrees/build'),
      'orphan/build/Cargo.toml': '[package]\nname = "orphan"\n',
    });

    expect(await readGitInfo(f.path('orphan/build'))).toBeUndefined();
  });

  it('yields undefined rather than following a .git symlink', async () => {
    const f = await repoFixture();
    const other = await tree({ 'shadow/package.json': '{}\n' });
    // Not `symlink()` from the fixture helper: the target only exists once the *other*
    // fixture has been built, so the link is made afterwards.
    await fsSymlink(f.path('repo/.git'), other.path('shadow/.git'));

    // Invariant 2's spirit: links are not followed. Reporting the *other* repository's
    // branch and commit here would be worse than reporting nothing.
    expect(await readGitInfo(other.path('shadow'))).toBeUndefined();
  });
});

describe('readGitInfo: linked worktrees', () => {
  /** A repo plus a real linked worktree at `repo/build` on branch `feature`. */
  async function withWorktree(): Promise<Fixture> {
    const f = await repoFixture();
    // Named `build` on purpose (invariant 6): the name that a basename-first check eats.
    await git(f.path('repo'), 'worktree', 'add', '-b', 'feature', 'build');
    return f;
  }

  it('detects a linked worktree from its .git FILE and fills in its context', async () => {
    const f = await withWorktree();

    const info = await readGitInfo(f.path('repo/build'));

    expect(info, 'a linked worktree is a repository').toBeDefined();
    expect(info!.isWorktree, '.git is a FILE, not a directory').toBe(true);
    expect(info!.branch).toBe('feature');
    expect(info!.lastCommitMs).toBeGreaterThan(0);

    expect(info!.worktree, 'worktree context is populated').toBeDefined();
    expect(info!.worktree!.mainRepo, 'points at the owning repository').toBe(f.path('repo'));
    expect(info!.worktree!.isMerged, 'branched from main and not yet moved on').toBe(true);
    expect(info!.worktree!.isClean, 'a fresh checkout is clean').toBe(true);
  });

  it('leaves the main checkout unmarked', async () => {
    const f = await withWorktree();

    const info = await readGitInfo(f.path('repo'));

    expect(info!.isWorktree, 'owning a worktree does not make you one').toBe(false);
    expect(info!.worktree).toBeUndefined();
  });

  it('reports a dirty worktree as unclean', async () => {
    const f = await withWorktree();
    await writeFile(f.path('repo/build/scratch.js'), 'export const d = 4;\n');

    const info = await readGitInfo(f.path('repo/build'));

    expect(info!.hasUncommittedChanges).toBe(true);
    expect(info!.worktree!.isClean).toBe(false);
  });

  it('reports an unmerged worktree as unmerged', async () => {
    const f = await withWorktree();
    await writeFile(f.path('repo/build/feature.js'), 'export const e = 5;\n');
    await git(f.path('repo/build'), 'add', '-A');
    await git(f.path('repo/build'), 'commit', '-m', 'feature work', '--no-verify');

    const info = await readGitInfo(f.path('repo/build'));

    expect(info!.worktree!.isMerged, 'a commit ahead of main is not merged').toBe(false);
    expect(info!.worktree!.isClean, 'committed work leaves a clean tree').toBe(true);
  });
});

describe('readGitInfo: invariant 7 — hardened subprocesses', () => {
  /**
   * A repository that attacks whoever runs `git status` in it: `core.fsmonitor` names a
   * script, and git executes it while refreshing the index.
   */
  async function hostileRepo(): Promise<{ f: Fixture; repo: string; sentinel: string }> {
    const f = await tree({
      'repo/package.json': '{ "name": "hostile" }\n',
      'repo/src/index.js': 'export const a = 1;\n',
      'evil/fsmonitor.sh': '',
    });
    const repo = f.path('repo');
    const script = f.path('evil/fsmonitor.sh');
    const sentinel = f.path('evil/SENTINEL');

    await initRepo(repo);
    // The payload lives outside the repository, so writing it cannot be mistaken for an
    // untracked file and the repo stays clean for the behavioural assertions.
    await writeFile(script, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`, 'utf8');
    await chmod(script, 0o755);
    // Written into the repository's OWN config — the exact thing a downloaded repo ships.
    await git(repo, 'config', 'core.fsmonitor', script);

    return { f, repo, sentinel };
  }

  it('the fixture is genuinely dangerous: an unhardened `git status` runs the payload', async () => {
    const { repo, sentinel } = await hostileRepo();

    await git(repo, 'status', '--porcelain');

    expect(
      await exists(sentinel),
      'if this fails the invariant-7 test below proves nothing — check the git version',
    ).toBe(true);
  });

  it('runs the payload NEVER: no sentinel exists after readGitInfo', async () => {
    const { repo, sentinel } = await hostileRepo();
    await rm(sentinel, { force: true });

    const info = await readGitInfo(repo);

    expect(await exists(sentinel), 'core.fsmonitor executed during a read-only survey').toBe(
      false,
    );
    // ...and the hardening did not cost us the metadata it protects.
    expect(info, 'a hostile repository is still read').toBeDefined();
    expect(info!.branch).toBe('main');
    expect(info!.hasUncommittedChanges).toBe(false);
  });

  it('prefixes EVERY invocation with the hardening flags and environment', async () => {
    const f = await repoFixture();
    await git(f.path('repo'), 'worktree', 'add', '-b', 'feature', 'build');

    // Resolve the real git before the shim shadows it.
    const realGit = (await execFileAsync('sh', ['-c', 'command -v git'])).stdout.trim();
    expect(realGit, 'a real git is required').not.toBe('');

    const binDir = f.path('shim/bin');
    const log = f.path('shim/git.log');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, 'git'),
      [
        '#!/bin/sh',
        '{',
        "  printf 'ARGS'",
        '  for arg in "$@"; do printf \'\\t%s\' "$arg"; done',
        "  printf '\\nENV\\t%s\\t%s\\t%s\\n' \"${GIT_CONFIG_NOSYSTEM-}\" \"${GIT_TERMINAL_PROMPT-}\" \"${GIT_ASKPASS-}\"",
        `} >> '${log}'`,
        `exec '${realGit}' "$@"`,
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(path.join(binDir, 'git'), 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
    let info;
    try {
      // A worktree exercises the widest set of call sites: probe, branch, log, status,
      // default-branch resolution and merge-base.
      info = await readGitInfo(f.path('repo/build'));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(info, 'the shim really did exec the real git').toBeDefined();
    expect(info!.isWorktree).toBe(true);

    const lines = (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '');
    const invocations = lines
      .filter((line) => line.startsWith('ARGS'))
      .map((line) => line.split('\t').slice(1));
    const environments = lines
      .filter((line) => line.startsWith('ENV'))
      .map((line) => line.split('\t').slice(1));

    expect(invocations.length, 'the shim was actually used').toBeGreaterThanOrEqual(3);
    expect(environments).toHaveLength(invocations.length);

    for (const args of invocations) {
      // Only the leading `-c key=value` run counts: a config flag after the subcommand is
      // an argument to the subcommand, not configuration.
      const config: string[] = [];
      for (let i = 0; i + 1 < args.length && args[i] === '-c'; i += 2) config.push(args[i + 1]!);

      const where = `git ${args.join(' ')}`;
      expect(config, `${where}: core.fsmonitor disabled`).toContain('core.fsmonitor=');
      expect(config, `${where}: core.hooksPath neutralised`).toContain(
        'core.hooksPath=/dev/null',
      );
      expect(config, `${where}: ext protocol refused`).toContain('protocol.ext.allow=never');
    }

    for (const env of environments) {
      expect(env, 'GIT_CONFIG_NOSYSTEM / GIT_TERMINAL_PROMPT / GIT_ASKPASS').toEqual([
        '1',
        '0',
        'true',
      ]);
    }
  });
});
