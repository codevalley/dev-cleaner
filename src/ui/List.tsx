/**
 * The left pane: sections, rows, selection marks, sizes.
 *
 * Deliberately dumb. It receives rows and a selection and prints them; it decides nothing.
 * Each row is rendered as a single pre-padded string rather than as a row of `<Box>`es,
 * because Ink lays flex children out independently and a size column assembled from
 * separate boxes drifts by a column whenever a label's width changes — which, during a
 * progressive scan, is constantly.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { BYTES_WIDTH, CURSOR, MARK_OFF, MARK_ON, formatBytesPadded, padLabel } from './format.js';
import { isSelectable, isSelected, type Row, type Selection } from './model.js';

/** cursor glyph + mark glyph + one space. */
const MARKER_WIDTH = 3;

export interface ListProps {
  rows: readonly Row[];
  cursorId: string | undefined;
  selection: Selection;
  /** Inner width available to the list, borders and padding already subtracted. */
  width: number;
  /** How many rows fit. Longer lists scroll to keep the cursor in view. */
  height: number;
}

function labelWidth(width: number): number {
  return Math.max(8, width - MARKER_WIDTH - BYTES_WIDTH - 1);
}

/**
 * Scroll so the cursor stays visible, keeping it roughly centred. The window is computed
 * from the row list on every render rather than stored, so a re-sort moves the viewport
 * with the cursor instead of stranding it.
 */
export function windowRows(
  rows: readonly Row[],
  cursorId: string | undefined,
  height: number,
): Row[] {
  if (rows.length <= height) return [...rows];

  const cursorAt = rows.findIndex((row) => row.id === cursorId);
  const centred = cursorAt === -1 ? 0 : cursorAt - Math.floor(height / 2);
  const start = Math.min(Math.max(centred, 0), rows.length - height);
  return rows.slice(start, start + height);
}

function renderRow(row: Row, width: number, isCursor: boolean, selected: boolean): string {
  const bytes = formatBytesPadded(row.bytes);

  if (row.kind === 'header') {
    // A header has no marker, so its label reclaims that space.
    return `${padLabel(row.label, labelWidth(width) + MARKER_WIDTH)} ${bytes}`;
  }
  const cursor = isCursor ? CURSOR : ' ';
  const mark = selected ? MARK_ON : MARK_OFF;
  return `${cursor}${mark} ${padLabel(row.label, labelWidth(width))} ${bytes}`;
}

export function List({ rows, cursorId, selection, width, height }: ListProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>no projects yet…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {windowRows(rows, cursorId, height).map((row) => {
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
      })}
    </Box>
  );
}
