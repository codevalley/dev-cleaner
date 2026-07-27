/**
 * Row labels: why a project is being held back, and what clearing it would cost.
 *
 * The list already says *how much* every project is worth and the detail pane already says
 * *why* it scored the way it did — but only for the one row under the cursor, in prose, one
 * row at a time. A user comparing twelve projects cannot read twelve detail panes. These
 * chips are that same knowledge made scannable: a handful of words per row, in a fixed order,
 * so a column of rows can be compared without moving the cursor.
 *
 * # The one rule
 *
 * **Every label must change a decision.** A chip that is merely true is worse than no chip,
 * because it teaches the eye that this part of the row is decoration and the eye then skips
 * the chip that mattered. Six survive that test and they are the complete set:
 *
 * | chip            | changes which decision                                              |
 * | --------------- | ------------------------------------------------------------------- |
 * | `uncommitted`   | commit before you clear it, or you lose your place                    |
 * | `edited 8d`     | how warm this is — whether you will rebuild it today or never         |
 * | `worktree`      | a secondary checkout, not your main repo: the cheapest thing to give up |
 * | `slow`          | the rebuild costs minutes of your attention, not seconds              |
 * | `needs network` | do not do this on a plane                                             |
 * | `offline`       | you *can* do this on a plane                                          |
 *
 * Two candidates were considered and deliberately left out. A "deps changed" lockfile chip —
 * your lockfile is newer than your `node_modules` — is true surprisingly often and decisive
 * almost never. And the project types (`node`, `rust`, `xcode`) are not labels at all: the row
 * and the detail pane already show them, and repeating a fact is how a label row turns into
 * soup.
 *
 * # Why this is not decoration
 *
 * The section these chips were asked for used to be headed `ACTIVE (protected)`. "Protected"
 * asserts a *safety* property, and the user who read it correctly inferred that some danger
 * was being guarded against and then could not find out what. There is no danger: cleaning an
 * artifact cannot destroy source or uncommitted work, because a row exists only when a pattern
 * in `ARTIFACT_TABLE` named the directory and that allowlist cannot name `src/`. The honest
 * axis was never risk, it is **cost to restore** — and cost to restore is a thing you can
 * state precisely, per project, from data the scan already holds.
 *
 * That is what these chips let the interface say. Not "this is dangerous", which is false, but
 * "this would cost you a slow offline rebuild", which is true, checkable, and actually the
 * question the user was weighing.
 *
 * # Strings live here
 *
 * Every word a chip can render is in this file, including the separator, so a component can
 * lay chips out without deciding what they say and a test can assert the wording without a
 * terminal. Pure: no React, no Ink, no filesystem, no clock.
 */

import { formatIdle } from './format.js';
import type { Category, Project, ProjectType } from '../types.js';

export type LabelKind = 'uncommitted' | 'recency' | 'worktree' | 'slow' | 'network' | 'offline';

/**
 * What a chip is *for*, which is all a component needs in order to colour it.
 *
 * - `warn` — you may want to act before cleaning (commit first).
 * - `info` — context that positions the row; nothing to do about it.
 * - `cost`  — what the rebuild will charge you: time, or bandwidth.
 *
 * Deliberately not a colour. A component that receives `'yellow'` cannot know whether the
 * yellow meant danger or expense, and the two are the distinction this whole module exists to
 * keep apart.
 */
export type LabelTone = 'warn' | 'info' | 'cost';

export interface Label {
  kind: LabelKind;
  /** The chip as drawn in a list row. Short, because four of them share a narrow line. */
  text: string;
  /**
   * The same chip where there is room for it — the detail pane, the static report. Still a
   * phrase, never a sentence; `LABEL_HELP` is where the sentence lives.
   */
  long: string;
  tone: LabelTone;
}

/**
 * Render order, fixed, and the reason `labelsFor` sorts rather than pushing in whatever order
 * the checks happen to run.
 *
 * Chips are only worth reading if they can be compared *down a column*, and a column only
 * exists if every row agrees where each kind goes. The order runs from the state of the work
 * (is it finished, how warm is it, what kind of checkout is this) to the price of clearing it,
 * so a row reads left to right as a sentence: `uncommitted · edited 8d · slow · needs network`.
 *
 * Connectivity comes last on purpose. Exactly one of `network`/`offline` is always present
 * (see `labelsFor`), so every row ends on the same question and the eye can find that answer
 * without reading the chips in front of it.
 */
export const LABEL_ORDER: readonly LabelKind[] = [
  'uncommitted',
  'recency',
  'worktree',
  'slow',
  'network',
  'offline',
];

const ORDER_INDEX: ReadonlyMap<LabelKind, number> = new Map(
  LABEL_ORDER.map((kind, index) => [kind, index] as const),
);

/** What a component puts between two chips. Here, not there — it is a string like any other. */
export const LABEL_SEPARATOR = ' · ';

/**
 * One line per chip, for the detail pane: what it means **for a decision**.
 *
 * Not what it is. `slow` is not "a Rust project" — the user can already see that the project
 * is Rust, and being told so again explains nothing. `slow` is "rebuilding this takes
 * minutes", which is the fact they are actually trading against the gigabytes.
 */
export const LABEL_HELP: Record<LabelKind, string> = {
  uncommitted:
    'Work in progress is sitting in this tree. Cleaning cannot reach it — only build output ' +
    'is ever listed — but you may want to commit first so you do not lose your place.',
  recency:
    'How long since you last touched this, and the signal that decided its score. The warmer ' +
    'it is, the sooner you will pay for the rebuild.',
  worktree:
    'A secondary checkout, not your main repo. Its build output is usually the easiest thing ' +
    'here to give up — and the easiest to have forgotten you were keeping.',
  slow:
    'Rebuilding this takes minutes, not seconds. What you are trading for the space is your ' +
    'attention, and it has nothing to do with how big the directory is.',
  network:
    'Rebuilding downloads dependencies again. Not something to start on a plane or bad wifi.',
  offline:
    'Rebuilds from source you already have. No connectivity needed, so this one is safe to ' +
    'clear anywhere.',
};

/**
 * The ecosystems whose rebuild is measured in minutes.
 *
 * **By ecosystem, never by size**, and that inversion is the whole content of the chip. A 6 GB
 * `.next` is regenerated in seconds; a 2 GB Rust `target/` is a from-scratch compile of every
 * dependency in the graph. Ranking rebuild cost by directory size — the obvious rule, and the
 * one a size-sorted list invites — gets that backwards for the two ecosystems where it matters
 * most, and would tell the user to clear the expensive thing first.
 *
 * Three qualify: Rust (`target`), Xcode (`DerivedData`, `build`, `.build`) and Gradle
 * (`build`, `.gradle`). Everything else in the table regenerates fast enough that saying so
 * would be noise — and a chip that appears on every row is a chip nobody reads.
 *
 * Keyed on the project's declared types rather than on which artifact directories survive,
 * because the type is what determines the compiler that will have to run. A Rust project whose
 * `target/` was cleaned last week is still a Rust project, and rebuilding it still costs
 * minutes.
 */
const SLOW_TYPES: ReadonlySet<ProjectType> = new Set<ProjectType>(['rust', 'xcode', 'gradle']);

/**
 * The recency phrase inside an `ActivityScore.reason`, exactly as `scoreActivity` writes it.
 *
 * The chip and the reason are two renderings of one fact, and the fact lives in `activity.ts`.
 * `Project` does not carry the signals that scoring saw — `newestSourceMs` and `lockfileMs` are
 * gathered, used, and dropped — so the reason string is the only surviving record of *which*
 * signal the verdict turned on. Reading the verb back out of it is therefore not a shortcut
 * around the real answer; it is the only access to the real answer this side of the boundary,
 * and it cannot drift from what the detail pane shows because it *is* what the detail pane
 * shows.
 *
 * `\b` before the verb is load-bearing: every dirty project's reason begins with the word
 * "uncommitted", and an unanchored `committed` would match inside it and report a commit date
 * that scoring never considered.
 */
const RECENCY_PHRASE = /\b(committed|edited) ([^,—]+?) ago\b/;

/**
 * The recency chip, or nothing.
 *
 * Nothing in three cases, all of which are the same case: `scoreActivity` did not turn on a
 * date a person set. No dates at all (`no dates to score — protected`); a lockfile decided it
 * (`dependencies changed 5 days ago`) — the one recency signal too weak to be worth a chip,
 * which is why there is no "deps changed" chip to render it as; or a future rewrite of the
 * scorer phrases its reason some other way.
 *
 * Silence rather than a guess, because the failure mode is not a missing chip. It is a chip
 * reading `edited 5d` beside a detail pane reading `dependencies changed 5 days ago`, which
 * makes a user who notices distrust both — and the ones who do not notice are worse off still.
 *
 * `text` takes its duration from `formatIdle(idleMs)`, the same rendering as the `dormant 8mo`
 * on the status line, so the two agree in a row. `long` is the matched phrase itself, copied
 * verbatim out of the reason, which is as literal as agreement gets.
 */
function recencyLabel(project: Project): Label | undefined {
  const match = RECENCY_PHRASE.exec(project.activity.reason);
  if (match === null) return undefined;

  const verb = match[1];
  const phrase = match[0];
  if (verb === undefined || phrase === undefined) return undefined;

  return {
    kind: 'recency',
    text: `${verb} ${formatIdle(project.activity.idleMs)}`,
    long: phrase,
    tone: 'info',
  };
}

/**
 * The chips for one project, in `LABEL_ORDER`.
 *
 * `categories` is the preset's category set — the same narrowing `enabledArtifacts` applies —
 * and it exists for one chip. Under `recommended`, `node_modules` is not cleaned, so clearing a
 * Node project touches only `dist/` and `.next/` and the rebuild needs no network at all;
 * saying `needs network` there would be false. Callers that have a preset should pass it.
 *
 * Omitting it considers every artifact the scan found, which is the over-warning direction: a
 * spurious `needs network` costs a user a rebuild they could have done on the plane, while a
 * spurious `offline` strands them. Neither is good, and only one of them is recoverable.
 */
export function labelsFor(project: Project, categories?: ReadonlySet<Category>): Label[] {
  const artifacts =
    categories === undefined
      ? project.artifacts
      : project.artifacts.filter((artifact) => categories.has(artifact.category));

  const labels: Label[] = [];
  const { git } = project;

  // The two git chips are derived together because they are guarded by the same absence, and
  // neither has a false form: a project with no repository has not "committed everything" and
  // is not "not a worktree". It has no answer, and inventing the reassuring one is how a chip
  // becomes something to distrust. Deriving them side by side is also why the sort at the
  // bottom is load-bearing rather than decorative — `recency` belongs between them on screen.
  if (git !== undefined) {
    if (git.hasUncommittedChanges) {
      labels.push({
        kind: 'uncommitted',
        text: 'uncommitted',
        long: 'uncommitted changes',
        tone: 'warn',
      });
    }
    if (git.isWorktree) {
      labels.push({ kind: 'worktree', text: 'worktree', long: 'linked worktree', tone: 'info' });
    }
  }

  const recency = recencyLabel(project);
  if (recency !== undefined) labels.push(recency);

  if ([...project.types].some((type) => SLOW_TYPES.has(type))) {
    labels.push({ kind: 'slow', text: 'slow', long: 'slow rebuild', tone: 'cost' });
  }

  // Exactly one of these, always, on every project — which is what makes the answer readable
  // as a position rather than as a presence. "No network chip" would be indistinguishable from
  // "nobody worked out whether it needs the network", and the user would have to go and check.
  labels.push(
    artifacts.some((artifact) => artifact.category === 'deps')
      ? { kind: 'network', text: 'needs network', long: 'needs network to rebuild', tone: 'cost' }
      : { kind: 'offline', text: 'offline', long: 'rebuilds offline', tone: 'info' },
  );

  return labels.sort(
    (a, b) => (ORDER_INDEX.get(a.kind) ?? 0) - (ORDER_INDEX.get(b.kind) ?? 0),
  );
}

/** The chips as one string, for a row or a report line. `long` where there is room for it. */
export function joinLabels(labels: readonly Label[], form: 'text' | 'long' = 'text'): string {
  return labels.map((label) => label[form]).join(LABEL_SEPARATOR);
}
