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
 * Marks are ASCII (`[x]` / `[ ]`) rather than the list's `◉` / `○`: this output is
 * redirected to files and pipes, where the terminal glyphs are noise.
 */

import type { CacheEntry, Category, CleanOutcome, Preset, Project } from './types.js';
import { formatBytes, formatIdle } from './ui/format.js';
import { buildRows, defaultSelection, enabledArtifacts, isSelected } from './ui/model.js';
import type { Row, Selection } from './ui/model.js';

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

function projectMeta(project: Project): string {
  const types = [...project.types].sort().join(', ');
  const { status, idleMs, reason } = project.activity;
  const age = status === 'dormant' ? `dormant ${formatIdle(idleMs)}` : 'active';
  return [types, age, reason].filter((part) => part.length > 0).join(' · ');
}

function itemLines(row: Row, selection: Selection, categories: ReadonlySet<Category>): string[] {
  if (row.kind === 'header') return [];

  const mark = isSelected(selection, row) ? '[x]' : '[ ]';
  const lines = [`  ${mark} ${column(row.label, row.bytes)}`];

  if (row.kind === 'project') {
    lines.push(`      ${projectMeta(row.project)}`);
    for (const artifact of enabledArtifacts(row.project, categories)) {
      lines.push(`      ${column(`${artifact.relPath}/`, artifact.bytes)}  ${artifact.category}`);
    }
  } else {
    lines.push(`      ${row.cache.note}`);
  }
  return lines;
}

/**
 * The whole scan as text: sections in the interface's order, each item marked with whether
 * it would be selected by default, each project broken down by artifact.
 */
export function renderReport(input: ReportInput): string {
  const { projects, caches, categories, preset, roots } = input;
  const rows = buildRows({ projects, caches, categories });
  const selection = defaultSelection(rows);

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
    lines.push(...itemLines(row, selection, categories));
  }

  const selected = rows.filter((row) => row.kind !== 'header' && isSelected(selection, row));
  const protectedRows = rows.filter((row) => row.kind === 'project' && row.section === 'active');
  const selectedBytes = selected.reduce((sum, row) => sum + row.bytes, 0);

  lines.push(
    '',
    `Selected by default: ${plural(selected.length, 'item')} · ${formatBytes(selectedBytes)}`,
  );
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
