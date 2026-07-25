/**
 * Pinning tests for three guards in `src/git.ts` that could be deleted without any existing
 * test noticing. Each one is load-bearing, and each is asserted *behaviourally* — by the
 * damage it prevents, not by the flag that prevents it — so the pin survives a refactor that
 * achieves the same protection some other way.
 *
 * 1. **`--no-show-signature` in `readLastCommitMs`** (invariant 7). `tests/git.test.ts`
 *    already covers `core.fsmonitor`, but that vector is closed by the `-c` prefix in
 *    `runGit`, which every call site inherits. `log.showSignature` + `gpg.program` is a
 *    *different* class: the prefix does not close it, only the per-command flag does. A
 *    repository the user merely downloaded, whose HEAD carries a `gpgsig` header and whose
 *    own `.git/config` sets `log.showSignature=true` and `gpg.program=<script>`, gets that
 *    script executed by `git log`. Arbitrary code execution during a read-only disk survey.
 *
 * 2. **`readDirty`'s fail-closed default**, `result.ok ? … : true`. `activity.ts` reads
 *    "has uncommitted changes" as "protect this project", so a `git status` that cannot be
 *    read must land on the protective side. Flip the fallback to `false` and a repository we
 *    are unable to interrogate silently becomes eligible for cleaning — the single worst
 *    failure this module can produce, and it is invisible: nothing errors, the scan just
 *    quietly offers up someone's uncommitted work.
 *
 * 3. **`--untracked-files=normal` in `readDirty`.** Same consequence, reached from the other
 *    direction: a repository's own `status.showUntrackedFiles=no` makes a tree full of
 *    untracked work report as pristine, and the explicit flag overrules it.
 *
 * Each hostile fixture is first proved *genuinely* hostile against unhardened git, exactly
 * as `tests/git.test.ts` does for `core.fsmonitor`. Without that step a future git release
 * that ignored the setting would turn these into tests that pass while proving nothing.
 */

import { execFile, execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { readGitInfo } from '../src/git.js';
import { fixture, type Fixture } from './fixture.js';

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

/** Deterministic identity, and never the module's own hardened runner. */
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/**
 * Real, *unhardened* `git`. Fixtures built with the code under test would be blind to the
 * bug they exist to catch, and the "genuinely dangerous" probes below need a git that has
 * none of the module's defences.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
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

/** Absolute path of the real `git`, resolved before any shim can shadow it. */
async function realGitPath(): Promise<string> {
  const resolved = (await execFileAsync('sh', ['-c', 'command -v git'])).stdout.trim();
  expect(resolved, 'a real git is required to run these tests').not.toBe('');
  return resolved;
}

/** A `#!/bin/sh` script, executable. */
async function shScript(target: string, lines: readonly string[]): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, ['#!/bin/sh', ...lines, ''].join('\n'), 'utf8');
  await chmod(target, 0o755);
}

// ---------------------------------------------------------------------------------------
// 1. log.showSignature + gpg.program
// ---------------------------------------------------------------------------------------

describe('invariant 7: a signed HEAD must not run the repository’s gpg.program', () => {
  /**
   * Rewrites HEAD as a commit carrying a `gpgsig` header.
   *
   * Real GPG keys are not available (and generating one in a test would be slow and
   * machine-dependent), but git does not need the signature to be *valid* to hand it to
   * `gpg.program` — it only needs the header to be present. So the commit object is read
   * back with `cat-file`, a plausible-looking armoured block is spliced in as a header
   * (continuation lines are prefixed with a space, per git's object format), and the result
   * is hashed straight back into the object store. The tree is untouched, so the working
   * copy stays clean.
   */
  function forgeSignedHead(repo: string): void {
    const env = { ...process.env, ...GIT_ENV };
    const raw = execFileSync('git', ['cat-file', 'commit', 'HEAD'], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    const split = raw.indexOf('\n\n');
    expect(split, 'a commit object separates headers from its message').toBeGreaterThan(0);

    const armour = [
      '-----BEGIN PGP SIGNATURE-----',
      '',
      'iQEzBAABCgAdFiEEnotarealkeynotarealkeynotarealkeyFAmAAAAAACgkQ',
      'bm90YXJlYWxzaWduYXR1cmVub3RhcmVhbHNpZ25hdHVyZW5vdGFyZWFsc2ln=',
      '=Zm9v',
      '-----END PGP SIGNATURE-----',
    ];
    const forged = [
      raw.slice(0, split),
      `\ngpgsig ${armour.join('\n ')}\n`,
      raw.slice(split + 1),
    ].join('');

    const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo,
      env,
      input: forged,
      encoding: 'utf8',
    }).trim();
    expect(sha, 'the forged commit was written to the object store').toMatch(/^[0-9a-f]{40,}$/);

    execFileSync('git', ['update-ref', 'refs/heads/main', sha], { cwd: repo, env });
  }

  /**
   * A repository that attacks whoever runs `git log` in it. Everything hostile lives in the
   * repository's OWN config — precisely what a downloaded repository ships.
   */
  async function signedHostileRepo(): Promise<{
    repo: string;
    sentinel: string;
    committedAt: number;
  }> {
    const f = await tree({
      'repo/package.json': '{ "name": "signed-hostile" }\n',
      'repo/src/index.js': 'export const a = 1;\n',
    });
    const repo = f.path('repo');
    // The payload and its sentinel live OUTSIDE the repository, so firing it cannot be
    // mistaken for an untracked file and the tree stays clean for the metadata assertions.
    const sentinel = f.path('evil/GPG_RAN');

    await initRepo(repo);
    forgeSignedHead(repo);

    await shScript(f.path('evil/gpg.sh'), [`touch '${sentinel}'`, 'exit 1']);
    await git(repo, 'config', 'log.showSignature', 'true');
    await git(repo, 'config', 'gpg.program', f.path('evil/gpg.sh'));

    const committedAt =
      Number.parseInt(
        (await git(repo, 'log', '-1', '--no-show-signature', '--format=%ct')).trim(),
        10,
      ) * 1000;
    await rm(sentinel, { force: true });

    return { repo, sentinel, committedAt };
  }

  it('the fixture is genuinely dangerous: an unhardened `git log` executes gpg.program', async () => {
    const { repo, sentinel } = await signedHostileRepo();

    // Note: no `--show-signature` on the command line. `log.showSignature=true` in the
    // repository's own config is enough, and `--format=%ct` does not suppress it.
    await git(repo, 'log', '-1', '--format=%ct');

    expect(
      await exists(sentinel),
      'if this fails the pinning test below proves nothing — check the git version',
    ).toBe(true);
  });

  it('the -c hardening prefix alone does NOT close this vector', async () => {
    const { repo, sentinel } = await signedHostileRepo();

    // The exact prefix `runGit` applies to every invocation, minus the per-command flag.
    // This is why `--no-show-signature` cannot be dismissed as tidiness: core.fsmonitor,
    // core.hooksPath and protocol.ext.allow leave gpg.program wide open.
    await git(
      repo,
      '-c',
      'core.fsmonitor=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.ext.allow=never',
      'log',
      '-1',
      '--format=%ct',
    );

    expect(await exists(sentinel), 'config hardening is not a substitute for the flag').toBe(
      true,
    );
  });

  it('readGitInfo executes gpg.program NEVER', async () => {
    const { repo, sentinel, committedAt } = await signedHostileRepo();

    const info = await readGitInfo(repo);

    expect(
      await exists(sentinel),
      'gpg.program from a downloaded repository ran during a read-only survey',
    ).toBe(false);

    // ...and suppressing the signature did not cost the metadata it protects.
    expect(info, 'a hostile repository is still read').toBeDefined();
    expect(info!.branch).toBe('main');
    expect(info!.lastCommitMs, 'the signed commit is still dated').toBe(committedAt);
    expect(info!.hasUncommittedChanges, 'forging a header does not dirty the tree').toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 2. readDirty's fail-closed default
// ---------------------------------------------------------------------------------------

describe('readDirty fails closed: an unreadable `git status` reports DIRTY', () => {
  /**
   * Installs a `git` first on `PATH` that fails **only** `git status`, exec-ing the real git
   * for everything else. That is the shape of every way status can go wrong in the field —
   * a permission-denied index, a lock held by another process, the 15 s timeout — reduced to
   * the one thing `readDirty` actually observes: `result.ok === false`.
   *
   * Returns the log the shim appends to, so the test can prove status was really attempted
   * rather than quietly skipped.
   */
  async function withFailingStatus<T>(
    f: Fixture,
    body: () => Promise<T>,
  ): Promise<{ result: T; attempts: string }> {
    const real = await realGitPath();
    const binDir = f.path('shim/bin');
    const log = f.path('shim/status-attempts.log');

    await shScript(path.join(binDir, 'git'), [
      'for arg in "$@"; do',
      '  if [ "$arg" = "status" ]; then',
      `    printf 'status\\n' >> '${log}'`,
      "    printf 'fatal: simulated unreadable index\\n' >&2",
      '    exit 128',
      '  fi',
      'done',
      `exec '${real}' "$@"`,
    ]);
    await writeFile(log, '', 'utf8');

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      const result = await body();
      return { result, attempts: await readFile(log, 'utf8') };
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }

  it('reports uncommitted changes for a repository whose status cannot be read', async () => {
    const f = await tree({
      'repo/package.json': '{ "name": "unreadable" }\n',
      'repo/src/index.js': 'export const a = 1;\n',
    });
    const repo = f.path('repo');
    await initRepo(repo);

    // Baseline: this tree is genuinely, provably CLEAN. Without it the assertion below
    // could be satisfied by real dirt and would pin nothing.
    const clean = await readGitInfo(repo);
    expect(clean, 'the baseline repository is readable').toBeDefined();
    expect(clean!.hasUncommittedChanges, 'a freshly committed tree is clean').toBe(false);

    const { result: info, attempts } = await withFailingStatus(f, () => readGitInfo(repo));

    expect(attempts, 'the shim really did intercept `git status`').toContain('status');
    expect(info, 'a repository whose status fails is still described').toBeDefined();
    expect(info!.branch, 'the other call sites still worked').toBe('main');
    expect(
      info!.hasUncommittedChanges,
      'unknown must mean "protect it": activity.ts treats clean+idle as cleanable',
    ).toBe(true);
  });

  it('marks a worktree whose status cannot be read as unclean', async () => {
    const f = await tree({
      'repo/package.json': '{ "name": "unreadable-worktree" }\n',
      'repo/src/index.js': 'export const a = 1;\n',
    });
    const repo = f.path('repo');
    await initRepo(repo);
    await git(repo, 'worktree', 'add', '-b', 'feature', 'build');

    const baseline = await readGitInfo(f.path('repo/build'));
    expect(baseline!.worktree!.isClean, 'a fresh checkout is genuinely clean').toBe(true);

    const { result: info } = await withFailingStatus(f, () =>
      readGitInfo(f.path('repo/build')),
    );

    expect(info, 'a worktree whose status fails is still described').toBeDefined();
    expect(info!.isWorktree).toBe(true);
    expect(info!.hasUncommittedChanges).toBe(true);
    expect(
      info!.worktree!.isClean,
      'worktree.isClean is derived from the same fail-closed answer',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 3. --untracked-files=normal
// ---------------------------------------------------------------------------------------

describe('readDirty overrules the repository’s own status.showUntrackedFiles', () => {
  /** A repo holding real untracked work, configured to hide it. */
  async function repoHidingUntracked(): Promise<string> {
    const f = await tree({
      'repo/package.json': '{ "name": "hiding" }\n',
      'repo/src/index.js': 'export const a = 1;\n',
    });
    const repo = f.path('repo');
    await initRepo(repo);
    await git(repo, 'config', 'status.showUntrackedFiles', 'no');
    await writeFile(f.path('repo/src/unsaved-work.js'), 'export const precious = 1;\n', 'utf8');
    return repo;
  }

  it('the fixture is genuinely dangerous: a plain `git status --porcelain` reports nothing', async () => {
    const repo = await repoHidingUntracked();

    const porcelain = await git(repo, 'status', '--porcelain');

    expect(
      porcelain.trim(),
      'if this fails the pinning test below proves nothing — check the git version',
    ).toBe('');
  });

  it('still reports uncommitted changes', async () => {
    const repo = await repoHidingUntracked();

    const info = await readGitInfo(repo);

    expect(info).toBeDefined();
    expect(
      info!.hasUncommittedChanges,
      'a repository must not be able to hide the work that protects it',
    ).toBe(true);
  });
});
