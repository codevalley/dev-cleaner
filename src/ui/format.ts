/**
 * Display formatting for the TUI. Pure string functions, no React, so the layout code
 * stays free of arithmetic and the numbers can be asserted directly in tests.
 *
 * The mock in the spec is the specification for `formatBytes`: `133G`, `67.0G`, `3.4G`.
 * One decimal below 100, none at or above it, so a column of sizes never exceeds five
 * characters and never jitters in width as a scan fills sizes in.
 */

const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'] as const;
const STEP = 1024;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Fixed width of a formatted size, for right-aligning the size column. */
export const BYTES_WIDTH = 6;

/**
 * The three glyphs the list is read by. Exported rather than inlined so a test can assert
 * on selection state without hard-coding a character the layout might change.
 */
export const CURSOR = '▸';
export const MARK_ON = '◉';
export const MARK_OFF = '○';

/**
 * `67.0G`, `133G`, `512B`. Degenerate input (NaN, negative, Infinity) formats as `0B`
 * rather than throwing: a size that failed to measure is reported as nothing reclaimable,
 * which understates the total — the harmless direction.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';

  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }

  const suffix = UNITS[unit] ?? 'B';
  if (unit === 0 || value >= 100) return `${Math.round(value)}${suffix}`;
  return `${value.toFixed(1)}${suffix}`;
}

/** `formatBytes`, right-aligned into a fixed column. */
export function formatBytesPadded(bytes: number, width: number = BYTES_WIDTH): string {
  return formatBytes(bytes).padStart(width);
}

/**
 * A coarse, single-unit age: `now`, `30m`, `5h`, `3d`, `8mo`, `2y`. Deliberately lossy —
 * this decorates a status line ("dormant 8mo"), where precision would only add noise.
 */
export function formatIdle(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return 'now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < MONTH) return `${Math.floor(ms / DAY)}d`;
  if (ms < YEAR) return `${Math.floor(ms / MONTH)}mo`;
  return `${Math.floor(ms / YEAR)}y`;
}

/**
 * An ISO day for the detail pane. `0` — the "no commit" sentinel a missing `GitInfo`
 * leaves behind — renders as an em dash rather than as 1970.
 */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Truncate to exactly `width` columns, ellipsising when it does not fit. Ink wraps text
 * that overflows its box, which would break the one-row-per-project layout, so labels are
 * clipped before they are handed to a `<Text>`.
 */
export function truncateLabel(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width === 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

/** Truncate, then pad to `width`, so columns to the right of a label line up. */
export function padLabel(value: string, width: number): string {
  return truncateLabel(value, width).padEnd(width);
}
