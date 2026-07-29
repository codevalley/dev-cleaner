/**
 * The block face, on its own.
 *
 * `Banner.tsx` exists because the number the user opened the tool to find — how much this
 * selection frees — was the smallest, dimmest thing on the screen. Drawing it four times the
 * size of everything else is the fix, and drawing it costs the layout something: two rows of a
 * frame whose height is a fixed budget. So the face has exactly two properties that the rest of
 * the interface leans on, and both are asserted here rather than through a rendered app:
 *
 * 1. **Two rows, of equal width, always.** `App` lays the caption out beside the figure by
 *    arithmetic (`top.length + 3`). A second row one column wider than the first is a line that
 *    does not fit its box, and a line that does not fit is a wrap, and a wrap is the footer off
 *    the bottom of the terminal — the defect the whole fixed-height budget exists to prevent.
 *
 * 2. **Every character that can appear in a size is distinct from every other.** Four half-rows
 *    is a cramped grid; `0` and `8` have no room for a waist between them and are told apart by
 *    which loop is solid instead. A face in which two digits render identically is a face that
 *    can report 108G as 100G, in the largest type on the screen, and be believed.
 */

import { describe, expect, it } from 'vitest';

import { LOGO_TEXT, WORDMARK, bigText, bigTextWidth, splashTitle } from '../src/ui/Banner.js';
import { formatBytes, truncateLabel } from '../src/ui/format.js';
import { bigTextLines } from '../src/ui/glyphs.js';

const GB = 1024 ** 3;

/** Every character `formatBytes` can emit. Nothing else ever reaches the headline. */
const SIZE_CHARACTERS = [...'0123456789.BKMGTP'];

describe('the block face', () => {
  it('returns two rows of exactly equal width, for everything a size can contain', () => {
    for (const character of [...SIZE_CHARACTERS, ...LOGO_TEXT]) {
      const [top, bottom] = bigText(character);
      expect(top.length, character).toBe(bottom.length);
      expect(top.length, character).toBeGreaterThan(0);
    }
  });

  /**
   * The property `App` actually depends on: the caption's left edge is computed from the first
   * row's length, so the two rows have to agree for *composed* strings too — not merely
   * character by character. A separator inserted between glyphs on one row and not the other
   * would satisfy the test above and still break the layout.
   */
  it('keeps the two rows the same width for whole figures', () => {
    for (const bytes of [0, 512, 8 * 1024, 3.4 * GB, 67 * GB, 104 * GB, 133 * GB, 1024 * GB]) {
      const text = formatBytes(bytes);
      const [top, bottom] = bigText(text);
      expect(top.length, text).toBe(bottom.length);
      expect(bigTextWidth(text), text).toBe(top.length);
    }
  });

  it('draws every digit and unit differently from every other', () => {
    const seen = new Map<string, string>();
    for (const character of SIZE_CHARACTERS) {
      const key = bigText(character).join('\n');
      const clash = seen.get(key);
      expect(clash, `${character} renders identically to ${String(clash)}`).toBeUndefined();
      seen.set(key, character);
    }
  });

  /**
   * `0` against `8` is the pair the grid nearly could not hold, and the one whose collision
   * would be least visible in review and most expensive in use: a `108G` that renders as `100G`
   * is a wrong number in the largest type on the screen.
   */
  it('tells 0 and 8 apart', () => {
    expect(bigText('0')).not.toEqual(bigText('8'));
    expect(bigText('6')).not.toEqual(bigText('G'));
  });

  it('is four times the height and width of the text it replaces', () => {
    const [top, bottom] = bigText('104G');
    // Two rows against one, and every row wider than the four characters it stands in for.
    expect([top, bottom].every((row) => row.length > '104G'.length * 2)).toBe(true);
  });

  /** A character with no bitmap is dropped, never substituted: a `?` would read as a digit. */
  it('drops characters it cannot draw rather than inventing one', () => {
    expect(bigText('')).toEqual(['', '']);
    expect(bigText('?!')).toEqual(['', '']);
    expect(bigText('1?')).toEqual(bigText('1'));
  });

  it('spells the wordmark in ordinary letters, so it survives a terminal without blocks', () => {
    expect(WORDMARK).toContain('dev-cleaner');
  });
});

describe('splashTitle', () => {
  it('returns the solid block face when width allows', () => {
    const solid = bigTextLines(LOGO_TEXT);
    expect(solid).toBeDefined();
    const result = splashTitle(80);
    expect(result.degraded).toBe(false);
    expect(result.lines.join('\n')).toContain(solid![0]!);
  });

  it('degrades to WORDMARK when too narrow', () => {
    const result = splashTitle(10);
    expect(result.degraded).toBe(true);
    expect(result.lines).toEqual([truncateLabel(WORDMARK, 10)]);
  });
});
