/**
 * The list has to scroll *itself*.
 *
 * Before `viewport.ts` the left pane rendered every row it had. Ink then printed a frame
 * taller than the terminal, the terminal scrolled it, and the footer — the only place the
 * keybindings are written down — went off the top of the screen with no way back. The bug is
 * therefore not "the list looks wrong", it is "the interface loses its command bar", which is
 * why the windowing is a module with its own suite rather than three lines inside a
 * component.
 *
 * Four properties are asserted exhaustively rather than by example, because each of them is a
 * thing a plausible implementation gets right for the cases you thought of and wrong for the
 * ones you did not: the cursor is inside the window, the window is inside the list, the
 * window is exactly `height` rows (or the whole list), and it does not move unless it has to.
 */

import { describe, expect, it } from 'vitest';

import {
  hiddenAbove,
  hiddenBelow,
  scrollHint,
  visibleSlice,
  windowFor,
  type Viewport,
} from '../src/ui/viewport.js';

/** Walk the cursor down the whole list the way `j` does, carrying the window forward. */
function scrollThrough(total: number, height: number): Viewport[] {
  const seen: Viewport[] = [];
  let view: Viewport | undefined;
  for (let cursor = 0; cursor < total; cursor += 1) {
    view = windowFor(total, cursor, height, view);
    seen.push(view);
  }
  return seen;
}

describe('windowFor: the invariants, over every shape', () => {
  const totals = [0, 1, 2, 3, 5, 9, 10, 11, 40, 137];
  const heights = [0, 1, 2, 3, 5, 10, 24];

  it('keeps the cursor inside the window, always', () => {
    for (const total of totals) {
      for (const height of heights) {
        for (let cursor = -3; cursor <= total + 3; cursor += 1) {
          const view = windowFor(total, cursor, height);
          if (view.end === view.start) {
            // An empty window is legal only when there is nothing to show.
            expect(Math.min(total, height)).toBeLessThanOrEqual(0);
            continue;
          }
          expect(view.cursor).toBeGreaterThanOrEqual(view.start);
          expect(view.cursor).toBeLessThan(view.end);
        }
      }
    }
  });

  it('never slices outside the list, and never backwards', () => {
    for (const total of totals) {
      for (const height of heights) {
        for (let cursor = -3; cursor <= total + 3; cursor += 1) {
          const view = windowFor(total, cursor, height);
          expect(view.start).toBeGreaterThanOrEqual(0);
          expect(view.end).toBeGreaterThanOrEqual(view.start);
          expect(view.end).toBeLessThanOrEqual(total);
        }
      }
    }
  });

  it('shows exactly `height` rows, or the whole list when it is shorter', () => {
    for (const total of totals) {
      for (const height of heights) {
        const view = windowFor(total, 0, height);
        expect(view.end - view.start).toBe(Math.max(0, Math.min(total, height)));
      }
    }
  });

  it('clamps a cursor that is off either end of the list', () => {
    expect(windowFor(10, -5, 4).cursor).toBe(0);
    expect(windowFor(10, 99, 4).cursor).toBe(9);
    expect(windowFor(10, 99, 4).end).toBe(10);
  });
});

describe('windowFor: stability — the reason it takes the previous window', () => {
  it('does not move while the cursor travels inside the window', () => {
    // 100 rows, 10 visible. Rows 0..8 are all reachable without scrolling: only the last
    // visible row is withheld, to keep one row of context ahead of the cursor.
    let view = windowFor(100, 0, 10);
    expect(view.start).toBe(0);

    for (let cursor = 1; cursor <= 8; cursor += 1) {
      view = windowFor(100, cursor, 10, view);
      expect(view.start).toBe(0);
    }
  });

  it('scrolls by exactly one row when the cursor would leave, not by half a screen', () => {
    let view = windowFor(100, 8, 10, { start: 0, end: 10, cursor: 8 });
    view = windowFor(100, 9, 10, view);
    expect(view.start).toBe(1);
    expect(view.end).toBe(11);

    view = windowFor(100, 10, 10, view);
    expect(view.start).toBe(2);
  });

  it('keeps a row of context ahead of the cursor while there is one to keep', () => {
    for (const view of scrollThrough(60, 12)) {
      const atTop = view.start === 0;
      const atBottom = view.end === 60;
      if (!atTop) expect(view.cursor).toBeGreaterThan(view.start);
      if (!atBottom) expect(view.cursor).toBeLessThan(view.end - 1);
    }
  });

  it('lets the cursor reach the very first and very last row', () => {
    const down = scrollThrough(60, 12);
    expect(down[0]?.start).toBe(0);
    expect(down[0]?.cursor).toBe(0);

    const last = down[down.length - 1];
    expect(last?.cursor).toBe(59);
    expect(last?.end).toBe(60);
    expect(last?.start).toBe(48);
  });

  it('scrolls back up on the way home, one row at a time', () => {
    let view = windowFor(60, 59, 12);
    expect(view.start).toBe(48);

    view = windowFor(60, 58, 12, view);
    expect(view.start).toBe(48); // still inside, with a row of context below

    view = windowFor(60, 47, 12, view);
    expect(view.start).toBe(46); // one above the cursor, not centred on it
  });

  it('drops the margin rather than fighting itself in a window too short for one', () => {
    // Two visible rows cannot hold a cursor plus a row of context on both sides.
    const view = windowFor(20, 5, 2);
    expect(view.end - view.start).toBe(2);
    expect(view.cursor).toBeGreaterThanOrEqual(view.start);
    expect(view.cursor).toBeLessThan(view.end);

    const one = windowFor(20, 7, 1);
    expect(one).toEqual({ start: 7, end: 8, cursor: 7 });
  });

  it('pulls a stale window back into range when the list shrinks under it', () => {
    // A clean removed what it trashed, or a preset change dropped half the rows. The window
    // that was on screen now starts past the end of the list.
    const stale: Viewport = { start: 80, end: 90, cursor: 85 };
    const view = windowFor(12, 3, 10, stale);

    expect(view.start).toBe(2);
    expect(view.end).toBe(12);
    expect(view.cursor).toBe(3);
  });
});

describe('windowFor: degenerate input produces an empty window, not a broken one', () => {
  it('renders nothing when there is nothing, or nowhere to render it', () => {
    expect(windowFor(0, 0, 10)).toEqual({ start: 0, end: 0, cursor: 0 });
    expect(windowFor(40, 5, 0)).toEqual({ start: 0, end: 0, cursor: 0 });
    expect(windowFor(40, 5, -3)).toEqual({ start: 0, end: 0, cursor: 0 });
    expect(windowFor(-7, 5, 10)).toEqual({ start: 0, end: 0, cursor: 0 });
  });

  it('never lets a NaN reach a slice', () => {
    for (const view of [
      windowFor(Number.NaN, 3, 10),
      windowFor(40, Number.NaN, 10),
      windowFor(40, 3, Number.NaN),
      windowFor(Number.POSITIVE_INFINITY, 3, 10),
      windowFor(40, 3, Number.POSITIVE_INFINITY),
    ]) {
      expect(Number.isInteger(view.start)).toBe(true);
      expect(Number.isInteger(view.end)).toBe(true);
      expect(Number.isInteger(view.cursor)).toBe(true);
      expect(view.start).toBeGreaterThanOrEqual(0);
      expect(view.end).toBeGreaterThanOrEqual(view.start);
    }
  });

  it('ignores a nonsense previous window instead of propagating it', () => {
    const view = windowFor(40, 3, 10, { start: Number.NaN, end: Number.NaN, cursor: 0 });
    expect(view).toEqual({ start: 0, end: 10, cursor: 3 });
  });

  it('rounds a fractional height down rather than slicing on a fraction', () => {
    const view = windowFor(40, 0, 10.7);
    expect(view.end).toBe(10);
  });
});

describe('scroll affordances', () => {
  it('counts what is hidden on each side', () => {
    const view = windowFor(60, 30, 10, { start: 25, end: 35, cursor: 30 });
    expect(hiddenAbove(view)).toBe(25);
    expect(hiddenBelow(view, 60)).toBe(25);
  });

  it('says nothing at all when the whole list is visible', () => {
    const view = windowFor(6, 2, 20);
    expect(hiddenAbove(view)).toBe(0);
    expect(hiddenBelow(view, 6)).toBe(0);
    expect(scrollHint(view, 6)).toBeUndefined();
  });

  it('names only the side that is actually hidden', () => {
    const top = windowFor(50, 0, 10);
    expect(scrollHint(top, 50)).toBe('↓ 40 more below');

    const bottom = windowFor(50, 49, 10, top);
    expect(scrollHint(bottom, 50)).toBe('↑ 40 more above');

    const middle = windowFor(50, 25, 10, { start: 20, end: 30, cursor: 24 });
    expect(scrollHint(middle, 50)).toBe('↑ 20 more above  ·  ↓ 20 more below');
  });

  it('never reports a negative remainder for a stale total', () => {
    expect(hiddenBelow({ start: 0, end: 10, cursor: 0 }, 4)).toBe(0);
    expect(hiddenBelow({ start: 0, end: 10, cursor: 0 }, Number.NaN)).toBe(0);
  });
});

describe('visibleSlice', () => {
  const items = Array.from({ length: 30 }, (_, index) => `row-${index}`);

  it('returns exactly the rows the window names', () => {
    const view = windowFor(items.length, 20, 8, { start: 15, end: 23, cursor: 20 });
    const shown = visibleSlice(items, view);

    expect(shown).toHaveLength(8);
    expect(shown[0]).toBe('row-15');
    expect(shown[7]).toBe('row-22');
  });

  it('returns nothing for an empty window', () => {
    expect(visibleSlice(items, windowFor(items.length, 0, 0))).toEqual([]);
  });

  it('never renders more rows than the terminal has, which is the whole point', () => {
    for (const height of [1, 5, 12, 40]) {
      for (const view of scrollThrough(items.length, height)) {
        expect(visibleSlice(items, view).length).toBeLessThanOrEqual(height);
      }
    }
  });
});
