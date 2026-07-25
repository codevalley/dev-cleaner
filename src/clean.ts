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
 * - **Git history is never collateral damage.** The same question is asked three ways: is
 *   the candidate itself a repository (`.git` a directory, the `gh-pages` deploy clone), is
 *   it a linked worktree (`.git` a file), and does it *contain* either within a few levels.
 *   The third check can also come back "I could not finish", and that is reported as a
 *   refusal rather than as a clean bill of health — see `findNestedRepository`.
 *
 * Invariant 4 (trash, not unlink) is `systemTrash`, and it is the *only* part of this
 * module tests replace: the shipped path and the tested path differ in that one function.
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import fsSync, { type Dirent, type Stats } from 'node:fs';
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
  /**
   * How many directories the nested-repository scan may read per candidate. Optional, and
   * **tighten-only**: values at or above the shipped budget (and `NaN`, `Infinity`, a
   * missing field) all mean the shipped budget, so no caller can widen it or make the scan
   * run unbounded. Lowering it can only produce *more* refusals — a candidate the scan
   * could not finish is refused, never permitted — which is what makes it safe to expose
   * and what makes the budget testable end to end through `clean` rather than only against
   * the scanner in isolation.
   */
  nestedScanMaxDirs?: number;
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
 * How deep to look inside a candidate for a nested repository, and how many directories to
 * read before admitting we do not know.
 *
 * ## Depth is policy; the budget is not
 *
 * A worktree or deploy clone is placed deliberately and sits near the top (`build/wip`,
 * `dist/site`, `.venv/src/mylib`); walking an entire build tree to the leaves buys nothing.
 * Depth is therefore a stated limit on what this check *claims*, and the claim stops at
 * four: bundler's own git-gem layout, `vendor/bundle/ruby/<ver>/bundler/gems/<gem>-<sha>`,
 * is one level past it and is not seen. Raising the limit is affordable — the reference
 * `target/` grows from 11,423 directories to 13,861 at depth 6 — but it is a widening of
 * this module's promise and belongs with its own fixtures, not smuggled in here.
 *
 * The directory budget is a different thing: a bound on worst-case *time*. The previous
 * version conflated the two and treated exhaustion as an answer — it returned "no
 * repository found" — which made the guard inert precisely where build trees are biggest.
 * Measured on the reference machine, one Rust `target/` (67 GB) holds 8,187 directories at
 * depth ≤ 3; the old budget of 2,000 was spent before the walk had finished depth 3, so a
 * repository anywhere below that was invisible and the directory was trashed in silence.
 * A guard that fails open on the largest directories on the disk is not a guard.
 *
 * So the budget is 50,000 — about 4× the 11,423 directories that same `target/` presents
 * at depth ≤ 4 (3.3 s cold, 0.8 s warm) — and exhausting it yields `unverified`, which
 * `filesystemRejection` turns into a refusal that says the candidate could not be checked.
 * Ordinary trees are two orders of magnitude under the budget and are unaffected; the one
 * thing that must never happen — losing a repository because a *sibling* directory had
 * many entries — is now impossible rather than merely unlikely.
 *
 * ## Breadth-first, on purpose
 *
 * Now that exhaustion refuses rather than permits, the traversal order can no longer cost
 * anyone their history; it only decides how often the answer is *definite*. Nested
 * repositories are shallow by nature, so breadth-first — every shallower depth finished
 * before a deeper one is touched — turns the common case into "there is a repository at
 * `<path>`" rather than "this was too large to check". The queue is drained with a moving
 * head index instead of `shift()`, which at this budget is the difference between O(n) and
 * O(n²) element moves.
 */
const NESTED_SCAN_MAX_DEPTH = 4;
/** Exported so a test can hold the *size* of the budget to the measurement above; the
 * previous value of 2,000 was the defect, not an implementation detail. */
export const NESTED_SCAN_MAX_DIRS = 50_000;

/**
 * What a scan of a candidate's contents concluded.
 *
 * `unverified` is the load-bearing case and the reason this is a union rather than
 * `string | undefined`: it is *not* `clear`, and no caller may read it as "safe". The old
 * signature had no way to say "I do not know", so it said "nothing here".
 */
export type NestedScan =
  | { kind: 'clear' }
  | { kind: 'repository'; at: string }
  | { kind: 'unverified'; visited: number };

/**
 * Looks for a `.git` (either form) anywhere within `NESTED_SCAN_MAX_DEPTH` of `deletePath`.
 *
 * Pure search, no policy: *which* candidates are scanned is `nestedScanApplies`, so the
 * exemptions live in exactly one place and cannot drift from the reasoning that justifies
 * them.
 */
export async function findNestedRepository(
  deletePath: string,
  maxDirs: number = NESTED_SCAN_MAX_DIRS,
): Promise<NestedScan> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: deletePath, depth: 0 }];
  let head = 0;
  let visited = 0;

  while (head < queue.length) {
    // Checked with work still queued, so a scan that happens to finish on its last
    // permitted directory is `clear` rather than `unverified`.
    if (visited >= maxDirs) return { kind: 'unverified', visited };

    const current = queue[head];
    head += 1;
    if (current === undefined) break;
    visited += 1;

    let entries: Dirent[];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable subtree: nothing to assert about it.
    }

    for (const entry of entries) {
      if (entry.name === '.git') return { kind: 'repository', at: path.join(current.dir, '.git') };
      // Symlinks are never followed (invariant 2) — a link cannot hide a repository we
      // would actually delete, since trashing the candidate removes the link, not its target.
      if (entry.isDirectory() && current.depth + 1 <= NESTED_SCAN_MAX_DEPTH) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return { kind: 'clear' };
}

/**
 * Which candidates get looked inside. Two exemptions, each as narrow as its reasoning:
 *
 * - **`node_modules`, matched by NAME.** Git-installed npm dependencies leave `.git`
 *   directories throughout it, every one reproducible by a reinstall; refusing on those
 *   would make the biggest category on the machine permanently unclearable, and a guard
 *   nobody can satisfy is a guard that gets switched off. This was previously written as
 *   the whole `deps` *category*, which is a far larger set — `.venv`, `venv`,
 *   `vendor/bundle` and `Pods` are all `deps`. `pip install -e git+ssh://…#egg=mylib`, the
 *   documented way to work on a dependency in place, leaves a full clone with unpushed
 *   commits at `.venv/src/mylib/.git`, and the category-wide exemption trashed it without a
 *   word under `--preset aggressive`. The argument was only ever about one directory name,
 *   so the exemption is one directory name.
 * - **Caches, entirely.** A cache is not a project artifact: it is allowlisted by *exact
 *   path* from `caches.ts`, which is a stronger claim than "we looked inside and saw
 *   nothing", and its documented layout may legitimately contain clones. `~/.pub-cache`
 *   keeps every git-sourced Dart package as a full clone at
 *   `~/.pub-cache/git/<pkg>-<sha>/.git`, so scanning caches would block that cache
 *   permanently, for every user, with no action they could take to satisfy it.
 */
function nestedScanApplies(target: CleanTarget): boolean {
  if (target.kind !== 'project') return false;
  return path.basename(deletePathOf(target)) !== NODE_MODULES;
}

/**
 * Tighten-only. Anything not below the shipped budget — including `undefined`, `NaN` and
 * `Infinity`, none of which compare `<` — means the shipped budget, so the option cannot
 * widen the scan or set it running unbounded; negatives clamp to 0, which refuses every
 * scanned candidate and so fails closed.
 */
export function nestedScanBudget(requested: number | undefined): number {
  return requested !== undefined && requested < NESTED_SCAN_MAX_DIRS
    ? Math.max(0, Math.floor(requested))
    : NESTED_SCAN_MAX_DIRS;
}

/**
 * The guards that must look at the disk, in the order that makes each refusal mean what it
 * says: link first (so a symlinked path is reported as a symlink rather than by whatever
 * its target happens to be), then the worktree check, then existence.
 *
 * `nested` is the policy for the contents scan — whether to run it at all, and its budget.
 * Both are decided by the caller (`nestedScanApplies`, `nestedScanBudget`) so that this
 * function only ever *applies* the guards.
 */
async function filesystemRejection(
  deletePath: string,
  nested: { scan: boolean; maxDirs: number },
): Promise<Rejection | undefined> {
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

  // ...and the same question asked of the candidate's *contents*. Checking only the
  // candidate itself leaves `build/wip/.git` — `git worktree add build/wip` — to be
  // destroyed as a side effect of trashing `build`, with no refusal and no mention of it.
  if (nested.scan) {
    const scan = await findNestedRepository(deletePath, nested.maxDirs);
    if (scan.kind === 'repository') {
      return refused(
        'contains-repository',
        `${deletePath} contains a git repository or worktree at ${scan.at}`,
      );
    }
    // Not a repository sighting — the opposite: the scan ran out of budget with the
    // question still open. Reporting that as "clear" is how a 67 GB `target/` gets trashed
    // with a worktree inside it, so an unfinished scan refuses and says so.
    if (scan.kind === 'unverified') {
      return refused(
        'contains-repository',
        `${deletePath} is too large to verify: read ${scan.visited} directories without ` +
          'ruling out a git repository inside it, so it is refused rather than risk ' +
          'trashing history',
      );
    }
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
      lexicalRejection(target, options) ??
      (await filesystemRejection(deletePathOf(target), {
        scan: nestedScanApplies(target),
        maxDirs: nestedScanBudget(options.nestedScanMaxDirs),
      }));
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
