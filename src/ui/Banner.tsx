/**
 * The brand, and the number the user came for, in one typeface.
 *
 * # Why this file exists
 *
 * Two complaints, one answer. "The amount that will be 'freed' is not very prominent" — it was
 * six dim characters at the end of a status line, the smallest thing on a screen the user had
 * opened *specifically to find out that number*. And "no branding (ascii style titling or
 * something maybe?)" — the tool introduced itself in eleven lowercase letters.
 *
 * Both are solved by the same thing: a block face drawn out of half-block glyphs, used for the
 * headline figure in the workspace and for the wordmark on the one screen that has room for it.
 * Sharing a face is the point — the logo and the number are visibly the same object, which is
 * what makes a wordmark branding rather than decoration.
 *
 * # The face
 *
 * Each glyph is a 3-column by 4-half-row bitmap, printed as two character rows by pairing the
 * half-rows: a cell whose upper and lower halves are both set is `█`, upper only is `▀`, lower
 * only is `▄`. Four half-rows is the smallest grid in which every digit stays distinct — `0`
 * and `8` differ by which loop is solid, `6` and `G` by the tail — and two character rows is
 * the most vertical space the layout can afford (see the budget in `App.tsx`; every row spent
 * here is a project the list cannot show).
 *
 * The glyphs are *drawn*, not measured from a font, so `bigText` returns two strings of exactly
 * equal length and the caller can lay out beside them arithmetically. That matters more than it
 * sounds: this block sits inside a fixed-height, fixed-width frame, and a second row one column
 * wider than the first is a wrap, and a wrap is a line, and a line is the footer off the screen.
 *
 * # Colour is never the carrier
 *
 * The figure is drawn in glyphs and reads at full size in a terminal with no colour at all, in
 * a screenshot, and over SSH into a dumb TTY. Colour is added on top — green when there is
 * something to free, dim when there is not — and says nothing the shape does not already say.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { formatBytes, truncateLabel } from './format.js';
import { BIG_ROWS, WORDMARK, bigTextLines } from './glyphs.js';

/**
 * The compact wordmark, for the workspace.
 *
 * `▓▒░` is the disk gauge's own vocabulary — full, going, gone — so the mark says what the tool
 * does in three characters, and a terminal that cannot draw them still prints the name. A tall
 * ASCII banner here would cost three rows of the list on every frame of a session; the tall
 * version lives on `Logo`, which is only ever drawn on a screen with nothing to compete with.
 *
 * The constant itself sits in `glyphs.ts`, with the block font, so that the closing line
 * `cli.ts` prints after Ink has unmounted can sign itself with the same mark without importing
 * React. Re-exported here because this is the module its callers know it by.
 */
export { WORDMARK } from './glyphs.js';

/** What `Logo` spells. Uppercase because the face has no lowercase. */
export const LOGO_TEXT = 'DEV-CLEANER';

/**
 * The bitmaps. Three columns, four half-rows, `#` set and anything else clear.
 *
 * Only the characters `formatBytes` can emit (digits, `.`, and the unit letters `B K M G T P`)
 * plus the letters of `LOGO_TEXT`. An unknown character is skipped rather than substituted: a
 * `?` in a size figure would be read as a digit.
 */
const PIXELS: Record<string, readonly [string, string, string, string]> = {
  '0': ['###', '# #', '# #', '###'],
  '1': [' # ', ' # ', ' # ', '###'],
  '2': ['###', '  #', '## ', '###'],
  '3': ['###', ' ##', '  #', '###'],
  '4': ['# #', '# #', '###', '  #'],
  '5': ['###', '#  ', ' ##', '###'],
  '6': ['###', '#  ', '# #', '###'],
  '7': ['###', '  #', '  #', '  #'],
  // Solid lower loop, against `0`'s hollow one: at four half-rows there is no room for a waist,
  // so the two are told apart by weight instead. Every other pairing is already distinct.
  '8': ['###', '###', '# #', '###'],
  '9': ['###', '# #', '  #', '###'],
  '.': ['   ', '   ', '   ', ' # '],
  B: ['## ', '# #', '###', '## '],
  K: ['# #', '## ', '## ', '# #'],
  M: ['# #', '###', '# #', '# #'],
  G: ['###', '#  ', '# #', ' ##'],
  T: ['###', ' # ', ' # ', ' # '],
  P: ['###', '# #', '###', '#  '],
  A: [' # ', '# #', '###', '# #'],
  C: ['###', '#  ', '#  ', '###'],
  D: ['## ', '# #', '# #', '## '],
  E: ['###', '#  ', '## ', '###'],
  L: ['#  ', '#  ', '#  ', '###'],
  N: ['# #', '## ', '# #', '# #'],
  R: ['## ', '# #', '## ', '# #'],
  V: ['# #', '# #', '# #', ' # '],
  '-': ['   ', '###', '   ', '   '],
};

/** A decimal point does not need three columns, and three columns would read as a space. */
const NARROW = new Set(['.']);

function half(top: string, bottom: string): string {
  if (top === '#') return bottom === '#' ? '█' : '▀';
  return bottom === '#' ? '▄' : ' ';
}

/**
 * `text` in the block face, as its two character rows.
 *
 * The two strings are always the same length — that is the layout contract, and it is why the
 * glyphs are padded here rather than trimmed. Characters with no bitmap are dropped.
 */
export function bigText(text: string): [string, string] {
  let top = '';
  let bottom = '';

  for (const character of text.toUpperCase()) {
    const grid = PIXELS[character];
    if (grid === undefined) continue;
    if (top.length > 0) {
      top += ' ';
      bottom += ' ';
    }
    const columns = NARROW.has(character) ? [1] : [0, 1, 2];
    for (const column of columns) {
      top += half(grid[0][column] ?? ' ', grid[1][column] ?? ' ');
      bottom += half(grid[2][column] ?? ' ', grid[3][column] ?? ' ');
    }
  }

  return [top, bottom];
}

/** Columns `bigText` needs for `text`, without rendering it. */
export function bigTextWidth(text: string): number {
  return bigText(text)[0].length;
}

/**
 * Splash entry title: solid five-row face when height and width allow (canvas brand), then
 * half-block, then stacked words, then compact wordmark.
 */
export function splashTitle(
  width: number,
  titleBudget: number = Number.POSITIVE_INFINITY,
): { lines: string[]; degraded: boolean } {
  const fits = (lines: readonly string[]): boolean =>
    lines.every((line) => line.length === 0 || line.length <= width);

  if (titleBudget >= BIG_ROWS) {
    const solid = bigTextLines(LOGO_TEXT);
    if (solid !== undefined && fits(solid)) {
      return { lines: [...solid], degraded: false };
    }
  }
  if (titleBudget >= BIG_ROWS * 2 + 1) {
    const dev = bigTextLines('DEV');
    const cleaner = bigTextLines('CLEANER');
    if (dev !== undefined && cleaner !== undefined && fits(dev) && fits(cleaner)) {
      return { lines: [...dev, '', ...cleaner], degraded: false };
    }
  }

  const [top, bottom] = bigText(LOGO_TEXT);
  if (top.length <= width && titleBudget >= 2) {
    return { lines: [top, bottom], degraded: false };
  }
  const [d0, d1] = bigText('DEV');
  const [c0, c1] = bigText('CLEANER');
  if (Math.max(d0.length, c0.length) <= width && titleBudget >= 5) {
    return { lines: [d0, d1, '', c0, c1], degraded: false };
  }
  return { lines: [truncateLabel(WORDMARK, Math.max(0, width))], degraded: true };
}

export interface HeadlineProps {
  /** Bytes the current selection would free. Redrawn on every keystroke that changes it. */
  bytes: number;
  /** Beside the figure: what is selected, and what it projects the volume to. */
  caption: string;
  /** Under that: the standing note — the bar's legend, or the Trash caveat. */
  note: string;
  /** Columns available for the whole block. */
  width: number;
}

/**
 * The headline figure: what checking these boxes would free.
 *
 * **Exactly two lines, always.** The block sits above a pane whose height is the terminal's
 * minus a fixed chrome budget, so a headline that grew when a unit changed from `M` to `G`
 * would push the frame past the terminal and un-pin the footer.
 *
 * Uses plain bold digits rather than the half-block face — those packed glyphs are hard to
 * read as a number from a glance. Home uses the solid five-row face where height allows.
 *
 * **Zero is drawn, not hidden.** A selection of nothing shows a dim `0B` rather than an empty
 * space, because the figure's whole job is to move as the user checks boxes.
 */
export function Headline({ bytes, caption, note, width }: HeadlineProps): React.ReactElement {
  const label = formatBytes(bytes);
  const muted = bytes <= 0;
  // Leave room for the figure to grow (e.g. `999G` → `1.0T`) without shifting the caption.
  const figureCol = Math.max(label.length, 6);
  const captionWidth = Math.max(0, width - figureCol - 3);

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={muted ? undefined : 'green'} dimColor={muted}>
          {label.padEnd(figureCol, ' ')}
        </Text>
        <Text>{'   '}</Text>
        <Text bold>{truncateLabel(caption, captionWidth)}</Text>
      </Text>
      <Text>
        <Text>{' '.repeat(figureCol)}</Text>
        <Text>{'   '}</Text>
        <Text dimColor>{truncateLabel(note, captionWidth)}</Text>
      </Text>
    </Box>
  );
}

export interface LogoProps {
  /** Columns available. Below the wordmark's own width the compact mark is drawn instead. */
  width: number;
}

/**
 * The tall wordmark, for a screen that is not competing for space.
 *
 * Two lines, and it is only ever drawn while the app is *doing* something — the clean, which is
 * the one moment the interface has the screen to itself and the user has nothing to do but
 * watch. Putting it in the workspace would spend two rows of the list on every frame of every
 * session to say something the user already knows.
 *
 * Degrades rather than wraps: a terminal too narrow for the block face gets `WORDMARK`, which
 * is one line of ordinary text and fits anything down to about sixteen columns.
 */
export function Logo({ width }: LogoProps): React.ReactElement {
  const [top, bottom] = bigText(LOGO_TEXT);

  if (top.length > width) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {truncateLabel(WORDMARK, Math.max(0, width))}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {top}
      </Text>
      <Text bold color="cyan">
        {bottom}
      </Text>
    </Box>
  );
}
