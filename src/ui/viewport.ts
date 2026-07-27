/**
 * Windowing maths for the list pane: which slice of the rows is on screen, and how much is
 * hidden on either side of it.
 *
 * This exists because a list that renders *every* row does not scroll — the **terminal**
 * does. Ink prints a frame taller than the window, the emulator scrolls it, and the footer
 * (the only place the keybindings are written down) leaves the screen. Nothing about that is
 * recoverable by the user: the command bar is gone until the list happens to shrink. So the
 * list has to draw at most `height` rows and move that window itself.
 *
 * Three properties, in the order they were found to matter:
 *
 * 1. **The cursor is always inside the window.** Not "usually" — the returned `Viewport` is
 *    the only thing the renderer consults, so a cursor outside it is a cursor the user cannot
 *    see, on a row `space` would still toggle.
 *
 * 2. **The window is stable while the cursor moves inside it.** The obvious implementation
 *    re-centres on the cursor every keypress, which makes every `j` scroll the whole list and
 *    leaves the eye with nothing fixed to track. Scrolling happens only when the cursor would
 *    otherwise leave, and then by the smallest amount that keeps a one-row margin of context
 *    ahead of it. That margin is what stops the cursor from sitting on the very last visible
 *    row with the next row unknowable.
 *
 * 3. **Degenerate input produces an empty window, never a broken one.** `height <= 0`
 *    (a terminal so short the chrome consumes it), `total === 0` (the first frame of a scan),
 *    NaN from an arithmetic slip upstream: all of them yield `{start: 0, end: 0, cursor: 0}`.
 *    `Array.prototype.slice` is happy to be handed nonsense and returns something plausible,
 *    which is exactly how a NaN reaches the renderer and blanks the pane.
 *
 * Everything here is arithmetic over indices. It knows nothing of rows, headers or React;
 * `model.ts` maps a cursor id to an index (`cursorIndex`), and the shell slices.
 */

/**
 * A half-open window over `total` items: `[start, end)`, plus the clamped cursor index.
 *
 * `end` is exclusive so it can be passed straight to `slice`, and `cursor` is returned
 * alongside because clamping it is part of the same calculation — a caller that clamps
 * separately can disagree with the window it was handed.
 */
export interface Viewport {
  /** First visible index, inclusive. `0` when nothing is visible. */
  start: number;
  /** One past the last visible index. `start === end` means an empty window. */
  end: number;
  /** The cursor, clamped into `[0, total - 1]`, and guaranteed to lie in `[start, end)`. */
  cursor: number;
}

/** An empty window. Its own constant so every degenerate path returns the same object shape. */
const EMPTY: Viewport = { start: 0, end: 0, cursor: 0 };

/** Floor to an integer, mapping NaN/Infinity to 0 rather than propagating them into a slice. */
function whole(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * How many rows of context to keep between the cursor and the edge it is moving towards.
 *
 * One, and only when the window is at least three rows tall: with two rows a one-row margin
 * on each side leaves nowhere for the cursor to be, and the clamping below would silently
 * fight itself. A short window simply scrolls with the cursor on its edge.
 */
function marginFor(size: number): number {
  return size >= 3 ? 1 : 0;
}

/**
 * The window to render, given the previous one.
 *
 * `current` is what makes this stable rather than centring: it is the window that is already
 * on screen, and it is *kept* unless the cursor would leave it. Pass `undefined` on the first
 * frame (or after a re-sort has made the old window meaningless) and the list opens at the
 * top, scrolling down only as far as the cursor demands — the same rule, seeded from row 0.
 *
 * A stale `current` cannot corrupt the result: its `start` is clamped into range before it is
 * used, so a window left over from a longer list (a preset change dropping half the rows, a
 * clean removing what it trashed) is simply pulled back to the end of the new one.
 */
export function windowFor(
  total: number,
  cursor: number,
  height: number,
  current?: Viewport | undefined,
): Viewport {
  const count = Math.max(0, whole(total));
  const size = Math.min(Math.max(0, whole(height)), count);
  if (size === 0) return EMPTY;

  const at = clamp(whole(cursor), 0, count - 1);
  const margin = marginFor(size);
  const last = count - size;

  let start = clamp(whole(current?.start ?? 0), 0, last);
  // Scroll up only if the cursor (plus its margin) has fallen off the top…
  if (at - margin < start) start = at - margin;
  // …and down only if it has run past the bottom. Both are the minimum move that restores
  // the margin, which is what keeps a held `j` from paging the list around the cursor.
  if (at + margin > start + size - 1) start = at + margin - size + 1;
  start = clamp(start, 0, last);

  return { start, end: start + size, cursor: at };
}

/** Rows scrolled off the top. `0` when the window is at the top or empty. */
export function hiddenAbove(view: Viewport): number {
  return Math.max(0, view.start);
}

/** Rows below the window. Needs `total`, which the window itself does not carry. */
export function hiddenBelow(view: Viewport, total: number): number {
  return Math.max(0, Math.max(0, whole(total)) - view.end);
}

/**
 * The affordance line, or `undefined` when the whole list is visible.
 *
 * A window with nothing hidden must render *nothing* rather than "0 more above": the
 * indicator is the only signal that the list continues, so it has to be absent exactly when
 * the list does not. Exported as a string rather than assembled in a component so the copy is
 * asserted here.
 */
export function scrollHint(view: Viewport, total: number): string | undefined {
  const above = hiddenAbove(view);
  const below = hiddenBelow(view, total);
  if (above === 0 && below === 0) return undefined;

  const parts: string[] = [];
  if (above > 0) parts.push(`↑ ${above} more above`);
  if (below > 0) parts.push(`↓ ${below} more below`);
  return parts.join('  ·  ');
}

/** The visible items. A window wider than the array is harmless — `slice` clamps. */
export function visibleSlice<T>(items: readonly T[], view: Viewport): T[] {
  return items.slice(view.start, view.end);
}
