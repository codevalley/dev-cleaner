/**
 * The confirmation screen, rendered directly.
 *
 * `App` decides *what* is deletable (by running the deletion boundary's own guards over the
 * frozen snapshot); this component decides what the user is told about it, and that is the
 * whole of what these tests hold:
 *
 * 1. **The headline counts what will be trashed and nothing else.** A user who reads a total
 *    and receives a smaller one has been taught that the tool's numbers are approximate and
 *    its refusals are noise. The blocked bytes are handed in separately precisely so that
 *    adding them to the headline has to be a deliberate act.
 * 2. **Blocked rows are shown, distinctly, with a reason.** Excluding them from the total is
 *    only half the fix — a total that silently drops 75 G is a number the user cannot
 *    reconcile with the list they were looking at a moment ago. Naming the shortfall is what
 *    turns "the tool undercounted" into "the tool explained itself".
 * 3. **A screen with nothing left to trash does not ask for consent.** There is no question
 *    to answer, and offering one leads to a clean of zero targets reported as "nothing was
 *    selected" to a user who selected plenty.
 * 4. **It reads as a question.** The first user to reach this screen did not realise it was
 *    waiting for them: the figure they had come for was set in the same weight as everything
 *    else, and the choice was dim grey at the bottom, where every other pane puts decoration.
 *    So the last three blocks below are about *rank* — that the amount is drawn large, that
 *    the choice is framed and sits above the supporting list rather than under it, and that
 *    the caveat is stated once, next to the figure it qualifies.
 *
 * Rendered through `ink-testing-library` rather than asserted as props, because every one of
 * these claims is about what reaches the user's eyes.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { Confirm, type BlockedEntry, type ConfirmEntry } from '../src/ui/Confirm.js';
import { BIG_ROWS, bigTextLines } from '../src/ui/Round.js';
import type { Refusal } from '../src/types.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** The width `App` gives it on an 80-column terminal or wider. */
const WIDTH = 56;

type Instance = ReturnType<typeof render>;
const rendered: Instance[] = [];

afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

const entry = (label: string, bytes: number): ConfirmEntry => ({ id: label, label, bytes });

const blocked = (label: string, bytes: number, refusal: Refusal): BlockedEntry => ({
  id: label,
  label,
  bytes,
  refusal,
});

interface Props {
  entries?: readonly ConfirmEntry[];
  blocked?: readonly BlockedEntry[];
  targetCount?: number;
  bytes?: number;
  blockedBytes?: number;
  width?: number;
}

/** Renders with the totals derived from the lists, so a test states only what it varies. */
function show(props: Props = {}): string {
  const entries = props.entries ?? [];
  const blockedEntries = props.blocked ?? [];
  const instance = render(
    <Confirm
      entries={entries}
      blocked={blockedEntries}
      targetCount={props.targetCount ?? entries.length}
      bytes={props.bytes ?? entries.reduce((sum, item) => sum + item.bytes, 0)}
      blockedBytes={
        props.blockedBytes ?? blockedEntries.reduce((sum, item) => sum + item.bytes, 0)
      }
      width={props.width ?? WIDTH}
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

/** The physical lines of a frame — what a terminal would actually have to fit. */
const lines = (frame: string): string[] => frame.split('\n');

/** Where a phrase first lands, as a line number. `-1` when it is not on screen at all. */
const lineOf = (frame: string, phrase: string): number =>
  lines(frame).findIndex((line) => line.includes(phrase));

/** How many rows of the block font for `text` are on screen. */
function bannerRowsOn(frame: string, text: string): number {
  const glyph = bigTextLines(text);
  if (glyph === undefined) return 0;
  const body = lines(frame);
  return glyph.filter((row) => body.some((line) => line.includes(row))).length;
}

describe('the headline counts only what will be trashed', () => {
  it('excludes blocked bytes and blocked directories from the total', () => {
    const frame = show({
      entries: [entry('tinysync/dist', 3 * GB), entry('npm cache', 2 * GB)],
      blocked: [
        blocked('tinysync/target', 67 * GB, 'contains-repository'),
        blocked('pnpm store', 8 * GB, 'store-prune-unsafe'),
      ],
    });

    expect(frame).toContain('5.0G across 2 directories');
    // The two numbers a folded-in total would produce, neither of which is true.
    expect(frame).not.toContain('80.0G across');
    expect(frame).not.toContain('4 directories');
  });

  it('still discloses that the Trash holds the space until it is emptied', () => {
    expect(show({ entries: [entry('bump/dist', GB)] })).toContain(
      'Trash still holds the space until you empty it.',
    );
  });

  it('agrees with itself when nothing is blocked', () => {
    const frame = show({ entries: [entry('bump/dist', 3 * GB)] });
    expect(frame).toContain('3.0G across 1 directory');
    expect(frame).not.toContain('Blocked');
  });
});

describe('blocked rows are shown, not merely subtracted', () => {
  it('names each one, with its size and its reason', () => {
    const frame = show({
      entries: [entry('npm cache', 2 * GB)],
      blocked: [
        blocked('tinysync/target', 67 * GB, 'contains-repository'),
        blocked('pnpm store', 8 * GB, 'store-prune-unsafe'),
      ],
    });

    expect(frame).toContain('Blocked · 2 items · 75.0G');
    expect(frame).toContain('not in the total above');
    expect(frame).toContain('tinysync/target');
    expect(frame).toContain('67.0G');
    expect(frame).toContain('holds a git repository');
    expect(frame).toContain('pnpm store');
    expect(frame).toContain('8.0G');
    expect(frame).toContain('a node_modules still links into it');
  });

  /**
   * Every refusal the boundary can produce has to arrive as something a person can read. The
   * codes are fine in a log and useless on a confirmation screen — `worktree-root` is not a
   * reason, it is a label for one — so each is asserted to be replaced, and to be replaced by
   * something of its own rather than by one generic sentence eight times.
   */
  const ALL_REFUSALS: readonly Refusal[] = [
    'not-in-artifact-table',
    'outside-project-root',
    'symlink',
    'guarded-path',
    'worktree-root',
    'unknown-cache',
    'store-prune-unsafe',
    'contains-repository',
  ];

  const reasonFor = (refusal: Refusal): string => {
    const frame = show({ blocked: [blocked('a-row', GB, refusal)] });
    const body = lines(frame);
    const at = body.findIndex((line) => line.includes('a-row'));
    return (body[at + 1] ?? '').trim();
  };

  it('explains every refusal in words, and each one differently', () => {
    const reasons = ALL_REFUSALS.map(reasonFor);

    for (const [index, reason] of reasons.entries()) {
      const refusal = ALL_REFUSALS[index] as Refusal;
      expect(reason.length).toBeGreaterThan(0);
      expect(reason).not.toBe(refusal);
      expect(reason).not.toContain(refusal);
    }
    expect(new Set(reasons).size).toBe(ALL_REFUSALS.length);
  });

  it('summarises a blocked list too long to read', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      blocked(`blocked-${index}`, GB, 'symlink'),
    );
    const frame = show({ entries: [entry('kept', GB)], blocked: many });

    expect(frame).toContain('Blocked · 9 items');
    expect(frame).toContain('blocked-0');
    expect(frame).toContain('…and 5 more blocked');
    expect(frame).not.toContain('blocked-8');
  });

  it('summarises a kept list too long to read', () => {
    const many = Array.from({ length: 14 }, (_, index) => entry(`kept-${index}`, GB));
    const frame = show({ entries: many });

    expect(frame).toContain('kept-0');
    expect(frame).toContain('…and 8 more');
    expect(frame).not.toContain('kept-13');
    expect(frame).toContain('14.0G across 14 directories');
  });
});

describe('a screen with nothing left to trash', () => {
  it('says so, and offers no confirmation to give', () => {
    const frame = show({
      blocked: [
        blocked('tinysync/target', 67 * GB, 'contains-repository'),
        blocked('bump/build', 3 * GB, 'worktree-root'),
      ],
    });

    expect(frame).toContain('Nothing here can be moved to the Trash.');
    expect(frame).toContain('0B across 0 directories');
    expect(frame).toContain('Blocked · 2 items · 70.0G');
    expect(frame).toContain('a linked git worktree');
    // The key that spends consent is not offered when there is nothing to spend it on.
    expect(frame).not.toContain('enter');
    expect(frame).toMatch(/esc\s+back/);
  });

  it('offers the confirmation as soon as one directory survives', () => {
    const frame = show({
      entries: [entry('bump/dist', GB)],
      blocked: [blocked('tinysync/target', 67 * GB, 'contains-repository')],
    });

    expect(frame).toMatch(/enter\s+yes/);
    expect(frame).toMatch(/esc\s+no/);
    expect(frame).not.toContain('Nothing here can be moved to the Trash.');
  });

  /**
   * A giant `0B` above a framed prompt is a celebration of nothing, and the frame it would
   * sit in is the one shape on this screen that means "answer me".
   */
  it('draws no banner over a screen that frees nothing', () => {
    const frame = show({ blocked: [blocked('bump/build', 3 * GB, 'worktree-root')] });
    expect(bannerRowsOn(frame, '0B')).toBe(0);
  });
});

/**
 * The number is why the user is here. Before this it was one bold line among five, below a
 * gauge and above a caveat; the user's report was that it "is not very prominent". It is now
 * five rows tall, and these tests hold it to being *that figure* — the one the headline
 * states — at that size.
 */
describe('the amount is the biggest thing on the screen', () => {
  it('draws the total in a block font, five rows tall', () => {
    const frame = show({
      entries: [entry('tinysync/target', 67 * GB), entry('bump/node_modules', 40 * GB)],
      targetCount: 41,
    });

    expect(bannerRowsOn(frame, '107G')).toBe(BIG_ROWS);
    // And the plain figure is still there for anything reading the frame as text.
    expect(frame).toContain('107G across 41 directories');
  });

  it('draws the figure the headline states, never the blocked total', () => {
    const frame = show({
      entries: [entry('npm cache', 5 * GB)],
      blocked: [blocked('tinysync/target', 75 * GB, 'contains-repository')],
    });

    expect(bannerRowsOn(frame, '5.0G')).toBe(BIG_ROWS);
    // 80.0G is what a banner drawn from `bytes + blockedBytes` would show.
    expect(bannerRowsOn(frame, '80.0G')).toBeLessThan(BIG_ROWS);
  });

  it('sits between the question and the choice, not below the detail', () => {
    const frame = show({ entries: [entry('bump/dist', 3 * GB)] });
    const banner = (bigTextLines('3.0G') ?? [])[0] as string;

    expect(lineOf(frame, 'Move to Trash?')).toBeLessThan(lineOf(frame, banner));
    expect(lineOf(frame, banner)).toBeLessThan(lineOf(frame, 'enter'));
  });

  it('falls back to plain text rather than wrap a banner that will not fit', () => {
    const frame = show({ entries: [entry('bump/dist', 3 * GB)], width: 10 });

    expect(frame).not.toContain('█');
    expect(frame).toContain('3.0G');
    for (const line of lines(frame)) expect(line.length).toBeLessThanOrEqual(12);
  });
});

/**
 * "The second screen is even more confusing. I didn't even realize it was waiting for my
 * input." The keys have not changed — `enter` confirms, `esc` cancels — but where they are
 * said has, and that is what these hold.
 */
describe('the choice reads as a choice', () => {
  it('frames it, so it cannot be read as a status line', () => {
    const frame = show({ entries: [entry('bump/dist', 3 * GB)] });
    const at = lineOf(frame, 'enter');

    expect(at).toBeGreaterThan(0);
    expect(lines(frame)[at - 1]).toContain('╭');
    expect(lines(frame)[at + 2]).toContain('╰');
  });

  it('answers the question in the answer: yes moves this much', () => {
    expect(show({ entries: [entry('bump/dist', 3 * GB)] })).toContain(
      'yes — move 3.0G to the Trash',
    );
  });

  it('puts the choice above the list of directories it is a choice about', () => {
    const frame = show({
      entries: [entry('first-row', 3 * GB), entry('second-row', GB)],
      blocked: [blocked('blocked-row', GB, 'symlink')],
    });

    expect(lineOf(frame, 'enter')).toBeLessThan(lineOf(frame, 'first-row'));
    expect(lineOf(frame, 'enter')).toBeLessThan(lineOf(frame, 'blocked-row'));
  });

  it('does not bury the same keys in a dim footer as well', () => {
    const frame = show({ entries: [entry('bump/dist', 3 * GB)] });
    expect(lines(frame).filter((line) => line.includes('enter'))).toHaveLength(1);
  });
});

/**
 * Invariant 8's disclosure, said once. Twice — beside the total *and* beside the choice —
 * would only teach the reader that the small print on this screen is boilerplate, and the
 * one place it has to be believed is next to the figure it qualifies.
 */
describe('the caveat is stated once, next to the figure it qualifies', () => {
  it('appears exactly once, on the line under the total', () => {
    const frame = show({
      entries: [entry('bump/dist', 3 * GB)],
      blocked: [blocked('tinysync/target', GB, 'symlink')],
    });

    const caveats = lines(frame).filter((line) => line.includes('Trash still holds the space'));
    expect(caveats).toHaveLength(1);
    expect(lineOf(frame, 'Trash still holds the space')).toBe(
      lineOf(frame, '3.0G across 1 directory') + 1,
    );
  });
});

/**
 * A confirmation that wraps is a confirmation that has to be reassembled by eye before it can
 * be answered, and this one is answered by pressing a key that deletes things.
 */
describe('it degrades', () => {
  it.each([16, 24, 36, 56])('fits inside %i columns, banner or no banner', (width) => {
    const frame = show({
      entries: [entry('tinysync/target-with-a-long-name', 67 * GB), entry('npm cache', 3 * GB)],
      blocked: [blocked('pnpm store', 8 * GB, 'store-prune-unsafe')],
      width,
    });

    // `paddingX={1}` on the pane, so the budget is the declared width plus its two columns.
    for (const line of lines(frame)) {
      expect(line.length, `"${line}" at ${width} columns`).toBeLessThanOrEqual(width + 2);
    }
    // Narrow or not, the three things that matter are still legible as text.
    expect(frame).toContain('Move to Trash?');
    expect(frame).toContain('70.0G');
    expect(frame).toMatch(/enter\s+yes/);
  });
});
