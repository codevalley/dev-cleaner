/**
 * The disk gauge, drawn — one line, whatever it is handed.
 *
 * Every number and every cell width comes from `diskbar.ts`; this file chooses colours and
 * arranges one line. That split is deliberate — the interesting part of a three-segment bar is
 * that its widths sum to exactly the width requested (round each segment independently and a
 * 24-cell bar renders as 23 or 25, which wraps the line and takes the frame with it), and that
 * property is proved in `diskbar.ts` rather than hoped for here.
 *
 * **Colour is never the only channel.** The three segments use three different glyphs
 * (`█ ▓ ░`), so the bar is readable in a terminal with no colour at all, over SSH into a dumb
 * TTY, and in a screenshot printed in greyscale. Colour is added on top as an accelerant,
 * never as the carrier.
 *
 * **The middle segment is the whole point.** It is what the current selection would free, so it
 * moves as the user checks and unchecks boxes — the answer to "show me what this does" that a
 * static column of sizes cannot give. `diskbar.ts` guarantees a non-zero selection always gets
 * at least one cell, because a gauge that does not move when you check a box reads as broken
 * rather than as precise.
 *
 * # Why this used to be three lines, and is now one
 *
 * It drew the bar, then a second line carrying either the legend or the projection-plus-caveat,
 * and above it sat the title line: three rows of chrome above a single table. The user's word
 * for the result was "crowding", and they were right — the frame spent six lines framing one
 * list and the number they had come for was the smallest thing on the screen.
 *
 * So the consequences of the *selection* — the projected free space, the caveat that explains
 * why it is a projection, the legend that explains the bar when nothing is chosen — moved next
 * to the headline figure in `Banner.tsx`, where they belong: they describe the choice, not the
 * volume. What is left here is the volume itself, which is one line's worth of fact.
 *
 * `TRASH_CAVEAT` still comes from `diskbar.ts` and still appears on screen; it is passed
 * through `App` to the headline rather than retyped, so a re-layout cannot drop the sentence
 * that keeps the projection honest.
 */

import { Box, Text } from 'ink';
import React from 'react';

import {
  SEGMENT_GLYPHS,
  SEGMENT_LABELS,
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
 * The legend, in one line. Shown beside the headline when nothing is selected — the moment the
 * bar is least self-explanatory, because only two of its three segments are visible.
 */
export const BAR_LEGEND = (['used', 'reclaim', 'free'] as const)
  .map((kind) => `${SEGMENT_GLYPHS[kind]} ${SEGMENT_LABELS[kind]}`)
  .join(' · ');

export interface GaugeProps {
  /** `undefined` when the volume could not be measured — then no bar is drawn at all. */
  usage: DiskUsage | undefined;
  /** Bytes the current selection would free. Drives the middle segment, live. */
  reclaiming: number;
  /** Columns available for the whole line. */
  width: number;
}

/**
 * Exactly one line, always, whatever it is given.
 *
 * The height is fixed because the block sits above a pane whose height is computed from the
 * terminal's — a gauge that grew a line when a selection appeared would push the footer off the
 * bottom of the screen, which is the defect this whole layout exists to fix. The bar is clamped
 * to the width available for the same reason: a 22-cell bar in an 18-column terminal is a wrap.
 */
export function Gauge({ usage, reclaiming, width }: GaugeProps): React.ReactElement {
  const room = Math.max(0, width);

  if (usage === undefined) {
    return (
      <Box>
        <Text dimColor>{truncateLabel('disk usage unavailable on this volume', room)}</Text>
      </Box>
    );
  }

  const cells = Math.min(BAR_WIDTH, room);
  const segments = barSegments(usage, reclaiming, cells);
  const labels = diskLabels(usage, reclaiming);
  const summary = `  ${labels.percent}  ${labels.used} · ${labels.free}`;

  return (
    <Box>
      <Text>
        {segments.map((segment) => (
          <Text key={segment.kind} color={SEGMENT_COLOURS[segment.kind]}>
            {SEGMENT_GLYPHS[segment.kind].repeat(segment.width)}
          </Text>
        ))}
        <Text dimColor>{truncateLabel(summary, Math.max(0, room - cells))}</Text>
      </Text>
    </Box>
  );
}
