/**
 * The deletion boundary — the only module in dev-cleaner that removes user data.
 *
 * Everything here exists because the previous modules can be wrong. `discover` and
 * `artifacts` already enforce the allowlist and the worktree rule; this module enforces
 * them **again**, independently, against the paths it is actually about to hand to the
 * trash. A guard that only runs where the candidate was produced protects against nothing
 * once a caller constructs a target by hand — and `cli.ts`, `ui/model.ts` and every future
 * consumer are exactly such callers.
 *
 * ## Why `clean` takes `CleanTarget` and not `{path, bytes}`
 *
 * Every check below is *derived* from the discriminated union: containment comes from
 * `project.root`, the allowlist from the artifact's basename, the cache allowlist from
 * `cache.path`. A flattened `{path, bytes}` would be sufficient to delete with, and that
 * is precisely the danger — it would make the whole guard layer unreachable from the only
 * code path a user can invoke, while unit tests that call the guards directly stayed
 * green. The union is what keeps the guards on the live path.
 *
 * Only `artifact.path`, `project.root` and `cache.path` are trusted as *inputs to be
 * checked*; `relPath`, `bytes`, `name` and `label` are display data and never gate a
 * decision.
 *
 * ## The invariants enforced here
 *
 * - **Invariant 1 (allowlist, never blocklist).** A project artifact is deletable only if
 *   `isArtifactBasename` claims its basename *and* it lies strictly inside the project
 *   root *and* that root lies inside one of the scan roots. A cache is deletable only if
 *   its path is one the scan actually produced (`allowedCachePaths`). Anything else is
 *   refused, so a bug fails closed — something goes uncleaned rather than something extra
 *   being deleted.
 * - **Invariant 2 (no symlink traversal, over the whole path).** Every ancestor is
 *   `lstat`ed and the parent's `realpath` is compared with its lexical form, then the
 *   terminal component is `lstat`ed. A terminal-only check passes `~/Library/pnpm/store`
 *   when `~/Library/pnpm` is a link to `/`, and the delete escapes the intended tree.
 * - **Invariant 3 (root guards on real paths).** `/`, the home directory and anything at
 *   depth ≤ 1 are refused — as a delete target and as a project root — even when the
 *   caller's own root list says they are in scope.
 * - **Invariant 5 (ordering as a dependency).** `orderTargets` puts every project
 *   `node_modules` first and every store prune last; `clean` then *also* refuses the store
 *   prune outright when any `node_modules` did not end up trashed. Sorting alone is not
 *   enough: a sorted loop happily prunes the store straight after a failed `node_modules`,
 *   orphaning the hardlinks of a project that is still on disk.
 * - **Invariant 6 (worktrees are never deleted).** Any candidate whose `.git` is a *file*
 *   is refused. This is the second, deliberately independent enforcement of the rule the
 *   walk already applies — `git worktree add build feature` produces a checkout with a
 *   name the artifact table claims, and one ordering slip anywhere upstream is enough to
 *   offer real source with uncommitted work for deletion.
 *
 * Invariant 4 (trash, not unlink) is `systemTrash`, and it is the *only* part of this
 * module tests replace: the shipped path and the tested path differ in that one function.
 */

import { lstat, realpath } from 'node:fs/promises';
import fsSync, { type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isArtifactBasename } from './artifacts.js';
import type { CleanOutcome, CleanTarget, Refusal, TrashFn } from './types.js';

export interface CleanOptions {
  trash: TrashFn;
  /** The scan roots, already `realpath`-resolved by `resolveScanRoot`. */
  roots: readonly string[];
  /** Cache paths the scan actually produced. Any other cache target is refused. */
  allowedCachePaths: readonly string[];
  /**
   * Every `node_modules` the scan found that is **not** in `targets` — i.e. that will
   * still be on disk, still hardlinking into the package store, when this run finishes.
   * Invariant 5.
   *
   * Tracking only the *failures* of selected `node_modules` is not enough, and the gap is
   * not exotic: under the default `recommended` preset the `deps` category is excluded, so
   * no `node_modules` is ever a target at all, while the pnpm store — a global cache — is
   * selected. Every hardlink source is therefore left behind, none of them fails, and a
   * failure-only check sees a clean run and prunes the store. That orphans the hardlinks
   * of every pnpm project on the machine, which is precisely the harm invariant 5 exists
   * to prevent, in the one configuration nearly every user will run.
   *
   * Callers that cannot enumerate them must pass the empty array *knowingly*; it is typed
   * as required so that omitting it is a compile error rather than a silent unsafe prune.
   */
  unselectedNodeModules: readonly string[];
}

/**
 * The production `TrashFn`: the platform's native recycle facility, via the `trash`
 * package (invariant 4). On the same volume this is a rename, so it costs the same whether
 * the directory holds ten files or a hundred thousand — and it leaves the user an undo.
 *
 * Two details are load-bearing:
 *
 * - **`glob: false`.** `trash` globs its input by default, so a directory legitimately
 *   named `[legacy]` or `!important` would be reinterpreted as a pattern and match
 *   something else entirely. Every path we pass is already an exact, validated absolute
 *   path; pattern expansion could only ever widen it.
 * - **The import is dynamic.** `dev-cleaner --help` should not load a deletion library,
 *   and the test suites never load it at all.
 */
export const systemTrash: TrashFn = async (paths) => {
  if (paths.length === 0) return;
  const { default: trash } = await import('trash');
  await trash([...paths], { glob: false });
};

/** The single artifact name that hardlinks into a package store. See invariant 5. */
const NODE_MODULES = 'node_modules';

/**
 * Caches that are hardlink farms for project `node_modules`. Matched by id *or* by shape,
 * so renaming an id in `caches.ts` cannot silently switch the dependency off — the
 * fail-closed direction for a guard whose failure mode is silent.
 */
const STORE_PRUNE_IDS: ReadonlySet<string> = new Set(['pnpm-store']);
const STORE_PRUNE_PATH = /[\\/]pnpm[\\/]store[\\/]?$/i;

/** Paths compare case-insensitively where the filesystem does — the fail-closed direction
 * for the *guards* (more refusals), never for containment (which would admit more). */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function normalize(target: string): string {
  const resolved = path.resolve(target);
  const { root } = path.parse(resolved);
  // Strip a trailing separator, except on the filesystem root where it is part of the name.
  return resolved.length > root.length && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
}

function sameGuardedPath(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return CASE_INSENSITIVE ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Number of components below the filesystem root: `/` → 0, `/Users` → 1. */
function pathDepth(target: string): number {
  const resolved = normalize(target);
  const { root } = path.parse(resolved);
  return resolved
    .slice(root.length)
    .split(path.sep)
    .filter((segment) => segment.length > 0).length;
}

/**
 * Every spelling of the home directory that a delete target could present as.
 *
 * `os.homedir()` returns the *lexical* path, but every path this module checks has been
 * through `realpath`. On the standard NFS/automount layout — `/home/me` a symlink to
 * `/export/home/me` — those differ, so a lexical-only comparison lets `$HOME` itself
 * through the guard. Home directories commonly hold a dotfiles repo and a `package.json`,
 * which is exactly enough to be discovered as a project.
 */
function homeDirectories(): string[] {
  try {
    const home = os.homedir();
    if (typeof home !== 'string' || home.trim().length === 0) return [];
    const lexical = normalize(home);
    const homes = new Set([lexical]);
    try {
      homes.add(normalize(fsSync.realpathSync(home)));
    } catch {
      // Home may not resolve (unmounted automount); the lexical form still guards.
    }
    return [...homes];
  } catch {
    return [];
  }
}

/**
 * Invariant 3, applied at the deletion boundary rather than only at the scan root. Returns
 * the reason the path is untouchable, or `undefined` when it is ordinary.
 */
function guardedReason(target: string): string | undefined {
  const resolved = normalize(target);
  const { root } = path.parse(resolved);

  if (resolved === normalize(root)) return 'it is the filesystem root';

  if (homeDirectories().some((home) => sameGuardedPath(resolved, home))) {
    return 'it is the home directory';
  }

  const depth = pathDepth(resolved);
  if (depth <= 1) return `it is only ${depth} level(s) below the filesystem root`;

  return undefined;
}

/** True when `descendant` is `ancestor` or lies inside it. Case-sensitive on purpose. */
function contains(ancestor: string, descendant: string): boolean {
  const a = normalize(ancestor);
  const d = normalize(descendant);
  return d === a || d.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

function containsStrictly(ancestor: string, descendant: string): boolean {
  return contains(ancestor, descendant) && normalize(ancestor) !== normalize(descendant);
}

/** Every ancestor of `target`, shallowest first, excluding `target` itself. */
function ancestorsOf(target: string): string[] {
  const chain: string[] = [];
  let current = path.dirname(normalize(target));
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

async function safeLstat(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch {
    return undefined;
  }
}

async function safeRealpath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

/**
 * How a target can be rejected. `failed` is not a safety judgement — it is "we tried, or
 * could not try": a missing directory, something that is not a directory at all, or a
 * `TrashFn` that threw. `refused` is the guard layer speaking, and always carries a code.
 */
type Rejection =
  | { outcome: 'refused'; refusal: Refusal; detail: string }
  | { outcome: 'failed'; detail: string };

function refused(refusal: Refusal, detail: string): Rejection {
  return { outcome: 'refused', refusal, detail };
}

/** The path a target would remove. Everything else on the target is display data. */
function deletePathOf(target: CleanTarget): string {
  return normalize(target.kind === 'project' ? target.artifact.path : target.cache.path);
}

function targetBytes(target: CleanTarget): number {
  return target.kind === 'project' ? target.artifact.bytes : target.cache.bytes;
}

/** Relative paths read with `/` separators wherever they are displayed. */
const toPosix = (value: string): string =>
  path.sep === '/' ? value : value.split(path.sep).join('/');

/**
 * What the user sees in the confirmation screen and the summary: `v2/zerolist/dist` or
 * `pnpm store`. Derived from display fields with a fallback to the real path, so a project
 * the scan could not name still labels its artifacts recognisably.
 */
export function targetLabel(target: CleanTarget): string {
  if (target.kind === 'cache') {
    const { cache } = target;
    return cache.label.length > 0 ? cache.label : cache.path;
  }
  const { project, artifact } = target;
  const name = project.name.length > 0 ? project.name : path.basename(project.root);
  const relative = artifact.relPath.length > 0 ? artifact.relPath : path.basename(artifact.path);
  return `${toPosix(name)}/${toPosix(relative)}`;
}

/**
 * Invariant 5, first half. Three ranks:
 *
 * 0. project `node_modules` — the hardlink *sources*;
 * 1. everything else;
 * 2. store prunes — the hardlink *targets*.
 *
 * Sorting is stable within a rank, so the caller's order (largest first, as the list shows
 * it) survives. This is only the ordering; `clean` supplies the dependency that ordering
 * alone cannot express.
 */
export function orderTargets(targets: readonly CleanTarget[]): CleanTarget[] {
  return targets
    .map((target, index) => ({ target, index, rank: rankOf(target) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.target);
}

function isNodeModulesTarget(target: CleanTarget): boolean {
  return target.kind === 'project' && path.basename(target.artifact.path) === NODE_MODULES;
}

function isStorePruneTarget(target: CleanTarget): boolean {
  if (target.kind !== 'cache') return false;
  return STORE_PRUNE_IDS.has(target.cache.id) || STORE_PRUNE_PATH.test(target.cache.path);
}

function rankOf(target: CleanTarget): number {
  if (isNodeModulesTarget(target)) return 0;
  return isStorePruneTarget(target) ? 2 : 1;
}

/**
 * The guards that need no filesystem at all. They run first so that a target which must
 * never be touched is refused without so much as an `lstat` on it — and so that a refusal
 * does not depend on whether the dangerous path happens to exist on this machine.
 */
function lexicalRejection(target: CleanTarget, options: CleanOptions): Rejection | undefined {
  const deletePath = deletePathOf(target);

  if (target.kind === 'project') {
    const root = normalize(target.project.root);

    // Invariant 3 first: a project rooted at $HOME is refused even when the caller's own
    // root list contains $HOME, which is exactly the case where every other check passes.
    const rootGuard = guardedReason(root);
    if (rootGuard !== undefined) {
      return refused('guarded-path', `project root ${root} is protected: ${rootGuard}`);
    }
    const targetGuard = guardedReason(deletePath);
    if (targetGuard !== undefined) {
      return refused('guarded-path', `${deletePath} is protected: ${targetGuard}`);
    }

    // Invariant 1: containment. Strict, so a target claiming to be the project root itself
    // is refused rather than removing the repository.
    if (!containsStrictly(root, deletePath)) {
      return refused('outside-project-root', `${deletePath} is not inside ${root}`);
    }
    if (!options.roots.some((scanRoot) => contains(scanRoot, root))) {
      return refused('outside-project-root', `project root ${root} is outside every scan root`);
    }

    // Invariant 1: the allowlist itself. Checked against the *actual* basename, never
    // against `relPath`, which a caller can write anything into.
    if (!isArtifactBasename(path.basename(deletePath))) {
      return refused(
        'not-in-artifact-table',
        `${path.basename(deletePath)} is not a name the artifact table claims`,
      );
    }
    return undefined;
  }

  // Caches have no project root to be contained by, so the allowlist is the containment:
  // the path must be one this very scan produced.
  const allowed = options.allowedCachePaths.some((candidate) =>
    sameGuardedPath(candidate, deletePath),
  );
  if (!allowed) {
    return refused('unknown-cache', `${deletePath} is not a cache this scan found`);
  }

  const guard = guardedReason(deletePath);
  if (guard !== undefined) {
    return refused('guarded-path', `${deletePath} is protected: ${guard}`);
  }
  // A "cache" that contains a scan root is not a cache. Nothing in `caches.ts` can produce
  // one; refusing it costs a comparison and removes the worst possible outcome.
  const swallowed = options.roots.find((scanRoot) => contains(deletePath, scanRoot));
  if (swallowed !== undefined) {
    return refused('guarded-path', `${deletePath} contains the scan root ${normalize(swallowed)}`);
  }
  return undefined;
}

/**
 * The guards that must look at the disk, in the order that makes each refusal mean what it
 * says: link first (so a symlinked path is reported as a symlink rather than by whatever
 * its target happens to be), then the worktree check, then existence.
 */
async function filesystemRejection(deletePath: string): Promise<Rejection | undefined> {
  // Invariant 2, over the whole ancestor chain. A terminal `lstat` alone passes
  // `~/Library/pnpm/store` when `~/Library/pnpm` is a link elsewhere.
  for (const ancestor of ancestorsOf(deletePath)) {
    const stats = await safeLstat(ancestor);
    if (stats === undefined) break; // Nonexistent ancestor: existence is checked below.
    if (stats.isSymbolicLink()) {
      return refused('symlink', `${ancestor} is a symbolic link on the path to ${deletePath}`);
    }
  }

  // The same question asked a second way: `realpath` resolves the entire chain in one go,
  // and any disagreement with the lexical path means we would not delete what we named.
  const parent = path.dirname(deletePath);
  const realParent = await safeRealpath(parent);
  if (realParent !== undefined && normalize(realParent) !== normalize(parent)) {
    return refused('symlink', `${parent} really resolves to ${realParent}`);
  }

  const stats = await safeLstat(deletePath);
  if (stats?.isSymbolicLink() === true) {
    return refused('symlink', `${deletePath} is a symbolic link`);
  }

  // Invariant 6, the second enforcement. `.git` as a FILE means a linked worktree: real
  // source, possibly uncommitted, and a name the artifact table may well claim.
  const dotGit = await safeLstat(path.join(deletePath, '.git'));
  if (dotGit?.isFile() === true) {
    return refused('worktree-root', `${deletePath} is a linked git worktree (its .git is a file)`);
  }
  // `.git` as a DIRECTORY means a real repository sitting where an artifact was expected.
  // The everyday case is a `gh-pages` deploy directory — `git clone -b gh-pages <repo> dist`
  // leaves `dist/` a full repository — whose unpushed commits exist nowhere else. Checking
  // only for the *file* form catches worktrees and walks straight past this.
  if (dotGit?.isDirectory() === true) {
    return refused(
      'contains-repository',
      `${deletePath} is a git repository (its .git is a directory); refusing to trash history`,
    );
  }

  if (stats === undefined) {
    return { outcome: 'failed', detail: `${deletePath} no longer exists` };
  }
  if (!stats.isDirectory()) {
    return { outcome: 'failed', detail: `${deletePath} is not a directory` };
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Trash the selected targets, in dependency order, refusing anything the guards do not
 * recognise. Returns one outcome per target, in execution order — the order the summary
 * then reports, so what the user reads is what actually happened.
 *
 * Targets are processed **sequentially**. Concurrency would buy little (trashing is a
 * rename) and would break invariant 5 outright: the store prune has to observe the final
 * state of every `node_modules`, which it cannot do while they are still in flight.
 */
export async function clean(
  targets: readonly CleanTarget[],
  options: CleanOptions,
): Promise<CleanOutcome[]> {
  const ordered = orderTargets(targets);
  const outcomes: CleanOutcome[] = [];

  /**
   * Set by the first `node_modules` that will still be on disk when this run ends.
   * Invariant 5. Seeded from targets the caller never selected — see `unselectedNodeModules`
   * — because those never reach the loop below and so could never set it themselves.
   */
  let hardlinkSourceLeftBehind: string | undefined =
    options.unselectedNodeModules.length > 0
      ? `${options.unselectedNodeModules[0]} is not being cleaned` +
        (options.unselectedNodeModules.length > 1
          ? ` (and ${options.unselectedNodeModules.length - 1} more)`
          : '')
      : undefined;

  for (const target of ordered) {
    const label = targetLabel(target);
    const bytes = targetBytes(target);

    const record = (outcome: CleanOutcome): CleanOutcome => {
      outcomes.push(outcome);
      // A `node_modules` that was not trashed is still hardlinking into the store, so
      // every later store prune is unsafe. `orderTargets` guarantees this is known before
      // any store prune is reached — which is why `clean` orders internally rather than
      // trusting the caller to have done it.
      if (
        isNodeModulesTarget(target) &&
        outcome.outcome !== 'trashed' &&
        hardlinkSourceLeftBehind === undefined
      ) {
        hardlinkSourceLeftBehind = `${label} was not trashed (${outcome.refusal ?? outcome.outcome})`;
      }
      return outcome;
    };

    if (isStorePruneTarget(target) && hardlinkSourceLeftBehind !== undefined) {
      record({
        target,
        label,
        bytes,
        outcome: 'refused',
        refusal: 'store-prune-unsafe',
        detail:
          `${hardlinkSourceLeftBehind}, so pruning the store would orphan the hardlinks ` +
          'of a project that is still on disk',
      });
      continue;
    }

    const rejection =
      lexicalRejection(target, options) ?? (await filesystemRejection(deletePathOf(target)));
    if (rejection !== undefined) {
      record(
        rejection.outcome === 'refused'
          ? {
              target,
              label,
              bytes,
              outcome: 'refused',
              refusal: rejection.refusal,
              detail: rejection.detail,
            }
          : { target, label, bytes, outcome: 'failed', detail: rejection.detail },
      );
      continue;
    }

    try {
      await options.trash([deletePathOf(target)]);
      record({ target, label, bytes, outcome: 'trashed' });
    } catch (error) {
      record({ target, label, bytes, outcome: 'failed', detail: messageOf(error) });
    }
  }

  return outcomes;
}
