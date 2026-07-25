/**
 * Git metadata for a project root — and the tool's only subprocess boundary.
 *
 * **Safety invariant 7 is the entire point of this module.** `readGitInfo` runs `git` with
 * `cwd` set to directories the walk *discovered*, which may be repositories the user merely
 * downloaded rather than authored. A repository's own `.git/config` can set
 * `core.fsmonitor` to an arbitrary command, and `git status` executes it while refreshing
 * the index: arbitrary code execution during what the user believes is a read-only disk
 * survey. `core.hooksPath` is a second vector, and `log.showSignature` + `gpg.program` a
 * third.
 *
 * Every invocation is therefore prefixed
 *
 *     -c core.fsmonitor= -c core.hooksPath=/dev/null -c protocol.ext.allow=never
 *
 * and run with `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`.
 *
 * The defence is structural, not diligent: `runGit` is the **only** function in this module
 * that spawns anything, and it is the only place the prefix appears. There is no way to add
 * a call site that forgets it, because there is no other way to call git. The plan's warning
 * — "miss one call site and the hole is open" — is answered by having exactly one.
 *
 * Residual, and deliberately out of scope: `git status` can still run a repository's
 * `filter.<driver>.clean` when `.gitattributes` names one. Disabling that needs a wildcard
 * config override git does not offer; the spec enumerates the three vectors above and this
 * module closes exactly those.
 *
 * Everything else here fails **closed** in the direction that deletes less: an
 * uninterrogable repository yields `undefined` rather than fabricated metadata, and a
 * `git status` that cannot be read reports uncommitted changes rather than a clean tree,
 * because "dirty" is what protects a project from being selected.
 */

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GitInfo } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Invariant 7, the config half. `core.fsmonitor=` (empty) disables the hook rather than
 * merely overriding its path; `core.hooksPath=/dev/null` makes every hook lookup miss; and
 * `protocol.ext.allow=never` refuses `ext::` URLs, which are a shell command in a trench
 * coat.
 */
const HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.ext.allow=never',
];

/**
 * Invariant 7, the environment half. `GIT_CONFIG_NOSYSTEM` drops `/etc/gitconfig` (and any
 * `$PREFIX/etc/gitconfig` a compromised install wrote); the prompt and askpass settings
 * guarantee a scan can never block on a credential dialogue. `GIT_OPTIONAL_LOCKS=0` is not
 * a security control but a courtesy: a read-only survey has no business rewriting another
 * repository's index.
 */
const HARDENED_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_OPTIONAL_LOCKS: '0',
};

/** A wedged git must not wedge the scan. */
const TIMEOUT_MS = 15_000;

/** `git status` in a very dirty repository can be verbose; 1 MB (the default) is not enough. */
const MAX_BUFFER = 8 * 1024 * 1024;

interface GitResult {
  /** True only on exit status 0. `git` uses non-zero as an answer, not just as a failure. */
  ok: boolean;
  stdout: string;
}

/**
 * The one and only place this codebase spawns a process.
 *
 * Never throws: a missing `git`, a corrupt repository, a timeout and an ordinary non-zero
 * exit all arrive as `ok: false`, because every one of them means the same thing to the
 * caller — this question has no answer — and a scan of hundreds of directories cannot be
 * taken down by one of them.
 */
async function runGit(dir: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', [...HARDENING, ...args], {
      cwd: dir,
      env: { ...process.env, ...HARDENED_ENV },
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

async function runGitLine(dir: string, args: readonly string[]): Promise<string> {
  const result = await runGit(dir, args);
  return result.ok ? result.stdout.trim() : '';
}

type GitMarker = 'file' | 'directory';

/**
 * `lstat` on `.git` — the whole worktree-detection mechanism (spec: "Detection costs one
 * `lstat`"). A main checkout's `.git` is a directory; a linked worktree's is a FILE
 * containing `gitdir: …`.
 *
 * `lstat`, not `stat`: a `.git` **symlink** is neither, and resolves to `undefined` — this
 * module refuses to follow links (invariant 2's spirit) rather than report some other
 * repository's branch and commit as if they belonged here.
 */
async function gitMarker(dir: string): Promise<GitMarker | undefined> {
  try {
    const stats = await lstat(path.join(dir, '.git'));
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The branch name, resolving the two cases plain `rev-parse` gets wrong.
 *
 * On an **unborn HEAD** (a fresh `git init`, no commits) `rev-parse --abbrev-ref HEAD`
 * exits 128; `symbolic-ref` still knows the branch the first commit will land on. On a
 * **detached HEAD** `rev-parse` reports the literal `HEAD`, which is what git itself calls
 * it, so it is reported unchanged.
 */
async function readBranch(dir: string): Promise<string> {
  const abbreviated = await runGitLine(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (abbreviated !== '' && abbreviated !== 'HEAD') return abbreviated;

  const symbolic = await runGitLine(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (symbolic !== '') return symbolic;

  return 'HEAD';
}

/**
 * Epoch milliseconds of the last commit, or `0` when there is none — the sentinel
 * `src/ui/format.ts` renders as "never".
 *
 * `--no-show-signature` is load-bearing, not tidiness: a repository that sets
 * `log.showSignature=true` and `gpg.program=<anything>` in its own config gets that program
 * executed by this command. Same class of vector as `core.fsmonitor`, different command.
 */
async function readLastCommitMs(dir: string): Promise<number> {
  const seconds = await runGitLine(dir, [
    'log',
    '-1',
    '--no-show-signature',
    '--format=%ct',
  ]);
  const parsed = Number.parseInt(seconds, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 0;
}

/**
 * True when the working tree holds modified or untracked files.
 *
 * `--untracked-files=normal` is passed explicitly so a repository's own
 * `status.showUntrackedFiles=no` cannot make a tree full of uncommitted work look pristine.
 * An unreadable status reports `true`: this feeds `activity.ts`, where "has uncommitted
 * changes" means "protect it", so the unknown case must land on the protective side.
 */
async function readDirty(dir: string): Promise<boolean> {
  const result = await runGit(dir, ['status', '--porcelain', '--untracked-files=normal']);
  return result.ok ? result.stdout.trim() !== '' : true;
}

/**
 * The absolute path of the repository that owns a linked worktree.
 *
 * `--git-common-dir` is the shared `.git` of the main checkout — absolute in modern git,
 * relative to `dir` in older ones, hence the `resolve`. A conventional `…/main/.git` names
 * the working copy one level up; a bare repository (`…/main.git`) is its own answer.
 */
function mainRepoFrom(dir: string, commonDir: string): string {
  if (commonDir === '') return '';
  const absolute = path.resolve(dir, commonDir);
  return path.basename(absolute) === '.git' ? path.dirname(absolute) : absolute;
}

/**
 * The branch a worktree would be merged *into*: whatever `origin/HEAD` points at, else the
 * conventional names. Returns `undefined` when none of them resolves, which reads as
 * "not merged" — display context should understate rather than overstate how disposable a
 * branch is.
 */
async function defaultBranch(dir: string): Promise<string | undefined> {
  for (const candidate of ['origin/HEAD', 'main', 'master']) {
    const resolved = await runGitLine(dir, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${candidate}^{commit}`,
    ]);
    if (resolved !== '') return candidate;
  }
  return undefined;
}

/** HEAD is an ancestor of the default branch — `merge-base --is-ancestor` says so by exit code. */
async function isMergedIntoDefault(dir: string): Promise<boolean> {
  const target = await defaultBranch(dir);
  if (target === undefined) return false;
  const result = await runGit(dir, ['merge-base', '--is-ancestor', 'HEAD', target]);
  return result.ok;
}

/**
 * Git metadata for one directory, or `undefined` when it is not a repository root.
 *
 * "Repository root" means the directory itself holds a `.git` entry. A directory merely
 * *inside* someone's repository yields `undefined`: the walk only ever calls this for roots
 * it identified, and reporting an enclosing repository's branch and commit against a
 * subdirectory would attribute activity to a project that has none of its own.
 *
 * `undefined` also covers the repository that exists but cannot be interrogated — a linked
 * worktree whose main repository has been deleted, a corrupt object store, a machine with
 * no `git` at all. `GitInfo` is display and scoring context; absent context is honest,
 * invented context is not. `Project.git` is optional precisely so this can be absent.
 */
export async function readGitInfo(dir: string): Promise<GitInfo | undefined> {
  const marker = await gitMarker(dir);
  if (marker === undefined) return undefined;
  const isWorktree = marker === 'file';

  // Cheap, touches no index, and doubles as the "is this repository usable at all" probe:
  // a worktree pointing at a gitdir that no longer exists fails right here.
  const commonDir = await runGit(dir, ['rev-parse', '--git-common-dir']);
  if (!commonDir.ok) return undefined;

  const branch = await readBranch(dir);
  const lastCommitMs = await readLastCommitMs(dir);
  const hasUncommittedChanges = await readDirty(dir);

  const info: GitInfo = { branch, lastCommitMs, hasUncommittedChanges, isWorktree };

  if (isWorktree) {
    // Display context only. The spec is explicit that no field here may gate a deletion:
    // a worktree's artifacts are cleaned on the same terms as any other project's.
    info.worktree = {
      mainRepo: mainRepoFrom(dir, commonDir.stdout.trim()),
      isMerged: await isMergedIntoDefault(dir),
      isClean: !hasUncommittedChanges,
    };
  }

  return info;
}
