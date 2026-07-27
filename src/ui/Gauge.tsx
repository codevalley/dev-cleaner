/**
 * The disk gauge, drawn.
 *
 * Every number and every cell width comes from `diskbar.ts`; this file chooses colours and
 * arranges three lines. That split is deliberate — the interesting part of a three-segment
 * bar is that its widths sum to exactly the width requested (round each segment
 * independently and a 24-cell bar renders as 23 or 25, which wraps the line and takes the
 * frame with it), and that property is proved in `diskbar.ts` rather than hoped for here.
 *
 * **Colour is never the only channel.** The three segments use three different glyphs
 * (`█ ▓ ░`), so the bar is readable in a terminal with no colour at all, over SSH into a
 * dumb TTY, and in a screenshot printed in greyscale. The legend spells the glyphs out for
 * the same reason. Colour is added on top as an accelerant, never as the carrier.
 *
 * **The middle segment is the whole point.** It is what the current selection would free, so
 * it moves as the user checks and unchecks boxes — the answer to "show me what this does"
 * that a static column of sizes cannot give. `diskbar.ts` guarantees a non-zero selection
 * always gets at least one cell, because a gauge that does not move when you check a box
 * reads as broken rather than as precise.
 *
 * **And it is a projection, not a reading.** dev-cleaner trashes; it does not delete. Free
 * space does not move until the Trash is emptied, so the third line says so — `TRASH_CAVEAT`
 * is imported rather than retyped so a re-layout cannot drop the sentence that keeps the
 * gauge honest.
 */

import { Box, Text } from 'ink';
import React from 'react';

import {
  SEGMENT_GLYPHS,
  SEGMENT_LABELS,
  TRASH_CAVEAT,
  barSegments,
  diskLabels,
  type BarKind,
  type DiskUsage,
} from './diskbar.js';
import { truncateLabel } from './format.js';

/** Wide enough that one cell is a small fraction; narrow enough to leave room for numbers. */
const BAR_WIDTH = 22;

const SEGMENT_COLOURS: Record<BarKind, string> = {
  used: 'blue',
  reclaim: 'yellow',
  free: 'green',
};

/**
 * The legend, in one line. Shown when nothing is selected — the moment the bar is least
 * self-explanatory, because only two of its three segments are visible.
 */
export const BAR_LEGEND = (['used', 'reclaim', 'free'] as const)
  .map((kind) => `${SEGMENT_GLYPHS[kind]} ${SEGMENT_LABELS[kind]}`)
  .join(' · ');

export interface GaugeProps {
  /** `undefined` when the volume could not be measured — then no bar is drawn at all. */
  usage: DiskUsage | undefined;
  /** Bytes the current selection would free. Drives the middle segment, live. */
  reclaiming: number;
  /** Columns available for the whole block. */
  width: number;
}

/**
 * Exactly two lines, always, whatever it is given.
 *
 * The height is fixed because the block sits above a pane whose height is computed from the
 * terminal's — a gauge that grew a line when a selection appeared would push the footer off
 * the bottom of the screen, which is the defect this whole layout exists to fix.
 */
export function Gauge({ usage, reclaiming, width }: GaugeProps): React.ReactElement {
  if (usage === undefined) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{truncateLabel('disk usage unavailable on this volume', width)}</Text>
        <Text dimColor>{truncateLabel(TRASH_CAVEAT, width)}</Text>
      </Box>
    );
  }

  const segments = barSegments(usage, reclaiming, BAR_WIDTH);
  const labels = diskLabels(usage, reclaiming);
  const summary = ` ${labels.percent}  ${labels.used} · ${labels.free}`;

  // The projection when there is one, the legend when there is not: the "after" figure is
  // meaningful only as the consequence of a choice, and `diskLabels` returns `undefined`
  // rather than repeating the current free space next to it.
  const second =
    labels.projected === undefined
      ? BAR_LEGEND
      : `${labels.projected} · ${TRASH_CAVEAT}`;

  return (
    <Box flexDirection="column">
      <Text>
        {segments.map((segment) => (
          <Text key={segment.kind} color={SEGMENT_COLOURS[segment.kind]}>
            {SEGMENT_GLYPHS[segment.kind].repeat(segment.width)}
          </Text>
        ))}
        <Text>{truncateLabel(summary, Math.max(0, width - BAR_WIDTH))}</Text>
      </Text>
      <Text dimColor={labels.projected === undefined} color={labels.projected === undefined ? undefined : 'yellow'}>
        {truncateLabel(second, width)}
      </Text>
    </Box>
  );
}
