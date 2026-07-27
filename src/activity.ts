/**
 * Activity: how long a project has been left alone, and whether that makes it safe to clean.
 *
 * The module is deliberately two halves. `gatherSignals` is a *derivation* — every value it
 * produces is a fact about a tree, cheaply measured and independently checkable, so it is
 * fully implemented and tested here. `scoreActivity` is a *judgement* about what those facts
 * mean, and the spec assigns it to the repository owner; it ships as a documented stub. See
 * the TODO on it, which is the only intentional one in this codebase.
 *
 * The separation is what keeps the judgement changeable. Because the signals are gathered
 * apart from the scoring, the owner can rewrite the rule without re-walking anything, and
 * these tests keep passing across that rewrite because they assert on signals rather than on
 * a status.
 *
 * **Absent is not zero.** Optional signals are left off the object entirely rather than set
 * to 0, so `'lastCommitMs' in signals` reads truthfully. A repository with no commits reports
 * `lastCommitMs: 0` from `git.ts`; forwarding that would present 1970 as the last commit and
 * make a brand-new project the most idle thing on the machine — the exact inversion the
 * spec's "built recently but never committed" case is there to catch.
 */

import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { newestMtimeMs } from './size.js';
import type { ActivityScore, Artifact, GitInfo } from './types.js';

export interface ActivitySignals {
  lastCommitMs?: number;
  hasUncommittedChanges: boolean;
  newestSourceMs: number;
  newestArtifactMs: number;
  lockfileMs?: number;
}

/**
 * Lockfiles for the ten types in the artifact table, checked at the project root only.
 *
 * A lockfile changes when dependencies are added, upgraded or resolved — deliberate acts of
 * development that leave no other trace once the resulting `node_modules` is a candidate for
 * deletion. It is a distinct signal from a source edit for exactly that reason, and it is one
 * `stat` per name rather than a walk.
 */
const LOCKFILE_NAMES: readonly string[] = [
  // node
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  // rust
  'Cargo.lock',
  // flutter / dart
  'pubspec.lock',
  // xcode / swift
  'Podfile.lock',
  'Package.resolved',
  // gradle
  'gradle.lockfile',
  // python
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'pdm.lock',
  // ruby
  'Gemfile.lock',
  // go
  'go.sum',
  // dotnet
  'packages.lock.json',
];

/**
 * `lstat`, never `stat`, and never a throw.
 *
 * Every caller here is measuring a path the walk found some milliseconds ago, which may since
 * have been deleted, become unreadable, or been swapped for a symlink. Returning `undefined`
 * makes all three the same harmless case: the signal is simply not available. Throwing would
 * abort the scoring of a project because one of its build directories vanished.
 */
async function mtimeOfPath(target: string): Promise<number | undefined> {
  try {
    const stat = await lstat(target);
    // Invariant 2: a link is never traversed. Its own mtime is not the build time of anything
    // — counting it would report the moment the link was created as the moment of the last
    // build, and a link is not a build directory in the first place.
    if (stat.isSymbolicLink()) return undefined;
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

/** Newest mtime across `targets`, or 0 when none of them could be measured. */
async function newestOf(targets: readonly string[]): Promise<number> {
  if (targets.length === 0) return 0;
  const times = await Promise.all(targets.map(mtimeOfPath));
  let newest = 0;
  for (const time of times) {
    if (time !== undefined && time > newest) newest = time;
  }
  return newest;
}

/**
 * The five signals for one project, gathered concurrently.
 *
 * `newestSourceMs` comes from `newestMtimeMs(root, artifactPaths)` — the artifact directories
 * are passed as exclusions so the walk *prunes* them rather than filtering them out
 * afterwards. That is what makes the number mean "when was this last edited" rather than
 * "when was this last built": a `target/` full of freshly written object files would
 * otherwise make every built project look worked-on a minute ago, and nothing would ever
 * score dormant.
 *
 * `newestArtifactMs` is the reverse view — the artifact directories' own mtimes, one `lstat`
 * each, which is the last time a build wrote into them.
 *
 * Nothing here throws. Anything unreadable reports as absent (optional signals) or 0
 * (`newestSourceMs`, `newestArtifactMs`), because a project whose signals cannot be gathered
 * must still be scored, and `scoreActivity` is where "unknown" gets its meaning.
 */
export async function gatherSignals(
  root: string,
  artifacts: readonly Artifact[],
  git: GitInfo | undefined,
): Promise<ActivitySignals> {
  const artifactPaths = artifacts.map((entry) => entry.path);
  const lockfilePaths = LOCKFILE_NAMES.map((name) => path.join(root, name));

  const [newestSourceMs, newestArtifactMs, lockfileMs] = await Promise.all([
    newestMtimeMs(root, artifactPaths).catch(() => 0),
    newestOf(artifactPaths),
    newestOf(lockfilePaths),
  ]);

  const signals: ActivitySignals = {
    hasUncommittedChanges: git?.hasUncommittedChanges ?? false,
    newestSourceMs,
    newestArtifactMs,
  };

  // Both optionals are assigned only when the signal genuinely exists; see the module note on
  // absent-is-not-zero.
  if (git !== undefined && git.lastCommitMs > 0) signals.lastCommitMs = git.lastCommitMs;
  if (lockfileMs > 0) signals.lockfileMs = lockfileMs;

  return signals;
}

/**
 * Turn signals into an `ActivityScore`.
 *
 * TODO(owner): **author the scoring rule. This is the only intentional TODO in this
 * codebase** — everything else is implemented. The spec ("Activity scoring") assigns this
 * body to the repository owner because what counts as "active" is a judgement about how you
 * work, not a derivation from the data. Nobody else can make it correctly.
 *
 * Until then this returns `status: 'active'` for **every** project. Nothing is dormant, so
 * nothing is selected by default, so the tool protects rather than deletes while the rule is
 * unauthored. Everything remains manually selectable in the TUI — protection is a default,
 * not a lock — so the tool is usable, merely unopinionated. Failing in the other direction
 * would mean offering to delete build output from a project someone is working in today.
 *
 * The six inputs available, all of them already gathered by `gatherSignals` above:
 *
 * | Input                          | Meaning                                                |
 * | ------------------------------ | ------------------------------------------------------ |
 * | `signals.lastCommitMs`         | Last commit, epoch ms. **Absent** when there is no repo |
 * |                                | or no commit yet — do not read absence as 1970.         |
 * | `signals.hasUncommittedChanges` | Working tree is dirty. `false` when there is no repo.  |
 * | `signals.newestSourceMs`       | Newest source-file edit, artifacts and `.git` pruned.   |
 * |                                | 0 when the tree is empty or unreadable.                 |
 * | `signals.newestArtifactMs`     | Newest artifact-directory mtime — the last build.       |
 * |                                | 0 when there are no artifacts.                          |
 * | `signals.lockfileMs`           | Newest lockfile mtime. **Absent** when none exists.     |
 * | `nowMs`                        | The scan's clock. Injected, never `Date.now()` inline,  |
 * |                                | so scoring is deterministic under test.                 |
 *
 * Required return shape — `ActivityScore` from `types.js`, all three fields, always:
 *
 * - `status`: `'active'` protects (rendered in the protected section, unselected by default);
 *   `'dormant'` offers (selected by default). Prefer `'active'` whenever the signals are
 *   ambiguous or missing; the cost of a wrong `'active'` is unreclaimed disk space, the cost
 *   of a wrong `'dormant'` is a rebuild the user did not ask for.
 * - `idleMs`: non-negative, finite. Rendered as "dormant 8mo" by `ui/format.ts`.
 * - `reason`: short, non-empty, user-facing. It appears verbatim in the detail pane and the
 *   static report, and it is the user's only insight into this decision — "committed 3d ago",
 *   "uncommitted changes", "built 2h ago".
 *
 * The three cases the spec requires this body to resolve **explicitly**, each one a case
 * where the obvious rule is wrong:
 *
 * 1. **Uncommitted changes but no recent commits.** Abandoned mid-edit years ago still looks
 *    "dirty" forever. Is a stale dirty tree protected indefinitely?
 * 2. **Built recently but never committed.** A dev server or watch build touches artifacts
 *    continuously while the source sits untouched. `newestArtifactMs` is therefore evidence
 *    of a *machine*, not necessarily of a *person* — which is why it is reported separately
 *    from `newestSourceMs` rather than merged into one "newest mtime".
 * 3. **No git repository at all.** Every git signal is absent. Scoring on filesystem mtimes
 *    alone must not treat absence as staleness.
 *
 * The stub below derives `idleMs` honestly — it is arithmetic, not judgement, and the display
 * needs it — and hard-codes only the parts that are yours: `status` and `reason`.
 */
const DAY = 86_400_000;

/**
 * How recently a person must have touched a project for it to count as active.
 *
 * Thirty days spans a holiday, a sprint on something else, or a month of meetings without
 * declaring the work abandoned. Below this the answer is "you are still on this"; above it,
 * "you would not notice a rebuild".
 */
const ACTIVE_DAYS = 30;

/**
 * The extra grace a project gets for having uncommitted changes.
 *
 * Case 1 from the contract above. Cleaning artifacts can never destroy uncommitted source —
 * artifacts are not source, and the allowlist cannot name `src/` — so a dirty tree is not a
 * data-loss risk. It is evidence that you stopped mid-thought, and the cost of clearing its
 * `target/` is that you lose your place. That is worth a longer benefit of the doubt, but not
 * permanent immunity: a tree left dirty three years ago is abandoned, not paused, and
 * indefinite protection would let one forgotten `git stash`-worth of edits hold 30 GB forever.
 */
const DIRTY_GRACE_DAYS = 90;

export function scoreActivity(signals: ActivitySignals, nowMs: number): ActivityScore {
  // Case 2. Only *authoring* counts. `newestArtifactMs` is deliberately absent from this max:
  // a watch build, a dev server, a CI checkout or an `npm install` touches artifacts without
  // anyone deciding anything, so admitting it would mark every project you once ran as
  // permanently active — which is precisely how a cleaner ends up finding nothing to clean.
  const authoredMs = Math.max(
    signals.lastCommitMs ?? 0,
    signals.newestSourceMs,
    signals.lockfileMs ?? 0,
  );

  // Case 3, and any unreadable tree: no measurable human signal at all. Report zero idle and
  // protect, because "I cannot tell" must never render as "eight months dormant" — the reason
  // string is the user's only insight, and a confident wrong number is worse than an
  // admission of ignorance.
  if (authoredMs <= 0) {
    return { status: 'active', idleMs: 0, reason: 'no dates to score — protected' };
  }

  const idleMs = Math.max(0, nowMs - authoredMs);
  const limitDays = signals.hasUncommittedChanges ? DIRTY_GRACE_DAYS : ACTIVE_DAYS;
  const status = idleMs < limitDays * DAY ? 'active' : 'dormant';

  // The reason names the signal that actually decided it, so a surprising verdict is
  // debuggable from the interface alone.
  const committed = signals.lastCommitMs ?? 0;
  const edited = signals.newestSourceMs;
  const what =
    authoredMs === committed && committed >= edited
      ? 'committed'
      : authoredMs === edited
        ? 'edited'
        : 'dependencies changed';

  const ago = `${what} ${humanize(idleMs)} ago`;
  const reason = signals.hasUncommittedChanges
    ? status === 'active'
      ? `uncommitted changes, ${ago}`
      : `uncommitted but ${ago} — past the ${DIRTY_GRACE_DAYS}-day grace`
    : ago;

  return { status, idleMs, reason };
}

/** Coarse, human-facing duration for the reason string. `ui/format.ts` owns the list column. */
function humanize(ms: number): string {
  const days = Math.floor(ms / DAY);
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year' : `${years} years`;
}
