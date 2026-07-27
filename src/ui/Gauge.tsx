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
 * never as the carrier. `ui.gauge.test.tsx` renders the bar, strips every escape sequence and
 * reads it back, so that claim is checked rather than asserted in a comment.
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
  SEGMENT_ORDER,
  barSegments,
  diskLabels,
  type BarKind,
  type DiskUsage,
} from './diskbar.js';
import { truncateLabel } from './format.js';

/** Wide enough that one cell is a small fraction; narrow enough to leave room for numbers. */
const BAR_WIDTH = 22;

/**
 * The three segment colours, and why they are these three and not the obvious ones.
 *
 * This was `blue` / `yellow` / `green` and a user on a dark terminal called the result "not
 * clearly contrasting". They were right twice over, and both faults are worth writing down so
 * that the next person to open this file on taste does not reintroduce them.
 *
 * **1. Plain `blue` is the darkest thing in the 16-colour set.** On the classic palette it is
 * `#0000AA`, roughly 1.6:1 against a black background — below any legibility floor there is.
 * So the *largest* segment of the bar, the one that says how full the disk is, dissolved into
 * the terminal background. Every other near-black name fails the same way: `black`,
 * `blackBright`, `gray`. Symmetrically, `white`, `whiteBright`, `yellowBright`, `greenBright`
 * and `cyanBright` are all around 1.1–1.3:1 against a *light* background and vanish there. We
 * cannot detect which background we are on, so the palette is restricted to hues that sit in
 * the middle of the lightness range and survive both: nothing near black, nothing near white.
 *
 * **2. Adjacent segments have to contrast with each other, not merely with the paper.** The
 * old middle and right segments were `yellow` and `green` — 60° apart on the hue wheel and
 * near-equal in luminance, so the edge that answers "how much would this selection free" was
 * the muddiest edge in the bar. The three pairs are not equally in need of help, because the
 * glyphs differ in ink coverage and that difference does some of the work:
 *
 * | boundary        | glyph step  | who carries it            |
 * | --------------- | ----------- | ------------------------- |
 * | used ↔ reclaim  | █→▓, ~25%   | mostly colour — weakest texture cue, so it gets 120° |
 * | reclaim ↔ free  | ▓→░, ~50%   | colour and texture together, and gets the full 180°  |
 * | used ↔ free     | █→░, ~75%   | mostly texture — solid against sparse stipple        |
 *
 * `used ↔ free` is the only pair that is close in hue (cyan and green are 60° apart), and it
 * is deliberately the one placed on the largest texture step. It is also the only pair that is
 * ever adjacent while the other is absent: with nothing selected the middle segment is
 * zero-width and these two touch, which is exactly when `BAR_LEGEND` is on screen.
 *
 * **3. The middle segment is the answer, so it is the loudest.** `magentaBright` is the
 * highest-chroma name that is neither near-black nor near-white; bright rather than plain
 * because `▓` gives a quarter of its cells back to the background, so the colour underneath
 * has to start louder than the neighbours it is competing with. It is also the one hue the
 * rest of dev-cleaner never spends — `red` is failure, `yellow` is warning, `green` is
 * success, `cyan` is chrome — so a big block of it in the gauge cannot be misread as a status.
 * That is the second reason the middle segment is not yellow any more: yellow is the colour of
 * the warning banner on the confirmation screen, two rows away.
 *
 * `cyan` for what is in use and `green` for what is free keep the two conventional readings
 * (cool and structural for context, green for headroom) while both staying mid-lightness.
 *
 * Names, not hex. A hex colour would be our idea of the right blue imposed on a terminal whose
 * owner has already chosen theirs, and chalk would downsample it to one of these sixteen
 * anyway on a 16-colour TTY. Named colours ride the user's theme, which is the only mechanism
 * that actually adapts to a background we cannot see.
 */
export const SEGMENT_COLOURS: Record<BarKind, string> = {
  used: 'cyan',
  reclaim: 'magentaBright',
  free: 'green',
};

/**
 * The legend, in one line. Shown beside the headline when nothing is selected — the moment the
 * bar is least self-explanatory, because only two of its three segments are visible.
 *
 * Built from `SEGMENT_ORDER`, the same list `barSegments` draws from, so the legend reads left
 * to right in the order the segments actually appear. It keys on the glyph rather than on a
 * colour swatch on purpose: `App` renders this as a plain string in a dim row, and a legend
 * that could only be matched to the bar by hue would be useless to precisely the readers the
 * glyph ramp exists for.
 */
export const BAR_LEGEND = SEGMENT_ORDER.map(
  (kind) => `${SEGMENT_GLYPHS[kind]} ${SEGMENT_LABELS[kind]}`,
).join(' · ');

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
