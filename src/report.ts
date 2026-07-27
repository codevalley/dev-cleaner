/**
 * The two pieces of prose the tool emits outside the TUI.
 *
 * `renderReport` is what a non-TTY invocation prints instead of rendering (spec:
 * "Degradation"). It is deliberately built from the *same* `buildRows` and
 * `defaultSelection` the interface uses, so a piped report and an interactive session agree
 * on what exists, what it costs, and what would be selected. Reimplementing that grouping
 * here would let the two drift, and the report is the only view a CI or `| less` user ever
 * sees.
 *
 * `renderCleanSummary` discharges **safety invariant 8**. Trash is a move, not a delete:
 * until the Trash is emptied the disk is exactly as full as it was. A summary that says
 * "freed 75G" is therefore false, and the user who believes it goes looking for the space
 * that is still sitting in `~/.Trash`. The disclosure is not a nicety — it is the only
 * thing that makes the reported number mean what it appears to mean.
 *
 * Marks are ASCII (`[x]` / `[ ]` / `[-]`) rather than the list's `◉` / `○`: this output is
 * redirected to files and pipes, where the terminal glyphs are noise. `[-]` is a row the run
 * has already established it would refuse; it is listed with its reason and left out of the
 * "selected by default" total, because a total that includes something the tool will then
 * refuse is a promise it does not keep.
 *
 * ## Why the report carries the interface's chips
 *
 * Every project row prints the labels `ui/labels.ts` derives — why the row is being held back
 * and what clearing it would cost. Not because the report needs decoration, but because a
 * piped report and an interactive session disagreeing about a row is the exact divergence
 * class this file's header already complains about twice: the report is built from the same
 * `buildRows`, the same `defaultSelection`, and now the same `labelsFor`, so there is no
 * second opinion for the two views to differ on. The static report is also the mode a cautious
 * user reaches for first, because it cannot delete; sending them the *less* informative view
 * would be exactly backwards.
 *
 * The chips are rendered in their `long` form and the activity reason they duplicate is
 * dropped — see `residualReason`. Anything else and the row would state one fact three times
 * in three registers, which is how a label row stops being read at all.
 *
 * ## Where the `[-]` rows come from
 *
 * Two screens, and only one of them is written here. `CacheEntry.blocked` arrives with the
 * cache from `caches.ts`; everything else comes from `screenReport`, which asks
 * `clean.ts`'s own guards — the exact functions the deletion boundary runs — which rows they
 * would refuse. That is the point: the report shows what is *selected* and `clean` decides
 * what is *deletable*, so any second opinion computed here would drift from the boundary and
 * the tool would go back to promising space it then refuses. `renderReport` itself stays a
 * pure string builder over rows and blocks; `renderScreenedReport` is the pairing the CLI
 * uses, so the printing path cannot forget to screen.
 *
 * Cost is bounded the way `clean.ts` documents: the cheap tier (a handful of `lstat`s, no
 * subtree walked) over every listed row, the expensive tier (the nested-repository scan)
 * only over what is actually selected. An unselected row's bytes are not in the promised
 * total, so a scan that costs seconds per candidate buys nothing there.
 */

import path from 'node:path';

import { screenTargets, screenTargetsCheaply } from './clean.js';
import type { Screening, ScreeningOptions } from './clean.js';
import type { CacheEntry, Category, CleanOutcome, CleanTarget, Preset, Project } from './types.js';
import { formatBytes, formatIdle } from './ui/format.js';
import { LABEL_SEPARATOR, labelsFor } from './ui/labels.js';
import type { Label } from './ui/labels.js';
import {
  buildRows,
  defaultSelection,
  enabledArtifacts,
  isSelected,
  rowBlock,
  toTargets,
} from './ui/model.js';
import type { Row, RowBlock, RowBlocks, Selection } from './ui/model.js';

/**
 * Structurally a `ScanResult` plus the preset's categories. Taking the shape rather than
 * the type keeps this module free of any dependency on the scanning pipeline — the report
 * is a pure function of projects and caches.
 */
export interface ReportInput {
  projects: readonly Project[];
  caches: readonly CacheEntry[];
  /** The preset's categories. Artifacts outside them are neither listed nor counted. */
  categories: ReadonlySet<Category>;
  preset?: Preset | undefined;
  roots?: readonly string[] | undefined;
  /**
   * Rows the run has already established it would refuse, by row id — `screenReport`'s
   * output. Absent means "nothing was screened", which is honest for a caller that has not
   * screened but is never what the CLI does: see `renderScreenedReport`.
   */
  blocks?: RowBlocks | undefined;
}

/**
 * `ReportInput` with the one thing screening cannot be done without: the scan roots, already
 * `realpath`-resolved by `resolveScanRoot`. Required rather than optional, because a screen
 * run with no roots refuses every project row as `outside-project-root` — a report that
 * blocks everything is exactly as useless as one that blocks nothing.
 */
export interface ScreenedReportInput extends ReportInput {
  roots: readonly string[];
}

/** Width of the name column. Wide enough for `apps/macos-file-provider` unabbreviated. */
const LABEL_WIDTH = 34;
const SIZE_WIDTH = 7;

const NOTHING_DELETED =
  'Nothing was deleted. Run dev-cleaner in a terminal to review and clean interactively.';

const CATEGORY_ORDER: readonly Category[] = ['build', 'deps', 'cache'];

function categoryList(categories: ReadonlySet<Category>): string {
  const enabled = CATEGORY_ORDER.filter((category) => categories.has(category));
  return enabled.length === 0 ? 'none' : enabled.join(' + ');
}

/** Pads without truncating: a report is read in a pager, not a fixed-width pane. */
function column(label: string, bytes: number): string {
  return `${label.padEnd(LABEL_WIDTH)}${formatBytes(bytes).padStart(SIZE_WIDTH)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The word `scoreActivity` uses for a dirty tree, in both of the sentences it builds around it:
 * `uncommitted changes, edited 8 days ago` while the grace still applies, and
 * `uncommitted but edited 100 days ago — past the 90-day grace` once it has run out. The chip
 * says `uncommitted changes` in either case, so both spellings have to come out.
 */
const UNCOMMITTED_PHRASE = /\buncommitted(?: changes)?\b/;

/** Punctuation and conjunctions left stranded when a clause is lifted out of the middle. */
const STRANDED_HEAD = /^[\s,;·—–-]*(?:but|and)?[\s,;·—–-]*/;
const STRANDED_TAIL = /[\s,;·—–-]*$/;

/**
 * What `activity.reason` still has to say once the chips have said their part.
 *
 * The reason and two of the chips are renderings of one fact: `labels.ts` builds the recency
 * chip's `long` by copying the phrase *verbatim* out of this very string, and the `uncommitted`
 * chip out of the word in front of it. Printing both would put `uncommitted changes, edited 8
 * days ago` on one line and `uncommitted changes · edited 8 days ago` on the next — the same
 * sentence twice, one line apart, which teaches the eye that this part of the row is filler.
 *
 * So the duplicated clauses are removed and whatever the scorer said *beyond* them is kept.
 * Removing rather than suppressing the whole line is the load-bearing choice: the residue is
 * not always empty, and when it is not, it is the most decision-relevant thing on the row.
 *
 * - `uncommitted changes, edited 8 days ago` → nothing left; the chips said all of it.
 * - `uncommitted but edited 100 days ago — past the 90-day grace` → `past the 90-day grace`,
 *   which is the answer to "why is this dirty project checked?" and no chip carries it.
 * - `dependencies changed 5 days ago` → kept whole. There is deliberately no lockfile chip
 *   (`labels.ts` explains why), so this line is the only place that signal is ever stated.
 * - `no dates to score — protected` → kept whole. "I cannot tell" is not a chip and must not
 *   silently become one.
 */
function residualReason(reason: string, labels: readonly Label[]): string {
  let rest = reason;
  for (const label of labels) {
    if (label.kind === 'uncommitted') rest = rest.replace(UNCOMMITTED_PHRASE, '');
    // `long` is the matched phrase itself, so this is a literal removal of literal duplication.
    else if (label.kind === 'recency') rest = rest.replace(label.long, '');
  }
  return rest
    .replace(STRANDED_HEAD, '')
    .replace(STRANDED_TAIL, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Type, verdict, and whatever the reason still adds.
 *
 * The age survives the chips on purpose. `dormant 8mo` is the *verdict and its magnitude* —
 * the thing that decided which section this row is in and whether it starts checked — while
 * `edited 8mo ago` names *which signal* produced it. They share a number and assert different
 * facts, and the one that would be dropped is the one the preselection turns on.
 */
function projectMeta(project: Project, labels: readonly Label[]): string {
  const types = [...project.types].sort().join(', ');
  const { status, idleMs, reason } = project.activity;
  const age = status === 'dormant' ? `dormant ${formatIdle(idleMs)}` : 'active';
  const rest = residualReason(reason, labels);
  return [types, age, rest].filter((part) => part.length > 0).join(' · ');
}

/**
 * The width a chip line must stay inside, and the indent it starts at.
 *
 * 80 because that is what a pager and a redirected-to-a-file report are read at, and because a
 * chip that wraps where the terminal happens to end is a chip that cannot be compared down the
 * column — which is the entire reason the labels are in a fixed order. The report's two closing
 * sentences already run past 80; they are prose, read once, and nothing lines up under them.
 * A chip line is a column, so it is the one that has to hold the line.
 */
const CHIP_INDENT = '      ';
const CHIP_WIDTH = 80;

/** A wrapped chip line ends on the separator, so a continuation reads as one. */
const CHIP_CONTINUATION = LABEL_SEPARATOR.trimEnd();

/**
 * The chips, `long`, wrapped at chip boundaries.
 *
 * `long` rather than `text` because the report has the room the list pane does not, and because
 * the long form of the recency chip *is* the phrase this row used to print as prose — so the
 * decomposition into chips loses no wording the report already promised, it only adds.
 *
 * Wrapped rather than truncated: a chip is a fact, and half a fact is worse than the same fact
 * on a second line. The budget subtracts the continuation marker so that adding it can never
 * itself push a line past `CHIP_WIDTH`. A single chip longer than the budget still gets its own
 * line rather than being cut — nothing `labels.ts` can produce comes close, and if a future
 * reason phrase does, an over-long line is a far smaller failure than a silently clipped one.
 */
function chipLines(labels: readonly Label[]): string[] {
  const budget = CHIP_WIDTH - CHIP_INDENT.length - CHIP_CONTINUATION.length;
  const lines: string[] = [];
  let current = '';

  for (const label of labels) {
    if (current.length === 0) {
      current = label.long;
      continue;
    }
    const candidate = `${current}${LABEL_SEPARATOR}${label.long}`;
    if (candidate.length <= budget) {
      current = candidate;
      continue;
    }
    lines.push(`${CHIP_INDENT}${current}${CHIP_CONTINUATION}`);
    current = label.long;
  }
  if (current.length > 0) lines.push(`${CHIP_INDENT}${current}`);

  return lines;
}

/** The one reason this row cannot be cleaned, whichever screen established it. */
function blockedReason(row: Row, blocks: RowBlocks | undefined): string | undefined {
  return rowBlock(row, blocks)?.reason;
}

function itemLines(
  row: Row,
  selection: Selection,
  categories: ReadonlySet<Category>,
  blocks: RowBlocks | undefined,
): string[] {
  if (row.kind === 'header') return [];

  // A third mark, not an empty box: `[ ]` means "you could select this", and a blocked row
  // is one the run has already established it would refuse. Same reason the mark exists at
  // all — the report is the only view a piped invocation ever gets.
  const blocked = blockedReason(row, blocks);
  const mark = blocked !== undefined ? '[-]' : isSelected(selection, row) ? '[x]' : '[ ]';
  const lines = [`  ${mark} ${column(row.label, row.bytes)}`];

  if (row.kind === 'project') {
    // The preset's categories, not every artifact the scan found: under `recommended` no
    // `node_modules` is cleaned, so clearing this row needs no network and saying otherwise
    // would be false. `enabledArtifacts` below narrows by the same set.
    const labels = labelsFor(row.project, categories);
    lines.push(`      ${projectMeta(row.project, labels)}`);
    lines.push(...chipLines(labels));
    // Printed before the artifact breakdown, which is what the reason usually names: the
    // user reads "why not" next to the mark, then which directory provoked it.
    if (blocked !== undefined) lines.push(`      blocked: ${blocked}`);
    for (const artifact of enabledArtifacts(row.project, categories)) {
      lines.push(`      ${column(`${artifact.relPath}/`, artifact.bytes)}  ${artifact.category}`);
    }
  } else {
    lines.push(`      ${row.cache.note}`);
    if (blocked !== undefined) lines.push(`      blocked: ${blocked}`);
  }
  return lines;
}

/**
 * The whole scan as text: sections in the interface's order, each item marked with whether
 * it would be selected by default, each project broken down by artifact.
 */
export function renderReport(input: ReportInput): string {
  const { projects, caches, categories, preset, roots, blocks } = input;
  const rows = buildRows({ projects, caches, categories });
  const selection = defaultSelection(rows, blocks);

  const lines: string[] = ['dev-cleaner'];
  if (roots !== undefined && roots.length > 0) lines.push(`roots:  ${roots.join(', ')}`);
  lines.push(`preset: ${preset ?? 'recommended'} (${categoryList(categories)})`);

  if (rows.length === 0) {
    lines.push('', 'No reclaimable artifacts found.', '', NOTHING_DELETED);
    return `${lines.join('\n')}\n`;
  }

  for (const row of rows) {
    if (row.kind === 'header') {
      lines.push('', `${row.label}  ·  ${plural(row.count, 'item')}  ·  ${formatBytes(row.bytes)}`);
      continue;
    }
    lines.push(...itemLines(row, selection, categories, blocks));
  }

  const selected = rows.filter((row) => row.kind !== 'header' && isSelected(selection, row));
  const blockedRows = rows.filter((row) => blockedReason(row, blocks) !== undefined);
  // Blocked wins over protected, so the two lines below partition what is missing from the
  // total instead of overlapping. An active project that is *also* refused would otherwise
  // have its bytes named twice, and a user adding the excluded numbers up would find more
  // missing than there is.
  const protectedRows = rows.filter(
    (row) =>
      row.kind === 'project' &&
      row.section === 'active' &&
      blockedReason(row, blocks) === undefined,
  );
  const selectedBytes = selected.reduce((sum, row) => sum + row.bytes, 0);

  lines.push(
    '',
    `Selected by default: ${plural(selected.length, 'item')} · ${formatBytes(selectedBytes)}`,
  );
  // Stated, not merely absent. A total that silently drops 7.5G is a number the user cannot
  // reconcile with the section header two screens up; naming the shortfall and its size is
  // what turns "the tool undercounted" into "the tool explained itself".
  if (blockedRows.length > 0) {
    const bytes = blockedRows.reduce((sum, row) => sum + row.bytes, 0);
    lines.push(
      `Blocked (not safe):  ${plural(blockedRows.length, 'item')} · ${formatBytes(bytes)}` +
        ' — excluded from the total above; the reason is listed with each.',
    );
  }
  if (protectedRows.length > 0) {
    const bytes = protectedRows.reduce((sum, row) => sum + row.bytes, 0);
    lines.push(
      `Protected (active):  ${plural(protectedRows.length, 'item')} · ${formatBytes(bytes)}` +
        ' — selectable by hand in the interactive interface.',
    );
  }
  lines.push('', NOTHING_DELETED);

  return `${lines.join('\n')}\n`;
}

/** Every row, selected — the argument that makes `toTargets` enumerate a row's own targets. */
function everySelection(rows: readonly Row[]): Selection {
  return {
    projects: new Set(rows.flatMap((row) => (row.kind === 'project' ? [row.project.root] : []))),
    caches: new Set(rows.flatMap((row) => (row.kind === 'cache' ? [row.cache.id] : []))),
  };
}

/**
 * Every `node_modules` the scan found, whatever the preset — invariant 5's input.
 *
 * Deliberately *not* filtered by category: under `recommended` the `deps` category is off, so
 * no `node_modules` is a target at all, and every one of them will still be on disk
 * hardlinking into the package store when the run ends. Filtering here would report the
 * store as prunable in the one configuration nearly every user runs.
 */
function nodeModulesPaths(projects: readonly Project[]): string[] {
  return projects.flatMap((project) =>
    project.artifacts
      .filter((artifact) => path.basename(artifact.path) === 'node_modules')
      .map((artifact) => artifact.path),
  );
}

/**
 * The boundary's inputs for one hypothetical selection. `unselectedNodeModules` is a property
 * of the *run*, not of a target, so it is recomputed per call from the targets being screened
 * — the recipe `ScreeningOptions` documents.
 */
function screeningOptions(
  input: ScreenedReportInput,
  targets: readonly CleanTarget[],
  allNodeModules: readonly string[],
): ScreeningOptions {
  const cleaned = new Set(
    targets.flatMap((target) => (target.kind === 'project' ? [target.artifact.path] : [])),
  );
  return {
    roots: input.roots,
    // The caches this scan produced, and only those: the same allowlist `cli.ts` builds from
    // the stream for the interactive path, so a cache row cannot be `unknown-cache` here.
    allowedCachePaths: input.caches.map((cache) => cache.path),
    unselectedNodeModules: allNodeModules.filter((candidate) => !cleaned.has(candidate)),
  };
}

/**
 * One row, one reason. A row is blocked when **any** of its targets would be refused, and the
 * first refusal is the one shown.
 *
 * Blocking the whole row is the conservative side of a choice forced by the fact that
 * selection is row-granular: a project row is one checkbox over several artifacts, so if one
 * of them is refused the row cannot deliver the bytes printed beside it. Excluding the row
 * under-promises (the run would still trash its other artifacts, and the user can select it
 * by hand to get them); counting it would over-promise, which is the defect being fixed.
 */
function record(
  into: Map<string, RowBlock>,
  screenings: readonly Screening[],
  owner: ReadonlyMap<CleanTarget, Row>,
  accept: (row: Row) => boolean,
): void {
  for (const screening of screenings) {
    const row = owner.get(screening.target);
    if (row === undefined || !accept(row) || into.has(row.id)) continue;
    into.set(row.id, { reason: `${screening.refusal}: ${screening.detail}` });
  }
}

/**
 * Ask `clean.ts`'s own guards which rows this run would refuse, before anything is selected
 * and before anything is printed. Nothing is deleted, written or moved: `screenTargets`
 * `lstat`s, `realpath`s and `readdir`s, and returns verdicts.
 *
 * The two tiers are the cost bound (see `clean.ts`'s header):
 *
 * - the **cheap** tier over every listed row — a handful of `lstat`s each, no subtree walked,
 *   so a 133 GB scan pays microseconds per row for the symlinked-ancestor, worktree,
 *   guarded-path, containment and allowlist verdicts;
 * - the **full** tier only over what the default selection actually promises, because the
 *   nested-repository scan is seconds per candidate on a large `target/` and an unselected
 *   row's bytes are in nobody's total.
 *
 * Where the full tier ran, its verdict is the one kept: it is the cheap tier's guards plus
 * the contents scan, so it is what `clean` would do for that selection.
 */
export async function screenReport(input: ScreenedReportInput): Promise<RowBlocks> {
  const { projects, caches, categories } = input;
  const rows = buildRows({ projects, caches, categories });
  const everything = everySelection(rows);

  // Row → the targets selecting it would produce, via the *same* `toTargets` the interface
  // hands to `clean`. Anything else here would be a second opinion about what a row means.
  const owner = new Map<CleanTarget, Row>();
  const all: CleanTarget[] = [];
  for (const row of rows) {
    for (const target of toTargets({ rows: [row], selection: everything, categories })) {
      owner.set(target, row);
      all.push(target);
    }
  }

  const allNodeModules = nodeModulesPaths(projects);
  const blocks = new Map<string, RowBlock>();

  // The cheap tier is independent of what ends up selected, so it runs once over everything.
  const cheap = await screenTargetsCheaply(all, screeningOptions(input, all, allNodeModules));

  // Screening has to reach a FIXED POINT, because blocking a row can *add* a refusal rather
  // than only removing work.
  //
  // Invariant 5's input is `unselectedNodeModules` — the hardlink sources that will still be
  // on disk afterwards — which is a property of the whole selection, not of one target. So
  // when a project row is blocked (say its `dist` is a gh-pages clone), its `node_modules`
  // leaves the cleaned set, joins `unselectedNodeModules`, and can make a store prune unsafe
  // that screened clean a moment ago. An earlier version screened the pre-block selection
  // once and asserted in a comment that later rounds "would only ever remove work"; that is
  // true of every refusal reason except this one, and this one is the reason the screening
  // exists.
  //
  // Blocking is monotone — a round can only add blocks, never retract one — so the loop
  // converges. Two rounds settle every case reachable today; the third is a backstop, and
  // exiting by exhaustion rather than by stability would mean shipping an unscreened promise,
  // so the loop is written to terminate on stability.
  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const selection = defaultSelection(rows, blocks);
    const isPromised = (row: Row): boolean => isSelected(selection, row);
    const selected = all.filter((target) => {
      const row = owner.get(target);
      return row !== undefined && isPromised(row);
    });

    const before = blocks.size;
    // A row that is not promised still gets its cheap verdict recorded, so the listing can
    // explain a row it is not offering; the expensive tier is spent only on what is promised.
    record(blocks, cheap, owner, (row) => !isPromised(row));
    record(
      blocks,
      await screenTargets(selected, screeningOptions(input, selected, allNodeModules)),
      owner,
      () => true,
    );
    if (blocks.size === before) break;
  }
  return blocks;
}

/**
 * The report the CLI prints: screened, then rendered.
 *
 * The pairing is the point. `renderReport` cannot screen — it is synchronous and pure, which
 * is what makes it testable against fixed inputs — so if screening were left to the caller
 * there would be a way to print an unscreened report, and the promised total would go back to
 * being a number the run does not keep. One function does both, and it is the only one
 * `cli.ts` calls.
 */
export async function renderScreenedReport(input: ScreenedReportInput): Promise<string> {
  return renderReport({ ...input, blocks: await screenReport(input) });
}

const OUTCOME_WIDTH = 8;

function outcomeLine(outcome: CleanOutcome): string {
  const reason = [outcome.refusal, outcome.detail].filter((part) => part !== undefined).join(': ');
  const line = `  ${outcome.outcome.padEnd(OUTCOME_WIDTH)}${column(outcome.label, outcome.bytes)}`;
  return reason.length === 0 ? line : `${line}  ${reason}`;
}

/**
 * What happened, and — invariant 8 — what it did and did not free.
 *
 * Refusals and failures are listed with their reason rather than summarised, because a
 * refusal is the safety layer reporting that it stopped something: hiding it behind a count
 * turns a deliberate guard into an unexplained shortfall in the total.
 */
export function renderCleanSummary(outcomes: readonly CleanOutcome[]): string {
  const trashed = outcomes.filter((outcome) => outcome.outcome === 'trashed');
  const trashedBytes = trashed.reduce((sum, outcome) => sum + outcome.bytes, 0);
  const total = formatBytes(trashedBytes);

  const lines: string[] = [];

  if (outcomes.length === 0) {
    lines.push('Nothing was selected, so nothing was moved to the Trash.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`Cleaned ${trashed.length} of ${plural(outcomes.length, 'item')}.`, '');
  for (const outcome of outcomes) lines.push(outcomeLine(outcome));
  lines.push('');

  if (trashed.length === 0) {
    lines.push('Nothing was moved to the Trash.');
  } else {
    lines.push(
      `${total} is now in the Trash.`,
      `The Trash still occupies the disk — empty it to reclaim the ${total}.`,
    );
  }

  return `${lines.join('\n')}\n`;
}
