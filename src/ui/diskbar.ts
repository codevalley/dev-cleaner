/**
 * The disk gauge: how full the volume is, and what the current selection would do to it.
 *
 * **The caveat this module exists to state honestly.** dev-cleaner moves things to the Trash;
 * it does not delete them. Until the Trash is emptied every byte is still on the volume, so
 * the free-space figure does **not** move when a clean finishes. Everything here is therefore
 * a *projection*: the third segment of the bar and every "after" number mean "what emptying
 * the Trash afterwards would give you", never "what you have now". A gauge that animated the
 * free space upwards the moment a clean succeeded would be the most convincing lie the
 * interface could tell — the user would check `df`, see nothing changed, and stop believing
 * the rest of the screen. `TRASH_CAVEAT` is the sentence that says so on screen; it is
 * exported rather than written into a component so it cannot be dropped in a re-layout.
 *
 * **Why the arithmetic is the interesting part.** A three-part bar is three roundings that
 * must still add up. Round each part independently and a 40-cell bar renders as 39 or 41 —
 * one column short of its border, or one past it, wrapping the line and taking the frame with
 * it. `barSegments` apportions by largest remainder, so the widths sum to exactly `width` for
 * every input, and clamps `reclaiming` into `[0, used]`, so a selection larger than the used
 * space (possible: sizes are measured per artifact and a bind mount or a hardlinked store can
 * be counted twice) shortens the "staying" segment to zero instead of going negative.
 */

import { formatBytes, formatPercent } from './format.js';

/**
 * A volume, as three byte counts that always satisfy `used + free === total`.
 *
 * That identity is not what `statfs` reports — a filesystem reserves blocks that are neither
 * available to you nor in use by your files — and `usageFromStatfs` resolves the discrepancy
 * by counting reserved blocks as *used*. The alternative, reporting them as free, promises
 * space that no `df` and no write will ever give you.
 */
export interface DiskUsage {
  total: number;
  used: number;
  free: number;
}

/** The three fields of `statfs` this needs, named so a test can supply them without a disk. */
export interface VolumeStats {
  /** Block size in bytes. */
  bsize: number;
  /** Total blocks on the volume. */
  blocks: number;
  /** Blocks available to an unprivileged user — the number `df` calls "available". */
  bavail: number;
}

export type BarKind = 'used' | 'reclaim' | 'free';

export interface BarSegment {
  kind: BarKind;
  /** Width in terminal cells. May be 0; the three widths always sum to the requested width. */
  width: number;
}

/**
 * The projection caveat, in one line, for wherever the bar is drawn.
 *
 * Deliberately phrased as a condition ("once you empty the Trash") rather than as an apology,
 * because the user's next action is a real one and the sentence is what tells them it exists.
 */
export const TRASH_CAVEAT = 'Trashed files still occupy the disk until you empty the Trash.';

/**
 * The three segments, in the order they are drawn — the single source of that order.
 *
 * `barSegments` builds its result from this, and `BAR_LEGEND` reads the legend off it, so the
 * legend cannot end up describing the segments in an order the bar does not use.
 */
export const SEGMENT_ORDER: readonly BarKind[] = ['used', 'reclaim', 'free'];

/**
 * Glyphs for the three segments, left to right. Exported so tests need not hard-code them.
 *
 * These are a *monotone ink ramp*: FULL BLOCK is 100% coverage, DARK SHADE about 75%, LIGHT
 * SHADE about 25%. That ordering is the load-bearing part, not the specific characters. It is
 * what makes the bar readable with colour stripped entirely — on a terminal with no colour, in
 * a greyscale screenshot, or to a reader who cannot separate the hues — and it is why the
 * three segments must never be unified onto one glyph and told apart by colour alone. The
 * ramp is asserted in `ui.diskbar.test.ts` against the Unicode block elements' nominal
 * coverage, so a "tidy-up" that flattens it fails rather than quietly removing the only
 * channel that always works.
 */
export const SEGMENT_GLYPHS: Record<BarKind, string> = {
  used: '█',
  reclaim: '▓',
  free: '░',
};

/** Legend copy for the three segments — what each one is, in the user's words. */
export const SEGMENT_LABELS: Record<BarKind, string> = {
  used: 'in use',
  reclaim: 'this selection',
  free: 'free',
};

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * A `statfs` result as a `DiskUsage`, or `undefined` when the numbers cannot be believed.
 *
 * Split out from `readDiskUsage` so the arithmetic — the part with the reserved-block
 * subtlety in it — is testable without mounting anything. A zero or negative block size or
 * block count means the call answered about something that is not a volume; reporting a
 * 0-byte disk would render as a completely full bar, which is a worse answer than no bar.
 */
export function usageFromStatfs(stats: VolumeStats): DiskUsage | undefined {
  const bsize = finite(stats.bsize);
  const blocks = finite(stats.blocks);
  if (bsize <= 0 || blocks <= 0) return undefined;

  const total = bsize * blocks;
  // `bavail`, not `bfree`: the difference is the reserved pool, which is not yours to fill.
  const free = clamp(finite(stats.bavail) * bsize, 0, total);
  return { total, used: total - free, free };
}

/**
 * The volume holding `pathOnVolume`, or `undefined` if it cannot be measured.
 *
 * Never throws. The path may have been removed between the scan and this call, and a
 * container can refuse the syscall outright — both are the same fact from the interface's
 * point of view: there is no gauge this run. A cleaner that fails to start because it could
 * not draw a bar would be an absurd trade.
 *
 * The import is dynamic for the same reason. `statfs` arrived in Node 18.15, and a named
 * ESM import of a binding a builtin does not export throws at *module load* — which would
 * take the whole app down on an older runtime before a single frame is drawn, over a
 * decoration. Deferred into the `try`, a missing binding is just another absent gauge.
 */
export async function readDiskUsage(pathOnVolume: string): Promise<DiskUsage | undefined> {
  try {
    const { statfs } = await import('node:fs/promises');
    return usageFromStatfs(await statfs(pathOnVolume));
  } catch {
    return undefined;
  }
}

/** What the volume's free space would become once the Trash is emptied. */
export function projectedFree(usage: DiskUsage, reclaiming: number): number {
  const total = Math.max(0, finite(usage.total));
  const used = clamp(finite(usage.used), 0, total);
  const free = total - used;
  return free + clamp(finite(reclaiming), 0, used);
}

/**
 * Split `width` cells across three quantities by largest remainder.
 *
 * `parts` must sum to `whole`. Each part gets its floor, and the leftover cells — at most
 * `parts.length - 1` of them — go to the largest fractional remainders, ties to the leftmost.
 * This is the only apportionment that both preserves the total exactly and never moves a cell
 * more than one away from its exact share.
 */
function apportion(parts: readonly number[], whole: number, width: number): number[] {
  const exact = parts.map((part) => (part * width) / whole);
  const widths = exact.map((value) => Math.floor(value));
  let spare = width - widths.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  for (const { index } of order) {
    if (spare <= 0) break;
    widths[index] = (widths[index] ?? 0) + 1;
    spare -= 1;
  }
  return widths;
}

/**
 * The bar, as three segments in render order: what is used and staying, what this selection
 * would free, what is already free.
 *
 * Always three segments, some possibly zero-width, so the renderer is a `map` with no cases
 * in it. The widths sum to exactly `width` — that is the property the whole function is
 * shaped around, and it holds for a full disk, an empty one, a `reclaiming` larger than the
 * disk, and a `width` of 0.
 *
 * One deliberate departure from proportionality: a non-zero `reclaiming` that rounds to no
 * cells is given one, taken from whichever neighbour can spare it. Below about 1/`width` of
 * the volume every selection would otherwise leave the bar visually identical, and a gauge
 * that does not move when you check a box reads as broken rather than as precise. The cell is
 * a *presence* indicator; the byte figures beside the bar remain the exact answer.
 */
export function barSegments(usage: DiskUsage, reclaiming: number, width: number): BarSegment[] {
  const cells = Math.max(0, Number.isFinite(width) ? Math.floor(width) : 0);
  const kinds = SEGMENT_ORDER;
  if (cells === 0) return kinds.map((kind) => ({ kind, width: 0 }));

  const total = Math.max(0, finite(usage.total));
  // No measurable volume: draw it empty rather than full. "I don't know" must not render as
  // "your disk is 100% used".
  if (total === 0) return [
    { kind: 'used', width: 0 },
    { kind: 'reclaim', width: 0 },
    { kind: 'free', width: cells },
  ];

  const used = clamp(finite(usage.used), 0, total);
  const reclaim = clamp(finite(reclaiming), 0, used);
  const parts = [used - reclaim, reclaim, total - used];

  const widths = apportion(parts, total, cells);
  if (reclaim > 0 && widths[1] === 0) {
    // Steal from the wider neighbour, and only if it can still show something itself.
    const donor = (widths[0] ?? 0) >= (widths[2] ?? 0) ? 0 : 2;
    if ((widths[donor] ?? 0) >= 2) {
      widths[donor] = (widths[donor] ?? 0) - 1;
      widths[1] = 1;
    }
  }

  return kinds.map((kind, index) => ({ kind, width: widths[index] ?? 0 }));
}

/** The bar as a string. Glyphs only — colour is the renderer's business. */
export function renderBar(segments: readonly BarSegment[]): string {
  return segments.map((segment) => SEGMENT_GLYPHS[segment.kind].repeat(segment.width)).join('');
}

/**
 * The numbers beside the bar, already formatted.
 *
 * `projected` is `undefined` when nothing is selected: the "after" figure is meaningful only
 * as the consequence of a choice, and showing it unchanged next to the current free space
 * invites the reader to believe the two differ for some other reason.
 */
export interface DiskLabels {
  /** e.g. `391G used of 466G`. */
  used: string;
  /** e.g. `75.4G free`. */
  free: string;
  /** e.g. `→ 138G free once emptied`, or `undefined` when nothing is selected. */
  projected: string | undefined;
  /** e.g. `84%`. */
  percent: string;
}

export function diskLabels(usage: DiskUsage, reclaiming: number): DiskLabels {
  const total = Math.max(0, finite(usage.total));
  const used = clamp(finite(usage.used), 0, total);
  const reclaim = clamp(finite(reclaiming), 0, used);

  const after = `→ ${formatBytes(total - used + reclaim)} free once emptied`;
  return {
    used: `${formatBytes(used)} used of ${formatBytes(total)}`,
    free: `${formatBytes(total - used)} free`,
    projected: reclaim > 0 ? after : undefined,
    percent: formatPercent(total === 0 ? 0 : used / total),
  };
}
