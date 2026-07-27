/**
 * The disk gauge, and the arithmetic that has to hold before any of it is decoration.
 *
 * Two things are being defended here.
 *
 * **The bar must fit.** Three quantities rounded to whole terminal cells is three roundings
 * that can each go the wrong way; a 40-cell bar that renders 41 cells wraps the line and
 * takes the frame's layout with it, and one that renders 39 leaves a gap at the border that
 * reads as a rendering bug. The width test is therefore a sweep over widths, volumes and
 * selections rather than a couple of examples.
 *
 * **The projection must not lie.** dev-cleaner moves things to the Trash; the volume's free
 * space does not change until the Trash is emptied. Every "after" figure this module produces
 * is conditional on that, and `TRASH_CAVEAT` is the sentence that says so — asserted here
 * because a caveat nobody renders is a caveat that does not exist.
 */

import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SEGMENT_GLYPHS,
  SEGMENT_LABELS,
  TRASH_CAVEAT,
  barSegments,
  diskLabels,
  projectedFree,
  readDiskUsage,
  renderBar,
  usageFromStatfs,
  type DiskUsage,
} from '../src/ui/diskbar.js';

const GB = 1024 ** 3;
const TB = 1024 ** 4;

function usage(total: number, used: number): DiskUsage {
  return { total, used, free: total - used };
}

function widthOf(segments: readonly { width: number }[]): number {
  return segments.reduce((sum, segment) => sum + segment.width, 0);
}

describe('usageFromStatfs', () => {
  it('reports blocks × block size, in bytes', () => {
    const result = usageFromStatfs({ bsize: 4096, blocks: 1_000_000, bavail: 250_000 });
    expect(result?.total).toBe(4096 * 1_000_000);
    expect(result?.free).toBe(4096 * 250_000);
  });

  it('always satisfies used + free === total, which the bar depends on', () => {
    const result = usageFromStatfs({ bsize: 4096, blocks: 1_000_000, bavail: 250_000 });
    expect(result && result.used + result.free).toBe(result?.total);
  });

  it('counts blocks reserved by the filesystem as used, not as free', () => {
    // `bavail` is what an unprivileged write can actually have; the reserved pool between
    // `bavail` and `bfree` is nobody's free space, and promising it is how a gauge ends up
    // disagreeing with `df` and with the disk-full error the user just hit.
    const result = usageFromStatfs({ bsize: 1024, blocks: 100, bavail: 10 });
    expect(result?.free).toBe(10 * 1024);
    expect(result?.used).toBe(90 * 1024);
  });

  it('refuses numbers that cannot describe a volume rather than reporting a 0-byte disk', () => {
    // A 0-byte total would render as a completely full bar — a confident wrong answer where
    // "no gauge" is the truthful one.
    expect(usageFromStatfs({ bsize: 0, blocks: 100, bavail: 10 })).toBeUndefined();
    expect(usageFromStatfs({ bsize: 4096, blocks: 0, bavail: 0 })).toBeUndefined();
    expect(usageFromStatfs({ bsize: -1, blocks: 100, bavail: 10 })).toBeUndefined();
    expect(usageFromStatfs({ bsize: Number.NaN, blocks: 100, bavail: 10 })).toBeUndefined();
  });

  it('clamps an available count larger than the volume', () => {
    const result = usageFromStatfs({ bsize: 1024, blocks: 10, bavail: 999 });
    expect(result?.free).toBe(10 * 1024);
    expect(result?.used).toBe(0);
  });
});

describe('readDiskUsage', () => {
  it('measures the volume a real path lives on', async () => {
    const result = await readDiskUsage(tmpdir());
    expect(result).toBeDefined();
    expect(result?.total).toBeGreaterThan(0);
    expect(result && result.used + result.free).toBe(result?.total);
  });

  it('returns undefined rather than throwing when the path is gone', async () => {
    const missing = path.join(tmpdir(), 'dev-cleaner-no-such-volume-9f3c1a');
    await expect(readDiskUsage(missing)).resolves.toBeUndefined();
  });
});

describe('barSegments: the widths add up', () => {
  it('sums to exactly the requested width across every shape of input', () => {
    const volumes: DiskUsage[] = [
      usage(500 * GB, 400 * GB),
      usage(500 * GB, 0),
      usage(500 * GB, 500 * GB),
      usage(2 * TB, 1_337 * GB),
      usage(31, 7),
      usage(1, 1),
    ];
    const selections = [0, 1, GB, 37 * GB, 400 * GB, 500 * GB, 9 * TB];

    for (const volume of volumes) {
      for (const reclaiming of selections) {
        for (let width = 10; width <= 80; width += 1) {
          const segments = barSegments(volume, reclaiming, width);
          expect(widthOf(segments)).toBe(width);
          for (const segment of segments) {
            expect(segment.width).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(segment.width)).toBe(true);
          }
        }
      }
    }
  });

  it('always returns the three quantities, in render order', () => {
    const segments = barSegments(usage(100 * GB, 50 * GB), 10 * GB, 20);
    expect(segments.map((segment) => segment.kind)).toEqual(['used', 'reclaim', 'free']);
  });

  it('renders a string exactly as wide as the bar it was asked for', () => {
    for (const width of [10, 13, 24, 41, 80]) {
      const bar = renderBar(barSegments(usage(931 * GB, 700 * GB), 63 * GB, width));
      expect([...bar]).toHaveLength(width);
    }
  });
});

describe('barSegments: what the three parts mean', () => {
  it('splits used space into what stays and what this selection would free', () => {
    // 40 GB used of 100, half of it selected. Across 40 cells: 20 GB staying is 8 cells,
    // 20 GB reclaiming is 8, and the 60 GB already free is 24.
    const segments = barSegments(usage(100 * GB, 40 * GB), 20 * GB, 40);
    expect(segments).toEqual([
      { kind: 'used', width: 8 },
      { kind: 'reclaim', width: 8 },
      { kind: 'free', width: 24 },
    ]);
  });

  it('grows the reclaim segment as the selection grows, taking from used, never from free', () => {
    const volume = usage(100 * GB, 60 * GB);
    const none = barSegments(volume, 0, 50);
    const some = barSegments(volume, 30 * GB, 50);

    expect(none[1]?.width).toBe(0);
    expect(some[1]?.width).toBeGreaterThan(0);
    // The free segment is what is free *now*; the projection lives in the middle segment.
    expect(some[2]?.width).toBe(none[2]?.width);
    expect(some[0]?.width).toBeLessThan(none[0]?.width ?? 0);
  });

  it('clamps a selection larger than the used space instead of going negative', () => {
    // Sizes are measured per artifact; a hardlinked package store or a bind mount can be
    // counted twice, so `reclaiming > used` is reachable without anything being wrong.
    const segments = barSegments(usage(100 * GB, 10 * GB), 900 * GB, 40);
    expect(widthOf(segments)).toBe(40);
    expect(segments[0]?.width).toBe(0);
    expect(segments[1]?.width).toBe(4);
    expect(segments[2]?.width).toBe(36);
  });

  it('ignores a negative or NaN selection', () => {
    const volume = usage(100 * GB, 50 * GB);
    expect(barSegments(volume, -5 * GB, 40)).toEqual(barSegments(volume, 0, 40));
    expect(barSegments(volume, Number.NaN, 40)).toEqual(barSegments(volume, 0, 40));
  });

  it('draws an unmeasurable volume empty rather than full', () => {
    const segments = barSegments({ total: 0, used: 0, free: 0 }, 5 * GB, 20);
    expect(segments).toEqual([
      { kind: 'used', width: 0 },
      { kind: 'reclaim', width: 0 },
      { kind: 'free', width: 20 },
    ]);
  });

  it('produces nothing, safely, for a zero or nonsense width', () => {
    for (const width of [0, -10, Number.NaN]) {
      const segments = barSegments(usage(100 * GB, 50 * GB), 10 * GB, width);
      expect(widthOf(segments)).toBe(0);
      expect(segments).toHaveLength(3);
    }
  });

  it('shows a cell for a selection too small to round to one, so the bar answers a keypress', () => {
    // 100 MB of a 2 TB volume is a ten-thousandth of one cell. Rounded honestly the bar would
    // not move at all as the user checks boxes, which reads as broken rather than as precise;
    // the exact figure is in the labels beside it.
    const segments = barSegments(usage(2 * TB, 1 * TB), 100 * 1024 * 1024, 40);
    expect(segments[1]?.width).toBe(1);
    expect(widthOf(segments)).toBe(40);
  });

  it('takes that cell from a neighbour, never from the total', () => {
    const withoutSelection = barSegments(usage(2 * TB, 1 * TB), 0, 40);
    const withSelection = barSegments(usage(2 * TB, 1 * TB), 100 * 1024 * 1024, 40);

    expect(widthOf(withSelection)).toBe(widthOf(withoutSelection));
    expect(withSelection[0]?.width).toBe((withoutSelection[0]?.width ?? 0) - 1);
  });

  it('does not invent a cell when nothing is selected', () => {
    expect(barSegments(usage(2 * TB, 1 * TB), 0, 40)[1]?.width).toBe(0);
  });

  it('tracks how full the disk is', () => {
    const nearlyFull = barSegments(usage(100 * GB, 95 * GB), 0, 20);
    const nearlyEmpty = barSegments(usage(100 * GB, 5 * GB), 0, 20);

    expect(nearlyFull[0]?.width).toBe(19);
    expect(nearlyEmpty[0]?.width).toBe(1);
  });
});

describe('the projection, and its caveat', () => {
  it('adds the selection to what is free today', () => {
    expect(projectedFree(usage(500 * GB, 400 * GB), 60 * GB)).toBe(160 * GB);
  });

  it('cannot project more free space than the volume has', () => {
    expect(projectedFree(usage(500 * GB, 400 * GB), 9 * TB)).toBe(500 * GB);
  });

  it('says out loud that the Trash still holds the bytes', () => {
    expect(TRASH_CAVEAT).toMatch(/Trash/);
    expect(TRASH_CAVEAT.toLowerCase()).toContain('until you empty');
  });

  it('labels the three segments in the user’s words, not the code’s', () => {
    expect(SEGMENT_LABELS.used).toBe('in use');
    expect(SEGMENT_LABELS.free).toBe('free');
    expect(SEGMENT_LABELS.reclaim).toBe('this selection');
    for (const glyph of Object.values(SEGMENT_GLYPHS)) expect([...glyph]).toHaveLength(1);
  });
});

describe('diskLabels', () => {
  it('states what is used, of what, and what is free', () => {
    const labels = diskLabels(usage(500 * GB, 400 * GB), 0);
    expect(labels.used).toBe('400G used of 500G');
    expect(labels.free).toBe('100G free');
    expect(labels.percent).toBe('80%');
  });

  it('offers the "after" figure only once something is selected', () => {
    expect(diskLabels(usage(500 * GB, 400 * GB), 0).projected).toBeUndefined();
    expect(diskLabels(usage(500 * GB, 400 * GB), 60 * GB).projected).toBe(
      '→ 160G free once emptied',
    );
  });

  it('conditions the "after" figure on emptying the Trash', () => {
    const labels = diskLabels(usage(500 * GB, 400 * GB), 60 * GB);
    expect(labels.projected).toMatch(/emptied/);
  });

  it('does not report a percentage of an unmeasurable volume', () => {
    expect(diskLabels({ total: 0, used: 0, free: 0 }, 5 * GB).percent).toBe('0%');
  });
});
