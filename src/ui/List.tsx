/**
 * The left pane: sections, rows, selection marks, sizes — and never more lines than it was
 * given.
 *
 * # The bug this file used to have
 *
 * It rendered every row it was handed. On a list longer than the terminal that does not
 * scroll the *list*; it scrolls the **terminal**. Ink prints a frame taller than the window,
 * the emulator pushes the top off the screen, and the footer — the only place the keybindings
 * are written down — leaves with it. The user is then looking at a list they cannot operate,
 * with no indication that a command bar ever existed. It is not recoverable by scrolling
 * back, either: the next repaint prints another over-tall frame.
 *
 * So the pane draws at most `view.end - view.start` rows and moves that window itself. The
 * window arithmetic — which rows, how many are hidden, where the cursor is clamped — lives in
 * `viewport.ts` and is computed by `App`, which owns the previous window and therefore the
 * stability property (the window does not move while the cursor moves inside it). This file
 * slices and prints.
 *
 * # Why the hint line is always there
 *
 * `scrollHint` returns `undefined` when the whole list is visible, and the obvious rendering
 * of that is to omit the line. Omitting it changes the pane's height by one the moment a row
 * arrives — which is the same class of defect as above, one line at a time, on a terminal
 * that was exactly full. The line is always drawn; it is blank when there is nothing to say.
 *
 * # Why a row is one string
 *
 * Ink lays flex children out independently, so a size column assembled from separate boxes
 * drifts by a column whenever a label's width changes — which, during a progressive scan, is
 * constantly. Each row is pre-padded into a single `<Text>`.
 *
 * # The chip column, and why it is planned for the whole pane rather than per row
 *
 * A row can carry up to five chips from `labels.ts` (`uncommitted · edited 8d · worktree ·
 * slow · needs network` is 64 columns) and this pane is at most 52 wide. So chips have to be
 * given up, and the only question is *how*.
 *
 * Truncating is not available: the row must stay exactly one line — `viewport.ts` counts rows
 * as lines and the footer is pinned on that count — and half a word is worse than no word.
 * Nor can the choice be made per row. If a long row drops `worktree` while a short one keeps
 * it, then a user scanning the column for worktrees reads the short row's silence as "not a
 * worktree", which is *false*, and they read it confidently because the chip demonstrably
 * appears elsewhere on screen. A chip that is sometimes-absent-for-layout-reasons is worse
 * than a chip that is never drawn.
 *
 * So the pane picks one set of kinds for every row it draws (`chipPlan`), by giving up the
 * least decisive kind until the widest row fits. Every row that has a kept kind shows it, and
 * a kind that was given up is shown by nobody — so an empty spot always means "this row does
 * not have that", never "there was no room". The kept set is computed over *all* rows rather
 * than the visible slice, so scrolling never reflows the column under the eye.
 *
 * The detail pane draws every chip for the highlighted row, whatever this one had room for.
 */

import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

import { BYTES_WIDTH, CURSOR, MARK_OFF, MARK_ON, formatBytes, formatBytesPadded, padLabel, truncateLabel } from './format.js';
import { joinLabels, labelsFor, LABEL_SEPARATOR, type Label, type LabelKind } from './labels.js';
import { enabledArtifacts, isSelectable, isSelected, type Row, type Selection } from './model.js';
import { scrollHint, visibleSlice, type Viewport } from './viewport.js';
import type { Category, Project } from '../types.js';

/** cursor glyph + mark glyph + one space. */
const MARKER_WIDTH = 3;

/**
 * Columns the project name keeps for itself before a single chip is drawn.
 *
 * The name is what the row *is*; the chips qualify it. Sixteen columns holds most repository
 * names outright and enough of the rest to recognise, and a pane too narrow to afford both
 * simply spends everything here — the row still says which project and how much, which is the
 * question the tool exists to answer.
 */
const MIN_LABEL_WIDTH = 16;

/** One space between the name and the chips, so a padded name cannot touch a chip. */
const CHIP_GAP = 1;

/**
 * The order chips are given up in as the pane narrows: least decisive first.
 *
 * Read it as a ranking of *what else already says this*, because a chip whose fact is
 * recoverable from elsewhere on the screen is the cheapest one to lose.
 *
 * - `offline` goes first, and its loss costs nothing at all: `network` is still standing, so
 *   a row with no connectivity chip is a row that rebuilds offline. The pair was written to
 *   be readable as a position; one of them can carry that alone.
 * - `recency` next. The row is already under a section header that says `IN USE RECENTLY` or
 *   not, and the detail pane spells out the date in full.
 * - `network`, then `slow` — both are cost, neither is stated anywhere else in the list, and
 *   `slow` outlives `network` only because it is four columns against thirteen.
 * - `worktree` and `uncommitted` last, because nothing else in this pane hints at either, and
 *   `uncommitted` outlives everything: it is the one chip that suggests doing something
 *   *before* cleaning rather than describing what cleaning will cost.
 */
export const CHIP_SACRIFICE_ORDER: readonly LabelKind[] = [
  'offline',
  'recency',
  'network',
  'slow',
  'worktree',
  'uncommitted',
];

/** Which chips this pane draws, and the column it reserves for them. */
export interface ChipPlan {
  /** Every row that has one of these draws it. A kind outside the set is drawn by nobody. */
  kinds: ReadonlySet<LabelKind>;
  /** Reserved columns, `0` when no chip is drawn at all. */
  width: number;
}

const NO_CHIPS: ChipPlan = { kinds: new Set(), width: 0 };

/** The interior of a row: everything between the marker and the size column. */
function interiorWidth(width: number): number {
  return Math.max(8, width - MARKER_WIDTH - BYTES_WIDTH - 1);
}

/**
 * The chips this pane is willing to draw for a project.
 *
 * Everything `labelsFor` gives, minus the connectivity pair when no preset was passed.
 * `labelsFor` answers that question anyway when it is not told which categories are enabled —
 * deliberately, in the over-warning direction, because a report read on its own is better too
 * cautious than too reassuring. A pane is not a report. The detail pane is one column to the
 * right, it *is* given the preset, and it would be saying `rebuilds offline` on the same frame
 * as this row said `needs network`. Two panes of one frame contradicting each other is the
 * only outcome worse than silence, and a user who catches it stops believing either.
 */
function chipsOf(
  project: Project,
  categories: ReadonlySet<Category> | undefined,
): Label[] {
  const labels = labelsFor(project, categories);
  return categories === undefined
    ? labels.filter((label) => label.kind !== 'network' && label.kind !== 'offline')
    : labels;
}

/**
 * The most a chip string may occupy. Negative or zero at a genuinely narrow pane, which is the
 * signal to draw none — the detail pane carries them there instead.
 */
export function chipBudget(width: number): number {
  return interiorWidth(width) - MIN_LABEL_WIDTH - CHIP_GAP;
}

/**
 * The chip set the whole pane will draw, and the column it needs.
 *
 * Greedy from the full set downwards rather than empty upwards, because "what can I still
 * afford" is the question — a pane that fits everything must not have to discover that one
 * kind at a time, and the answer has to be reachable in a fixed number of steps regardless of
 * how many rows there are.
 */
export function chipPlan(
  rows: readonly Row[],
  categories: ReadonlySet<Category> | undefined,
  budget: number,
): ChipPlan {
  if (budget <= 0) return NO_CHIPS;

  const perRow = rows.flatMap((row) => (row.kind === 'project' ? [chipsOf(row.project, categories)] : []));
  if (perRow.length === 0) return NO_CHIPS;

  const kept = new Set<LabelKind>();
  for (const labels of perRow) for (const label of labels) kept.add(label.kind);

  // The widest row decides, not the average: the column is shared, so a single row that
  // overflows it would overflow the pane.
  const widest = (): number =>
    perRow.reduce(
      (most, labels) =>
        Math.max(most, joinLabels(labels.filter((label) => kept.has(label.kind))).length),
      0,
    );

  let width = widest();
  for (const victim of CHIP_SACRIFICE_ORDER) {
    if (width <= budget) break;
    kept.delete(victim);
    width = widest();
  }

  // Only reachable if a kind escaped `CHIP_SACRIFICE_ORDER` — a new label kind added without
  // being ranked. Drawing nothing is the safe reading of that, not drawing it anyway.
  if (width > budget) return NO_CHIPS;
  return { kinds: kept, width };
}

/**
 * One row's chips under the plan, or `''`.
 *
 * The final length check is the layout guarantee rather than a formality: everything that
 * reaches a `<Text>` here has to fit the column it was given, and a string that does not is
 * dropped whole. Half a chip would either wrap the row to two lines or truncate mid-word, and
 * both are worse than the chip's absence.
 */
export function chipsFor(
  row: Row,
  categories: ReadonlySet<Category> | undefined,
  plan: ChipPlan,
): string {
  if (plan.width === 0 || row.kind !== 'project') return '';
  const text = joinLabels(chipsOf(row.project, categories).filter((label) => plan.kinds.has(label.kind)));
  return text.length <= plan.width ? text : '';
}

/**
 * A section header carries its own count as well as its total, because "IN USE RECENTLY" with
 * a size beside it does not say how much of the list it accounts for — and a user deciding
 * whether a section is worth reading is asking exactly that.
 */
function headerText(label: string, count: number, width: number): string {
  const suffix = ` ${count}`;
  return padLabel(`${label}${suffix}`, interiorWidth(width) + MARKER_WIDTH);
}

/**
 * A row as the single string it is printed as.
 *
 * The arithmetic is the point: marker + name + gap + chips + gap + size sums to exactly
 * `width` whatever the chip column costs, because the chip column is taken *out of* the name
 * rather than added beside it. A header spans the name and chip columns together — it has no
 * chips of its own and its label is the widest thing in the pane.
 */
export function renderRow(
  row: Row,
  width: number,
  chips: string,
  chipWidth: number,
  isCursor: boolean,
  selected: boolean,
): string {
  const bytes = formatBytesPadded(row.bytes);

  if (row.kind === 'header') {
    // A header has no marker, so its label reclaims that space.
    return `${headerText(row.label, row.count, width)} ${bytes}`;
  }
  const column = chipWidth > 0 ? chipWidth + CHIP_GAP : 0;
  const labelWidth = Math.max(1, interiorWidth(width) - column);
  const cursor = isCursor ? CURSOR : ' ';
  const mark = selected ? MARK_ON : MARK_OFF;
  const tail = column > 0 ? `${' '.repeat(CHIP_GAP)}${chips.padStart(chipWidth)}` : '';
  return `${cursor}${mark} ${padLabel(row.label, labelWidth)}${tail} ${bytes}`;
}

/**
 * The focused-row summary under the triage list: name, every chip, and the largest enabled
 * artifact. Full width at triage — unlike `chipPlan`, nothing is sacrificed for column room.
 * Empty when no row is focused; App still draws one blank line for height stability.
 */
export function statusLine(
  row: Row | undefined,
  categories: ReadonlySet<Category>,
  width: number,
): string {
  if (row === undefined) return '';

  const parts = [`${CURSOR} ${row.label}`];

  if (row.kind === 'project') {
    const chips = joinLabels(labelsFor(row.project, categories));
    if (chips.length > 0) parts.push(chips);

    const artifacts = enabledArtifacts(row.project, categories);
    if (artifacts.length > 0) {
      const primary = artifacts.reduce((best, artifact) =>
        artifact.bytes > best.bytes ||
        (artifact.bytes === best.bytes && artifact.relPath.localeCompare(best.relPath) < 0)
          ? artifact
          : best,
      );
      parts.push(`${primary.relPath} ${formatBytes(primary.bytes)}`);
    }
  } else if (row.kind === 'cache') {
    parts.push('global cache', `${row.cache.path} ${formatBytes(row.cache.bytes)}`);
  } else {
    parts.push(String(row.count), formatBytes(row.bytes));
  }

  return truncateLabel(parts.join(LABEL_SEPARATOR), width);
}

export interface ListProps {
  rows: readonly Row[];
  cursorId: string | undefined;
  selection: Selection;
  /** Inner width available to the list, borders and padding already subtracted. */
  width: number;
  /** The window to draw, from `windowFor`. The pane renders this slice and nothing else. */
  view: Viewport;
  /**
   * The preset's categories, so `needs network` is not claimed for a `node_modules` the
   * current preset will not touch. Omitting it considers every artifact found, which
   * over-warns rather than under-warns — see `labelsFor`.
   */
  categories?: ReadonlySet<Category> | undefined;
}

export function List({
  rows,
  cursorId,
  selection,
  width,
  view,
  categories,
}: ListProps): React.ReactElement {
  const hint = scrollHint(view, rows.length);
  const budget = chipBudget(width);
  // Over every row, not the visible slice, so the column does not reflow as the user scrolls.
  const plan = useMemo(() => chipPlan(rows, categories, budget), [rows, categories, budget]);

  return (
    <Box flexDirection="column">
      {rows.length === 0 ? (
        <Text dimColor>no projects yet…</Text>
      ) : (
        visibleSlice(rows, view).map((row) => {
          const selected = isSelected(selection, row);
          const isCursor = isSelectable(row) && row.id === cursorId;
          return (
            <Text
              key={row.id}
              bold={row.kind === 'header' || isCursor}
              color={row.kind === 'header' ? 'cyan' : isCursor ? 'cyan' : undefined}
              dimColor={row.kind !== 'header' && !selected && !isCursor}
            >
              {renderRow(row, width, chipsFor(row, categories, plan), plan.width, isCursor, selected)}
            </Text>
          );
        })
      )}
      {/* Always drawn; blank when the whole list fits. See the module note.
          Truncated like every other line in this pane: the hint reads
          `↑ N more above · ↓ M more below` at up to ~34 columns, so on a narrow terminal it
          wrapped, the pane grew a line, and the footer was pushed off screen — the exact
          failure this module's header says the fixed budget exists to prevent. */}
      <Text dimColor wrap="truncate-end">{hint ?? ' '}</Text>
    </Box>
  );
}
