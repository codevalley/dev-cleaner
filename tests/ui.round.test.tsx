/**
 * The round summary, rendered directly.
 *
 * The first person to run this tool for real moved 107 GB to the Trash and was shown a terse
 * list of outcomes for it — no acknowledgement that anything had happened, and the number
 * they had come for set in the same weight as the word "directories". Their note was "no
 * delight moment with it just cleaned 100+ GB!! that should be celebrated".
 *
 * So this pane celebrates, and these tests are the boundary of how far it may go. Three
 * things are held:
 *
 * 1. **The celebration is proportionate.** 107 G is drawn five rows tall, ruled and marked;
 *    200 M gets a sentence. One fixed fanfare for both would make the big round feel routine
 *    and the small one feel oversold, and a tool that oversells a small result is a tool whose
 *    big results you stop believing.
 * 2. **The celebration is true.** The figure is the *trashed* one, never trashed-plus-refused,
 *    and nothing on the pane says the space is free — it is in the Trash, and the offer to
 *    empty it carries that fact rather than hiding it. A round that trashed 2 G and refused
 *    8 G celebrates 2 G and prints the refusal.
 * 3. **It costs nothing to see twice.** The pane renders its final content on its first frame:
 *    no reveal, no timer, no state. A celebration you have to wait out is an obstacle the
 *    second time, and this is a tool people run repeatedly in one session.
 *
 * The block font and the framed prompt are exercised here too, since this is where they are
 * defined and `Confirm` borrows them.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BIG_ROWS,
  RoundSummary,
  bigBytes,
  bigTextLines,
  celebrationFor,
  promptBox,
  sizeRow,
  type ProblemEntry,
  type RoundReport,
} from '../src/ui/Round.js';
import { formatBytes } from '../src/ui/format.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

/** The width `App` gives it on an 80-column terminal or wider. */
const WIDTH = 72;

type Instance = ReturnType<typeof render>;
const rendered: Instance[] = [];

afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

interface Options {
  reclaimedBytes?: number;
  trashed?: number;
  refused?: number;
  failed?: number;
  problems?: readonly ProblemEntry[];
  sessionBytes?: number;
  rounds?: number;
  width?: number;
  canEmptyTrash?: boolean;
}

function report(options: Options = {}): RoundReport {
  const reclaimedBytes = options.reclaimedBytes ?? 0;
  return {
    reclaimedBytes,
    trashed: options.trashed ?? (reclaimedBytes > 0 ? 1 : 0),
    refused: options.refused ?? 0,
    failed: options.failed ?? 0,
    problems: options.problems ?? [],
    sessionBytes: options.sessionBytes ?? reclaimedBytes,
    rounds: options.rounds ?? 1,
  };
}

/** Renders and returns the frame, colour codes removed. */
function show(options: Options = {}): string {
  const instance = render(
    <RoundSummary
      report={report(options)}
      width={options.width ?? WIDTH}
      canEmptyTrash={options.canEmptyTrash ?? true}
    />,
  );
  rendered.push(instance);
  return strip(instance.lastFrame() ?? '');
}

/** Colour codes are noise to a substring assertion, and absent or present by environment. */
function strip(frame: string): string {
  // Built from the code point so that no raw control byte hides in this source.
  return frame.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

const lines = (frame: string): string[] => frame.split('\n');

const lineOf = (frame: string, phrase: string): number =>
  lines(frame).findIndex((line) => line.includes(phrase));

/** How many rows of the block font for `text` are on screen. */
function bannerRowsOn(frame: string, text: string): number {
  const glyph = bigTextLines(text);
  if (glyph === undefined) return 0;
  const body = lines(frame);
  return glyph.filter((row) => body.some((line) => line.includes(row))).length;
}

const problem = (label: string, bytes: number, detail: string): ProblemEntry => ({
  id: label,
  label,
  bytes,
  outcome: 'refused',
  detail,
});

describe('the block font', () => {
  it('covers every character formatBytes can emit', () => {
    const figures = [512, 4 * KB, 900 * KB, 3.4 * MB, 99.9 * GB, 133 * GB, 7 * TB, 5 * TB * 1024];
    for (const bytes of figures) {
      const text = formatBytes(bytes);
      expect(bigTextLines(text), `${text} (${bytes} bytes)`).toBeDefined();
    }
  });

  it('refuses a character it has no glyph for, rather than punching a hole in the number', () => {
    expect(bigTextLines('107 G')).toBeUndefined();
    expect(bigTextLines('?')).toBeUndefined();
    expect(bigTextLines('')).toBeUndefined();
  });

  it('is the same height whatever it draws', () => {
    for (const text of ['0B', '107G', '99.9G', '1023M']) {
      expect(bigTextLines(text)).toHaveLength(BIG_ROWS);
    }
  });

  /**
   * Ten digits, ten shapes. A font where 6 and 8 come out identical turns a 68 G round into an
   * unreadable one, and at five rows the collisions are easy to introduce by accident.
   */
  it('gives every digit a shape of its own', () => {
    const shapes = new Set(
      Array.from({ length: 10 }, (_, digit) => (bigTextLines(String(digit)) ?? []).join('/')),
    );
    expect(shapes.size).toBe(10);
  });

  it('declines to draw a banner wider than the pane it is drawn in', () => {
    // 107G is fifteen columns of glyph plus the two it is indented by.
    expect(bigBytes(107 * GB, 17)).toBeDefined();
    expect(bigBytes(107 * GB, 16)).toBeUndefined();
  });
});

describe('the framed prompt', () => {
  it('pads its lines to a common width inside the frame', () => {
    const box = promptBox(['a', 'a much longer line'], 40);

    expect(box).toHaveLength(4);
    for (const line of box) expect(line.length).toBe(40);
    expect(box[0]).toContain('╭');
    expect(box[3]).toContain('╰');
  });

  it('drops the frame rather than overflow a pane too narrow to hold one', () => {
    const box = promptBox(['esc back'], 10);

    expect(box).toEqual(['esc back']);
    expect(box.join('')).not.toContain('╭');
  });
});

describe('a size row', () => {
  it('stays inside the width at every width', () => {
    for (let width = 6; width <= 72; width += 1) {
      const row = sizeRow('  ! ', 'a-project/node_modules', 67 * GB, width);
      expect(row.length, `at ${width} columns`).toBeLessThanOrEqual(width);
    }
  });
});

describe('the celebration is proportionate', () => {
  it('draws the freshly trashed figure five rows tall', () => {
    const frame = show({ reclaimedBytes: 107 * GB, trashed: 41 });

    expect(bannerRowsOn(frame, '107G')).toBe(BIG_ROWS);
    // And the sentence a screen reader or a grep would find is still there.
    expect(frame).toContain('Moved 107G to the Trash.');
    expect(frame).toContain('41 directories trashed');
  });

  it('scales fanfare from a small reclaim up to a hundred gigabytes', () => {
    const huge = show({ reclaimedBytes: 107 * GB, trashed: 41 });
    const big = show({ reclaimedBytes: 40 * GB, trashed: 9 });
    const good = show({ reclaimedBytes: 2 * GB, trashed: 2 });
    const modest = show({ reclaimedBytes: 200 * MB, trashed: 3 });

    expect(huge).toContain('✦ ✦ ✦');
    expect(huge).toContain('An enormous round.');
    expect(huge).toContain('━');

    expect(big).toContain('✦ ✦');
    expect(big).toContain('An enormous round.');
    expect(big).toContain('━');

    expect(good).toContain('✦ ✦');
    expect(good).toContain('A big round.');
    expect(good).not.toContain('━');

    expect(modest).toContain('Moved 200M to the Trash.');
    expect(modest).toContain('A good round.');
    expect(modest).toContain('█');
    expect(celebrationFor(200 * MB).big).toBe(true);
  });

  it('still celebrates a tiny reclaim with a figure', () => {
    const frame = show({ reclaimedBytes: 50 * MB, trashed: 1 });
    expect(frame).toContain('Moved 50.0M to the Trash.');
    expect(frame).toContain('Nice catch.');
    expect(celebrationFor(50 * MB).big).toBe(true);
  });

  it('ranks the number above the words: the banner comes first', () => {
    const frame = show({ reclaimedBytes: 107 * GB, trashed: 41 });
    const top = (bigTextLines('107G') ?? [])[0] as string;

    expect(lineOf(frame, top)).toBeLessThan(lineOf(frame, 'Moved 107G to the Trash.'));
  });
});

describe('the celebration is true', () => {
  /**
   * The pinned arithmetic, restated as a picture. A banner drawn from trashed-plus-refused
   * would show 10.0G here, the user would empty the Trash expecting 10 G back and get 2 G,
   * and every refusal this tool prints afterwards would be read as noise.
   */
  it('celebrates only what moved, and prints what did not', () => {
    const frame = show({
      reclaimedBytes: 2 * GB,
      trashed: 1,
      refused: 1,
      problems: [problem('pnpm store', 8 * GB, 'a node_modules still links into it')],
    });

    expect(bannerRowsOn(frame, '2.0G')).toBe(BIG_ROWS);
    expect(bannerRowsOn(frame, '10.0G')).toBeLessThan(BIG_ROWS);
    expect(frame).toContain('Moved 2.0G to the Trash.');
    expect(frame).not.toContain('10.0G');

    expect(frame).toContain('Left in place · 1 item — not in the total above');
    expect(frame).toContain('pnpm store');
    expect(frame).toContain('8.0G');
    expect(frame).toContain('a node_modules still links into it');
    expect(frame).toContain('1 directory trashed · 1 refused');
  });

  it('keeps a failure as visible as a refusal', () => {
    const frame = show({
      reclaimedBytes: 3 * GB,
      trashed: 1,
      failed: 1,
      problems: [
        { id: 'x', label: 'weft/target', bytes: GB, outcome: 'failed', detail: 'EPERM on rename' },
      ],
    });

    expect(frame).toContain('1 failed');
    expect(frame).toContain('weft/target');
    expect(frame).toContain('EPERM on rename');
  });

  it('celebrates nothing when nothing moved', () => {
    const frame = show({
      reclaimedBytes: 0,
      trashed: 0,
      refused: 2,
      problems: [problem('bump/build', 8 * GB, 'a linked git worktree')],
    });

    expect(frame).toContain('Nothing was moved to the Trash.');
    expect(frame).not.toContain('✦');
    expect(frame).not.toContain('█');
    expect(frame).toContain('Left in place');
  });

  /**
   * The bytes are still on the volume. Nothing here may say otherwise — the word this pane is
   * one careless edit away from is "freed", and `report.ts` and `trash.ts` both refuse it for
   * the same reason.
   */
  it('never claims the space is back', () => {
    const frame = show({ reclaimedBytes: 107 * GB, trashed: 41 });

    expect(frame).not.toMatch(/freed|reclaimed|recovered/i);
    expect(frame).toContain('the space is not free until you do');
  });
});

describe('emptying the Trash is the obvious next thing', () => {
  it('offers it in a frame, with the disclosure riding on the offer', () => {
    const frame = show({ reclaimedBytes: 107 * GB, trashed: 41, canEmptyTrash: true });
    const at = lineOf(frame, 't empty the Trash');

    expect(at).toBeGreaterThan(0);
    expect(lines(frame)[at - 1]).toContain('╭');
    expect(lines(frame)[at + 1]).toContain('╰');
    expect(lines(frame)[at]).toContain('the space is not free until you do');
  });

  it('states the disclosure anyway when it cannot offer the empty', () => {
    const frame = show({ reclaimedBytes: 107 * GB, trashed: 41, canEmptyTrash: false });

    expect(frame).not.toContain('t empty the Trash');
    expect(frame).toContain('Trash still holds the space until you empty it.');
  });

  it('asks for any key to continue (not a commit key)', () => {
    const frame = show({ reclaimedBytes: 3 * GB });

    expect(frame).toContain('press any key to continue');
    expect(frame).not.toMatch(/\benter\b/);
  });

  it('states the running session total from the second round on', () => {
    expect(show({ reclaimedBytes: 5 * GB, sessionBytes: 14 * GB, rounds: 2 })).toContain(
      '14.0G trashed this session · 2 rounds',
    );
    // On a first round it would only restate the figure above it.
    expect(show({ reclaimedBytes: 5 * GB, rounds: 1 })).not.toContain('this session');
  });
});

/**
 * A celebration you have to sit through becomes an obstacle the second time you see it, and a
 * user cleaning 133 GB sees this pane three or four times in one sitting.
 */
describe('it costs nothing to see twice', () => {
  it('renders its final content on the very first frame', () => {
    const instance = render(
      <RoundSummary
        report={report({ reclaimedBytes: 107 * GB, trashed: 41 })}
        width={WIDTH}
        canEmptyTrash
      />,
    );
    rendered.push(instance);

    // No await, no timer advance: whatever a staged reveal would still be hiding is here now.
    const first = strip(instance.frames[0] ?? '');
    expect(bannerRowsOn(first, '107G')).toBe(BIG_ROWS);
    expect(first).toContain('Moved 107G to the Trash.');
    expect(first).toContain('An enormous round.');
    expect(first).toContain('press any key to continue');
  });
});

describe('it degrades', () => {
  it.each([16, 24, 36, 72])('fits inside %i columns', (width) => {
    const frame = show({
      reclaimedBytes: 107 * GB,
      trashed: 41,
      refused: 1,
      problems: [problem('a-project/node_modules', 8 * GB, 'a node_modules still links into it')],
      sessionBytes: 133 * GB,
      rounds: 2,
      width,
    });

    // `paddingX={1}` on the pane, so the budget is the declared width plus its two columns.
    for (const line of lines(frame)) {
      expect(line.length, `"${line}" at ${width} columns`).toBeLessThanOrEqual(width + 2);
    }
    expect(frame).toContain('107G');
  });

  it.each([12, 16, 20, 24])('fits inside %i rows when height is capped', (height) => {
    const instance = render(
      <RoundSummary
        report={report({
          reclaimedBytes: 107 * GB,
          trashed: 41,
          refused: 3,
          problems: Array.from({ length: 8 }, (_, i) =>
            problem(`proj-${i}/target`, GB, 'nested repository'),
          ),
          sessionBytes: 133 * GB,
          rounds: 2,
        })}
        width={WIDTH}
        height={height}
        canEmptyTrash
      />,
    );
    rendered.push(instance);
    const frame = strip(instance.lastFrame() ?? '');
    expect(lines(frame).length, `${height} rows`).toBeLessThanOrEqual(height);
    expect(frame).toContain('Moved');
    expect(frame).toContain('press any key to continue');
  });

  it('drops the banner rather than wrap it, and keeps the sentence', () => {
    const narrow = show({ reclaimedBytes: 107 * GB, trashed: 41, width: 16 });
    const wide = show({ reclaimedBytes: 107 * GB, trashed: 41, width: 72 });

    expect(narrow).not.toContain('█');
    expect(narrow).toContain('107G');
    expect(wide).toContain('█');
  });
});
