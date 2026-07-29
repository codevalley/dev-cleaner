/**
 * The marks the tool draws itself with: the block face for a byte figure, and the wordmark.
 *
 * These were born inside `Round.tsx` and `Banner.tsx`, next to the components that use them,
 * and that is still where their tests live. They sit here for one reason: **plain stdout needs
 * them too.**
 *
 * The closing line in `cli.ts` — the last thing the tool says, printed after Ink has been torn
 * off the screen — draws the session's figure in the same face the round pane drew it in a
 * moment earlier. Reaching that face through `Round.js` would mean `cli.ts` statically importing
 * a module that imports React and Ink, and `dev-cleaner --help` and `dev-cleaner ~/develop |
 * less` would both start paying for a renderer they never use (see the note at the top of
 * `cli.ts`: everything heavy is reached by dynamic `import()` at the point of use).
 *
 * So the pure part moved down here, with no React import above it, and `Round.tsx` and
 * `Banner.tsx` re-export what they always exported. One face, three callers, no copies: the
 * confirmation, the round summary and the goodbye all render `107G` as the same shape, which is
 * what makes them read as one program rather than three.
 */

import { formatBytes } from './format.js';

/**
 * The compact wordmark.
 *
 * `▓▒░` is the disk gauge's own vocabulary — full, going, gone — so the mark says what the tool
 * does in three characters, and a terminal that cannot draw them still prints the name.
 */
export const WORDMARK = '▓▒░ dev-cleaner';

/** Rows in the block font. Five is the smallest height at which 6, 8 and 0 stay distinct. */
export const BIG_ROWS = 5;

/**
 * A block font covering exactly the characters `formatBytes` can emit: the ten digits, the
 * decimal point, and the six unit letters. Nothing else — a glyph table that silently accepts
 * an unknown character would render it as a hole in the middle of the only number on screen.
 * `bigTextLines` returns `undefined` instead, and the caller falls back to plain text.
 *
 * Only `█` and the space are used. Half-blocks and box-drawing corners render at different
 * widths in enough terminals that a banner built from them can come out ragged, and a ragged
 * 107 G is worse than a blocky one.
 *
 * Digits and unit letters cover `formatBytes`. Extra letters spell the splash wordmark
 * (`DEV-CLEANER`) in the same face so brand and reclaim figure share one typeface.
 */
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['███', '█ █', '█ █', '█ █', '███'],
  '1': [' █ ', '██ ', ' █ ', ' █ ', '███'],
  '2': ['███', '  █', '███', '█  ', '███'],
  '3': ['███', '  █', '███', '  █', '███'],
  '4': ['█ █', '█ █', '███', '  █', '  █'],
  '5': ['███', '█  ', '███', '  █', '███'],
  '6': ['███', '█  ', '███', '█ █', '███'],
  '7': ['███', '  █', '  █', '  █', '  █'],
  '8': ['███', '█ █', '███', '█ █', '███'],
  '9': ['███', '█ █', '███', '  █', '███'],
  // One column wide, so "3.4G" does not read as "3 4G" with a gap where the point should be.
  '.': [' ', ' ', ' ', ' ', '█'],
  B: ['██ ', '█ █', '██ ', '█ █', '██ '],
  K: ['█ █', '██ ', '█  ', '██ ', '█ █'],
  M: ['█ █', '███', '███', '█ █', '█ █'],
  G: ['███', '█  ', '█ █', '█ █', '███'],
  T: ['███', ' █ ', ' █ ', ' █ ', ' █ '],
  P: ['███', '█ █', '███', '█  ', '█  '],
  // Splash / Logo wordmark letters (DEV-CLEANER). Same solid face as reclaim figures.
  A: [' █ ', '█ █', '███', '█ █', '█ █'],
  C: ['███', '█  ', '█  ', '█  ', '███'],
  D: ['██ ', '█ █', '█ █', '█ █', '██ '],
  E: ['███', '█  ', '██ ', '█  ', '███'],
  L: ['█  ', '█  ', '█  ', '█  ', '███'],
  N: ['█ █', '███', '███', '█ █', '█ █'],
  R: ['██ ', '█ █', '██ ', '█ █', '█ █'],
  V: ['█ █', '█ █', '█ █', '█ █', ' █ '],
  '-': ['   ', '   ', '███', '   ', '   '],
};

/**
 * `text` in the block font, one string per row, or `undefined` if any character is not in the
 * table. Rows are right-trimmed: they are drawn into a column-oriented layout, and trailing
 * blanks would only make the measured width disagree with the drawn one.
 *
 * Exactly one blank column separates every glyph, including the decimal point. Setting the
 * point tight against its neighbours was tried and is worse: `67.0G` comes out with the 7's
 * stem and the point fused into a single bar on the bottom row, which is a misread of the
 * tenths rather than merely an ugly one.
 */
export function bigTextLines(text: string): readonly string[] | undefined {
  const characters = [...text];
  if (characters.length === 0) return undefined;

  const rows: string[] = [];
  for (let row = 0; row < BIG_ROWS; row += 1) {
    const cells: string[] = [];
    for (const character of characters) {
      const glyph = GLYPHS[character];
      if (glyph === undefined) return undefined;
      cells.push(glyph[row] ?? '');
    }
    rows.push(cells.join(' ').trimEnd());
  }
  return rows;
}

/**
 * The banner for a byte count, or `undefined` when it will not fit in `width` — at which
 * point the caller shows the same figure as ordinary text. A banner that wraps is not a
 * bigger number, it is a broken one, so the fit is checked against the *drawn* width
 * including the two-column indent every caller uses.
 */
export function bigBytes(bytes: number, width: number): readonly string[] | undefined {
  const lines = bigTextLines(formatBytes(bytes));
  if (lines === undefined) return undefined;

  const drawn = lines.reduce((widest, line) => Math.max(widest, line.length), 0);
  if (drawn === 0 || drawn + 2 > width) return undefined;
  return lines;
}
