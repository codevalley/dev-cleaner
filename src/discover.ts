/**
 * The walk: scan roots in, project roots out.
 *
 * Three rules, in the order the walk applies them.
 *
 * **Roll-up.** A directory is a project root when it holds `.git` or any type marker. Once
 * one is found, no descendant becomes a second root — the walk still goes *through* it to
 * collect the types its sub-projects declare, but everything found there is attributed to
 * the outer root. That is what turns a Flutter SDK clone with 200 nested `pubspec.yaml`
 * files into one entry, and a twelve-crate monorepo into one project owning twelve
 * `target/` directories. Directories with no marker are containers: not listed, walked
 * through, which is how `v2/` and `2026/` behave.
 *
 * **The worktree exception.** A directory whose `.git` is a *file* is a linked worktree and
 * always begins a new root, even nested inside an existing project. It has its own branch,
 * its own build state and its own history, so scoring it under the parent's recency hides
 * the largest reclaimable item on the reference machine behind a repository that merely
 * happens to be active. Making it an ordinary root means `detect`, `artifacts`, `size`,
 * `activity` and `clean` need no special case for it at all.
 *
 * **Invariant 6, which is an ordering.** `isLinkedWorktree(child)` is tested **before**
 * `isArtifactBasename(name)`, in every loop that has both. Reversed, `git worktree add
 * build feature` produces a checkout at `build/` that the artifact table claims, and the
 * tool deletes real source with uncommitted work. The two calls appear adjacent everywhere
 * they appear, so the order is visible rather than implied.
 *
 * The walk decides *where a project is*. It never decides *what may be deleted*:
 * `resolveArtifacts` is the single code path from a directory to a delete candidate (spec:
 * "exactly one code path"), and this module delegates to it rather than re-implementing the
 * artifact walk. What it contributes is the `declarations` map — every directory in the
 * rolled-up subtree that declared a type — because relative patterns like `app/build` are
 * anchored to the directory that declared them, and only the walk knows which that was.
 *
 * Everything below a readdir failure is skipped rather than thrown: a scan must survive a
 * directory it cannot read. The one deliberate exception is `resolveScanRoot`, whose
 * `SafetyError` propagates all the way out — refusing to scan `/` or `$HOME` is the safety
 * layer working, not a per-project failure to swallow.
 */

import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isArtifactBasename, resolveArtifacts } from './artifacts.js';
import { detectTypesFromNames } from './detect.js';
import { SafetyError } from './types.js';
import type { Category, DiscoveredProject, ProjectType } from './types.js';

/** Object storage, not build output. Never descended, never a candidate. */
const GIT_DIR = '.git';

/**
 * Path segments below the filesystem root. `/` is 0, `/Users` is 1, `/Users/me/dev` is 3.
 * Invariant 3 refuses anything at depth ≤ 1.
 */
function depthBelowFilesystemRoot(target: string): number {
  const { root } = path.parse(target);
  return target
    .slice(root.length)
    .split(path.sep)
    .filter((segment) => segment.length > 0).length;
}

/**
 * `realpath`, or the input when it cannot be resolved.
 *
 * A root that does not exist yet still gets guarded — on its lexical form, which is the
 * conservative direction: a missing path cannot be `$HOME`, and the walk will simply find
 * nothing there. Throwing instead would turn a typo into a crash.
 */
async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

/**
 * macOS and Windows are conventionally case-insensitive, so `/users/me` and `/Users/me` are
 * the same directory. The guards compare case-insensitively there, refusing more rather
 * than fewer roots.
 */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function samePath(left: string, right: string): boolean {
  return CASE_INSENSITIVE ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Resolve a user-supplied scan root, applying invariant 3's guards to its **real** path.
 *
 * `path.resolve` normalises `..` lexically but does not follow links, so
 * `~/develop/projects -> /` presents as a comfortable depth-3 path and passes a lexical
 * guard while naming the entire filesystem. The guards therefore run against `realpath`,
 * and the resolved value is what the scan uses — which also keeps the roots `clean.ts`
 * checks containment against in the same form as the projects the walk attributes to them.
 * On macOS a lexical `/var/...` root would otherwise fail to contain a discovered
 * `/private/var/...` project, and every delete would be refused.
 */
export async function resolveScanRoot(root: string): Promise<string> {
  const resolved = await realpathOrSelf(path.resolve(root));
  const filesystemRoot = path.parse(resolved).root;

  if (samePath(resolved, filesystemRoot)) {
    throw new SafetyError(
      'root-is-filesystem-root',
      `${root} resolves to the filesystem root (${resolved}); refusing to scan it.`,
    );
  }

  const home = await realpathOrSelf(os.homedir());
  if (samePath(resolved, home)) {
    throw new SafetyError(
      'root-is-home',
      `${root} resolves to your home directory (${resolved}); refusing to scan it. ` +
        'Point dev-cleaner at a projects directory inside it instead.',
    );
  }

  if (depthBelowFilesystemRoot(resolved) <= 1) {
    throw new SafetyError(
      'root-too-shallow',
      `${root} resolves to ${resolved}, one level below the filesystem root; ` +
        'refusing to scan it.',
    );
  }

  return resolved;
}

/**
 * `true` when `dir` is a linked git worktree — its `.git` is a **file** holding a `gitdir:`
 * pointer, where a main checkout's is a directory.
 *
 * One `lstat`, no `git` subprocess (spec: "Detection costs one `lstat`"), which is what
 * makes it affordable to ask on every directory the walk meets. Deliberately does not read
 * the file's contents: a `.git` file that is *not* a worktree pointer still makes the
 * directory a root rather than an artifact, and that is the fail-closed answer.
 *
 * Any error — missing path, unreadable parent — is `false`. A directory that cannot be
 * inspected is not thereby a worktree; it is simply walked as usual, and the artifact table
 * still has to claim it before anything can be deleted.
 */
export async function isLinkedWorktree(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, GIT_DIR))).isFile();
  } catch {
    return false;
  }
}

/** Directory entries, or `undefined` when the directory cannot be read. Never throws. */
async function readEntries(dirPath: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/**
 * Subdirectories worth considering: real directories only.
 *
 * `withFileTypes` does not follow links, so a symlinked directory reports as a symlink and
 * is dropped here — invariant 2, applied before any name is looked at. A link named `build`
 * pointing at `$HOME` is neither an artifact nor a path to walk.
 */
function isWalkableChild(entry: Dirent): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== GIT_DIR;
}

/** Everything one project root contributes, gathered in a single pass over its subtree. */
interface Subtree {
  /** Directory → the types **that directory** declares. `resolveArtifacts` anchors on it. */
  declarations: Map<string, Set<ProjectType>>;
  /** Linked worktrees found inside, each of which becomes a root of its own. */
  worktrees: string[];
}

/**
 * Walk a project root's rolled-up subtree, collecting type declarations and worktrees.
 *
 * Types are collected from *every* directory, not just the root: `tinysync` declares `rust`
 * at its root and `xcode` three levels down, and both contribute artifact names to the one
 * entry. Detecting only at the root would miss the artifacts of every nested sub-project,
 * which in a monorepo is most of them.
 *
 * Pruning matches the spec exactly — `.git`, symlinks, and any directory whose basename the
 * artifact table claims. Without it a scan visits several hundred thousand files; with it, a
 * few thousand directories. It also keeps a dependency's own markers out of the project's
 * type set: a package inside `node_modules` shipping a `Cargo.toml` must not make the
 * project rust.
 */
async function collectSubtree(root: string): Promise<Subtree> {
  const declarations = new Map<string, Set<ProjectType>>();
  const worktrees: string[] = [];

  async function visit(dirPath: string): Promise<void> {
    const entries = await readEntries(dirPath);
    if (entries === undefined) return;

    const declared = detectTypesFromNames(entries.map((entry) => entry.name));
    if (declared.size > 0) declarations.set(dirPath, declared);

    for (const entry of entries) {
      if (!isWalkableChild(entry)) continue;
      const childPath = path.join(dirPath, entry.name);

      // ── Invariant 6 ──────────────────────────────────────────────────────────────────
      // Worktree first, artifact name second. A worktree named `build` is a checkout with
      // its own history; it leaves this subtree and becomes a root in its own right.
      if (await isLinkedWorktree(childPath)) {
        worktrees.push(childPath);
        continue;
      }
      if (isArtifactBasename(entry.name)) continue;
      // ─────────────────────────────────────────────────────────────────────────────────

      await visit(childPath);
    }
  }

  await visit(root);
  return { declarations, worktrees };
}

/** `v2/zerolist`, with `/` separators whatever the platform, for display and grouping. */
function projectName(scanRoot: string, root: string): string {
  const relative = path.relative(scanRoot, root);
  if (relative === '' || relative.startsWith('..')) return path.basename(root);
  return relative.split(path.sep).join('/');
}

/**
 * Emit one project root, then every linked worktree nested inside it — each recursively,
 * since a worktree may itself contain one.
 *
 * `seen` makes overlapping roots idempotent: `dev-cleaner ~/develop ~/develop/v2` must not
 * offer the same directory twice, because a duplicated target is a duplicated delete and a
 * double-counted total.
 */
async function* emitProject(
  root: string,
  scanRoot: string,
  categories: Set<Category>,
  isWorktree: boolean,
  seen: Set<string>,
): AsyncGenerator<DiscoveredProject> {
  if (seen.has(root)) return;
  seen.add(root);

  const { declarations, worktrees } = await collectSubtree(root);

  // The project's own type set is the union across its whole rolled-up subtree.
  const types = new Set<ProjectType>();
  for (const declared of declarations.values()) {
    for (const type of declared) types.add(type);
  }

  yield {
    root,
    name: projectName(scanRoot, root),
    types,
    // The one code path from a directory to delete candidates. `bytes` stays 0; sizing is
    // `scan.ts`'s job and happens once, later, for every artifact at a time.
    artifacts: await resolveArtifacts(root, declarations, categories),
    isWorktree,
  };

  for (const worktreeRoot of worktrees) {
    yield* emitProject(worktreeRoot, scanRoot, categories, true, seen);
  }
}

/**
 * Walk a directory that is not (yet) known to be a project root.
 *
 * Either it declares something — `.git` or a type marker — and becomes a root, ending the
 * descent; or it is a container and the walk continues through its children. A `.git`
 * *directory* makes a root; a `.git` *file* is a worktree and was already handled by the
 * caller.
 */
async function* walkDirectory(
  dirPath: string,
  scanRoot: string,
  categories: Set<Category>,
  seen: Set<string>,
): AsyncGenerator<DiscoveredProject> {
  const entries = await readEntries(dirPath);
  if (entries === undefined) return;

  const declaresType = detectTypesFromNames(entries.map((entry) => entry.name)).size > 0;
  const hasGitDirectory = entries.some(
    (entry) => entry.name === GIT_DIR && entry.isDirectory() && !entry.isSymbolicLink(),
  );

  if (declaresType || hasGitDirectory) {
    yield* emitProject(dirPath, scanRoot, categories, false, seen);
    return;
  }

  for (const entry of entries) {
    if (!isWalkableChild(entry)) continue;
    const childPath = path.join(dirPath, entry.name);

    // ── Invariant 6, again ─────────────────────────────────────────────────────────────
    // The same ordering has to hold here, where no project encloses the worktree: a
    // checkout named `build` sitting directly in a container is still a checkout.
    if (await isLinkedWorktree(childPath)) {
      yield* emitProject(childPath, scanRoot, categories, true, seen);
      continue;
    }
    if (isArtifactBasename(entry.name)) continue;
    // ───────────────────────────────────────────────────────────────────────────────────

    yield* walkDirectory(childPath, scanRoot, categories, seen);
  }
}

/**
 * Discover every project under the given roots.
 *
 * Yields as it goes rather than collecting: sizing a 133 GB tree is slow enough to be
 * visible, and the TUI renders each project as it arrives (spec: "Progressive rendering").
 *
 * `categories` is passed straight through to `resolveArtifacts`. It narrows which artifacts
 * are *listed*, never where the walk goes: pruning is table-wide, because a `node_modules`
 * the current preset does not enable is still not worth walking into.
 *
 * A guarded root (invariant 3) throws a `SafetyError` out of the generator, deliberately
 * un-caught.
 */
export async function* discover(
  roots: readonly string[],
  categories: Set<Category>,
): AsyncGenerator<DiscoveredProject> {
  const seen = new Set<string>();

  for (const root of roots) {
    const scanRoot = await resolveScanRoot(root);

    // A scan root may itself be a worktree — `dev-cleaner .` from inside one.
    if (await isLinkedWorktree(scanRoot)) {
      yield* emitProject(scanRoot, scanRoot, categories, true, seen);
      continue;
    }
    yield* walkDirectory(scanRoot, scanRoot, categories, seen);
  }
}
