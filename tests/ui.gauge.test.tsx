/**
 * The disk gauge as the eye receives it: three segments that have to be told apart.
 *
 * `ui.diskbar.test.ts` proves the widths add up. This file defends the other half — that the
 * bar can actually be *read* — after a user on a dark terminal reported that the colours were
 * "not clearly contrasting" and the largest segment had effectively disappeared.
 *
 * Two independent claims are checked here, and they are independent on purpose.
 *
 * **The bar survives with colour deleted.** Not dimmed, not approximated — deleted. Every
 * escape sequence is stripped out of the rendered frame and the assertions read the plain
 * characters back. If the three segments were ever unified onto one glyph and told apart by
 * hue, these tests fail, because that change removes the only channel that works on a
 * monochrome TTY, in a greyscale screenshot, and for a reader who cannot separate the hues.
 *
 * **The colours themselves obey a stated policy, not a taste.** dev-cleaner cannot detect
 * whether it is drawing on a dark or a light background, so "it looks good on mine" is not
 * available as evidence. The policy is written as arithmetic over the classic 16-colour
 * palette below: mid-lightness only, hues that separate at the boundaries the user is
 * actually reading, and exactly one segment permitted to shout. Those rules are what stop the
 * next person reinstating `blue` because their theme happens to make it look fine.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

import {
  SEGMENT_GLYPHS,
  SEGMENT_LABELS,
  SEGMENT_ORDER,
  barSegments,
  type BarKind,
  type DiskUsage,
} from '../src/ui/diskbar.js';
import { BAR_LEGEND, Gauge, SEGMENT_COLOURS } from '../src/ui/Gauge.js';

const GB = 1024 ** 3;

function usage(total: number, used: number): DiskUsage {
  return { total, used, free: total - used };
}

/**
 * Every escape sequence a terminal can carry - colour, attributes, cursor moves.
 *
 * Stripping these is how "with colour deleted" is modelled, and it is deliberately
 * independent of whether the runner happens to have colour switched on: a suite that only
 * proved the bar readable because the harness emitted no colour in the first place would
 * prove nothing at all.
 */
const ANSI = '\\u001B\\[[0-9;?]*[ -/]*[@-~]';

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(new RegExp(ANSI, 'g'), '');
}

/** The frame with every escape sequence removed — a terminal with no colour at all. */
function renderPlain(reclaiming: number, width = 80): string {
  const instance = render(<Gauge usage={usage(500 * GB, 400 * GB)} reclaiming={reclaiming} width={width} />);
  const frame = plain(instance.lastFrame());
  instance.unmount();
  return frame;
}

/** Consecutive identical characters, as `[character, length]` — the bar's visible structure. */
function runs(text: string): [string, number][] {
  const out: [string, number][] = [];
  for (const character of text) {
    const last = out.at(-1);
    if (last && last[0] === character) last[1] += 1;
    else out.push([character, 1]);
  }
  return out;
}

/**
 * The classic 16-colour palette, as relative luminance (WCAG) and hue angle.
 *
 * This is a table of facts about terminals, not about dev-cleaner, which is why it lives in
 * the test: it is the yardstick the source is measured against, and it must not be derivable
 * from the thing being measured. Values are computed from the VGA/xterm defaults
 * (`#0000AA` for blue, `#5555FF` for blueBright, and so on). Real themes vary, but every
 * palette in circulation preserves the ordering that matters here — plain `blue` is always
 * among the darkest entries and `yellowBright` is always among the lightest.
 *
 * Hue is `undefined` for the greys, which have none.
 */
const PALETTE: Record<string, { luminance: number; hue: number | undefined }> = {
  black: { luminance: 0.0, hue: undefined },
  red: { luminance: 0.086, hue: 0 },
  green: { luminance: 0.288, hue: 120 },
  yellow: { luminance: 0.373, hue: 60 },
  blue: { luminance: 0.029, hue: 240 },
  magenta: { luminance: 0.115, hue: 300 },
  cyan: { luminance: 0.317, hue: 180 },
  white: { luminance: 0.402, hue: undefined },
  blackBright: { luminance: 0.091, hue: undefined },
  gray: { luminance: 0.091, hue: undefined },
  grey: { luminance: 0.091, hue: undefined },
  redBright: { luminance: 0.284, hue: 0 },
  greenBright: { luminance: 0.741, hue: 120 },
  yellowBright: { luminance: 0.934, hue: 60 },
  blueBright: { luminance: 0.156, hue: 240 },
  magentaBright: { luminance: 0.35, hue: 300 },
  cyanBright: { luminance: 0.807, hue: 180 },
  whiteBright: { luminance: 1.0, hue: undefined },
};

/** Nominal ink coverage of the Unicode block elements, for the texture-step comparisons. */
const INK: Record<string, number> = {
  '█': 1.0, // FULL BLOCK
  '▓': 0.75, // DARK SHADE
  '▒': 0.5, // MEDIUM SHADE
  '░': 0.25, // LIGHT SHADE
};

function entry(kind: BarKind): { luminance: number; hue: number | undefined } {
  const name = SEGMENT_COLOURS[kind];
  const found = PALETTE[name];
  // A name chalk does not know is rendered by Ink as no colour at all, silently. A typo here
  // would not throw and would not look broken in review — it would just quietly delete the
  // colour channel from one segment.
  expect(found, `"${name}" is not a colour name any terminal knows`).toBeDefined();
  return found as { luminance: number; hue: number | undefined };
}

/** Shortest way round the wheel, 0–180. */
function hueGap(a: BarKind, b: BarKind): number {
  const first = entry(a).hue;
  const second = entry(b).hue;
  expect(first, `${SEGMENT_COLOURS[a]} has no hue`).toBeDefined();
  expect(second, `${SEGMENT_COLOURS[b]} has no hue`).toBeDefined();
  const raw = Math.abs((first as number) - (second as number)) % 360;
  return Math.min(raw, 360 - raw);
}

function inkGap(a: BarKind, b: BarKind): number {
  const first = INK[SEGMENT_GLYPHS[a]];
  const second = INK[SEGMENT_GLYPHS[b]];
  expect(first, `${SEGMENT_GLYPHS[a]} is not a block element`).toBeDefined();
  expect(second, `${SEGMENT_GLYPHS[b]} is not a block element`).toBeDefined();
  return Math.abs((first as number) - (second as number));
}

describe('the bar with colour deleted', () => {
  it('reads as three distinct textures, in render order, at the widths the arithmetic gave', () => {
    // The whole accessibility claim in one assertion: strip every escape sequence and the bar
    // is still three visibly different materials in a known order.
    const segments = barSegments(usage(500 * GB, 400 * GB), 60 * GB, 22);
    const expected = segments.map((segment) => SEGMENT_GLYPHS[segment.kind].repeat(segment.width)).join('');

    expect(renderPlain(60 * GB)).toContain(expected);
    // Spelled out as well as derived, so the assertion is not merely the renderer agreeing
    // with itself: 400G used of 500G with 60G selected, over 22 cells.
    expect(runs(expected)).toEqual([
      ['█', 15],
      ['▓', 3],
      ['░', 4],
    ]);
  });

  it('uses a different character for every segment, so hue is never the only difference', () => {
    const drawn = SEGMENT_ORDER.map((kind) => SEGMENT_GLYPHS[kind]);
    expect(new Set(drawn).size, `${drawn.join('')} contains a repeat`).toBe(SEGMENT_ORDER.length);
  });

  it('still shows a boundary where the selection ends when nothing is coloured', () => {
    const bar = plain(renderPlain(60 * GB)).slice(0, 22);
    const structure = runs(bar);
    expect(structure).toHaveLength(3);
    expect(structure.map(([character]) => character)).toEqual(['█', '▓', '░']);
  });

  it('falls back to the largest texture step when nothing is selected', () => {
    // With no selection the middle segment is zero-width and the two survivors touch. They are
    // the pair furthest apart in ink coverage precisely so that this state — the one where the
    // legend is on screen because the bar is least self-explanatory — is the easiest to read.
    const bar = renderPlain(0).slice(0, 22);
    const structure = runs(bar);
    expect(structure.map(([character]) => character)).toEqual(['█', '░']);
    expect(inkGap('used', 'free')).toBeGreaterThan(inkGap('used', 'reclaim'));
    expect(inkGap('used', 'free')).toBeGreaterThan(inkGap('reclaim', 'free'));
  });

  it('shows the tiny-selection cell as its own texture, not as a colour change', () => {
    // A selection below one cell's worth still gets a cell (see `barSegments`). If that cell
    // were distinguished by colour alone it would not exist for the readers this ramp is for.
    const instance = render(
      <Gauge usage={usage(2 * 1024 ** 4, 1024 ** 4)} reclaiming={100 * 1024 * 1024} width={80} />,
    );
    const bar = plain(instance.lastFrame()).slice(0, 22);
    instance.unmount();
    expect(bar).toContain(SEGMENT_GLYPHS.reclaim);
  });
});

/**
 * What the component actually hands Ink, colour attribute by colour attribute.
 *
 * The rendered frame cannot answer this. Whether a frame carries escape sequences at all is
 * decided by the runner's colour support, not by the component, so a segment that quietly lost
 * its `color` prop renders byte-identically here to one that kept it. Reading the element tree
 * is the only way to catch a colour that was dropped rather than chosen.
 */
function painted(reclaiming: number): { colour: unknown; text: string }[] {
  const out: { colour: unknown; text: string }[] = [];

  const walk = (node: React.ReactNode, inherited: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      out.push({ colour: inherited, text: String(node) });
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inherited);
      return;
    }
    if (React.isValidElement(node)) {
      const props = node.props as { color?: unknown; children?: React.ReactNode };
      walk(props.children, 'color' in props ? props.color : inherited);
    }
  };

  walk(Gauge({ usage: usage(500 * GB, 400 * GB), reclaiming, width: 80 }), undefined);
  return out;
}

describe('every segment is actually painted', () => {
  it('hands Ink the chosen colour for each segment it draws', () => {
    const segments = barSegments(usage(500 * GB, 400 * GB), 60 * GB, 22);
    const drawn = painted(60 * GB);

    for (const segment of segments) {
      if (segment.width === 0) continue;
      const run = SEGMENT_GLYPHS[segment.kind].repeat(segment.width);
      const match = drawn.find((piece) => piece.text === run);
      expect(match, `${segment.kind} was not drawn as ${run}`).toBeDefined();
      expect(match?.colour, `${segment.kind} was drawn without its colour`).toBe(
        SEGMENT_COLOURS[segment.kind],
      );
    }
  });

  it('leaves no segment on the terminal default, which would read as text rather than as a bar', () => {
    const glyphs = new Set(SEGMENT_ORDER.map((kind) => SEGMENT_GLYPHS[kind]));
    const bars = painted(60 * GB).filter((piece) => [...piece.text].every((c) => glyphs.has(c)) && piece.text);
    expect(bars.length).toBeGreaterThanOrEqual(3);
    for (const piece of bars) {
      expect(piece.colour, `"${piece.text}" has no colour of its own`).toBeTruthy();
    }
  });
});

describe('the colour policy', () => {
  it('gives every segment a colour, and never the same one twice', () => {
    for (const kind of SEGMENT_ORDER) {
      expect(SEGMENT_COLOURS[kind], `${kind} has no colour`).toBeTruthy();
    }
    const chosen = SEGMENT_ORDER.map((kind) => SEGMENT_COLOURS[kind]);
    expect(new Set(chosen).size, `${chosen.join(', ')} contains a repeat`).toBe(SEGMENT_ORDER.length);
  });

  it('names colours a terminal actually has, rather than hex we impose on the theme', () => {
    // Ink silently renders an unknown colour name as no colour at all, so a typo would delete
    // one segment's colour without throwing and without looking wrong in review. A hex value
    // would be worse than a typo: it overrides a theme its owner already tuned.
    for (const kind of SEGMENT_ORDER) {
      const name = SEGMENT_COLOURS[kind];
      expect(Object.keys(PALETTE), `${kind}: "${name}" is not an ANSI colour name`).toContain(name);
    }
  });

  it('avoids everything near black and everything near white, because the background is unknown', () => {
    // This is the reported bug, as arithmetic. Plain `blue` sits at 0.029 — about 1.6:1 against
    // a black terminal, below any legibility floor — which is why the biggest segment of the
    // bar vanished. The ceiling rules out the other failure the same way: `yellowBright`
    // (0.934) and `cyanBright` (0.807) are invisible on a light terminal.
    for (const kind of SEGMENT_ORDER) {
      const { luminance } = entry(kind);
      expect(luminance, `${SEGMENT_COLOURS[kind]} is too dark for a dark terminal`).toBeGreaterThanOrEqual(0.12);
      expect(luminance, `${SEGMENT_COLOURS[kind]} is too light for a light terminal`).toBeLessThanOrEqual(0.45);
    }
  });

  it('draws the bar in hues, never in greys', () => {
    // A grey segment would carry no hue to contrast with its neighbours and would read as the
    // dim summary text sitting immediately to its right.
    for (const kind of SEGMENT_ORDER) {
      expect(entry(kind).hue, `${SEGMENT_COLOURS[kind]} has no hue`).toBeDefined();
    }
  });

  it('separates the two boundaries a live selection creates by at least a third of the wheel', () => {
    // These are the edges the user is reading: where what stays becomes what goes, and where
    // what goes becomes what is already free. The old scheme put `yellow` next to `green` —
    // 60° apart and near-equal in lightness — which is the muddy edge that was reported.
    expect(hueGap('used', 'reclaim'), 'used and this-selection are too close in hue').toBeGreaterThanOrEqual(120);
    expect(hueGap('reclaim', 'free'), 'this-selection and free are too close in hue').toBeGreaterThanOrEqual(120);
  });

  it('spends its one close hue pair on the boundary with the largest texture step', () => {
    // Three hues cannot all be 180° apart, so one pair is closest. That pair must be the one
    // whose glyphs differ most, so texture covers what hue cannot.
    const pairs: [BarKind, BarKind][] = [
      ['used', 'reclaim'],
      ['reclaim', 'free'],
      ['used', 'free'],
    ];
    const closest = pairs.reduce((best, pair) => (hueGap(...pair) < hueGap(...best) ? pair : best));
    const coarsest = pairs.reduce((best, pair) => (inkGap(...pair) > inkGap(...best) ? pair : best));
    expect(closest, `${closest.join('/')} is the closest hue pair but not the coarsest texture pair`).toEqual(
      coarsest,
    );
  });

  it('lets exactly one segment shout, and it is the one the user came for', () => {
    // The middle segment is what this selection would free — the answer, and the thing that
    // moves as boxes are checked. It gets the bright variant; the two context segments do not,
    // because three loud colours are the same as none.
    expect(SEGMENT_COLOURS.reclaim).toMatch(/Bright$/);
    expect(SEGMENT_COLOURS.used).not.toMatch(/Bright$/);
    expect(SEGMENT_COLOURS.free).not.toMatch(/Bright$/);
    expect(entry('reclaim').luminance).toBeGreaterThan(entry('free').luminance);
  });

  it('does not spend the hues that mean something else in this app', () => {
    // red is failure and yellow is warning everywhere else in dev-cleaner — including the
    // warning banner two rows above this bar on the confirmation screen. A big block of either
    // inside a disk gauge reads as an alarm rather than as a quantity.
    for (const kind of SEGMENT_ORDER) {
      expect(SEGMENT_COLOURS[kind], `${kind} uses a status hue`).not.toMatch(/^(red|yellow)(Bright)?$/);
    }
  });
});

describe('the legend stays in step with the bar', () => {
  it('lists the segments in the order they are drawn', () => {
    const drawn = barSegments(usage(500 * GB, 400 * GB), 60 * GB, 22).map((segment) => segment.kind);

    // Read the order back out of the legend text rather than trusting the list it was built
    // from: a legend that describes the segments right-to-left is a legend that lies.
    const listed = [...SEGMENT_ORDER].sort(
      (a, b) => BAR_LEGEND.indexOf(SEGMENT_LABELS[a]) - BAR_LEGEND.indexOf(SEGMENT_LABELS[b]),
    );
    expect(listed).toEqual(drawn);

    const positions = drawn.map((kind) => BAR_LEGEND.indexOf(SEGMENT_GLYPHS[kind]));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keys each entry on its glyph, so it can be matched to the bar without colour', () => {
    for (const kind of SEGMENT_ORDER) {
      expect(BAR_LEGEND, `${kind} is missing its glyph`).toContain(
        `${SEGMENT_GLYPHS[kind]} ${SEGMENT_LABELS[kind]}`,
      );
    }
    expect(BAR_LEGEND).not.toMatch(new RegExp(ANSI));
  });
});

describe('the gauge line itself', () => {
  it('is exactly one line, selection or no selection', () => {
    for (const reclaiming of [0, 1, 60 * GB, 900 * GB]) {
      expect(renderPlain(reclaiming).split('\n')).toHaveLength(1);
    }
  });

  it('says so plainly when the volume cannot be measured, instead of drawing a bar', () => {
    const instance = render(<Gauge usage={undefined} reclaiming={60 * GB} width={80} />);
    const frame = plain(instance.lastFrame());
    instance.unmount();
    expect(frame).toContain('unavailable');
    for (const kind of SEGMENT_ORDER) expect(frame).not.toContain(SEGMENT_GLYPHS[kind]);
  });

  it('never draws more cells than the terminal has columns', () => {
    for (const width of [0, 5, 12, 22, 40]) {
      const frame = renderPlain(60 * GB, width);
      for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});
