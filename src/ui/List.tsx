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
 */

import { Box, Text } from 'ink';
import React from 'react';

import { BYTES_WIDTH, CURSOR, MARK_OFF, MARK_ON, formatBytesPadded, padLabel } from './format.js';
import { isSelectable, isSelected, type Row, type Selection } from './model.js';
import { scrollHint, visibleSlice, type Viewport } from './viewport.js';

/** cursor glyph + mark glyph + one space. */
const MARKER_WIDTH = 3;

export interface ListProps {
  rows: readonly Row[];
  cursorId: string | undefined;
  selection: Selection;
  /** Inner width available to the list, borders and padding already subtracted. */
  width: number;
  /** The window to draw, from `windowFor`. The pane renders this slice and nothing else. */
  view: Viewport;
}

function labelWidth(width: number): number {
  return Math.max(8, width - MARKER_WIDTH - BYTES_WIDTH - 1);
}

/**
 * A section header carries its own count as well as its total, because "IN USE RECENTLY" with
 * a size beside it does not say how much of the list it accounts for — and a user deciding
 * whether a section is worth reading is asking exactly that.
 */
function headerText(label: string, count: number, width: number): string {
  const suffix = ` ${count}`;
  return padLabel(`${label}${suffix}`, labelWidth(width) + MARKER_WIDTH);
}

function renderRow(row: Row, width: number, isCursor: boolean, selected: boolean): string {
  const bytes = formatBytesPadded(row.bytes);

  if (row.kind === 'header') {
    // A header has no marker, so its label reclaims that space.
    return `${headerText(row.label, row.count, width)} ${bytes}`;
  }
  const cursor = isCursor ? CURSOR : ' ';
  const mark = selected ? MARK_ON : MARK_OFF;
  return `${cursor}${mark} ${padLabel(row.label, labelWidth(width))} ${bytes}`;
}

export function List({ rows, cursorId, selection, width, view }: ListProps): React.ReactElement {
  const hint = scrollHint(view, rows.length);

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
              {renderRow(row, width, isCursor, selected)}
            </Text>
          );
        })
      )}
      {/* Always drawn; blank when the whole list fits. See the module note. */}
      <Text dimColor>{hint ?? ' '}</Text>
    </Box>
  );
}
