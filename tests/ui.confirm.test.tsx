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
 *
 * Rendered through `ink-testing-library` rather than asserted as props, because every one of
 * these claims is about what reaches the user's eyes.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { Confirm, type BlockedEntry, type ConfirmEntry } from '../src/ui/Confirm.js';
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
      width={WIDTH}
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
    expect(frame).toContain('not in the total below');
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
    const lines = frame.split('\n');
    const at = lines.findIndex((line) => line.includes('a-row'));
    return (lines[at + 1] ?? '').trim();
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
    expect(frame).toContain('…and 3 more blocked');
    expect(frame).not.toContain('blocked-8');
  });

  it('summarises a kept list too long to read', () => {
    const many = Array.from({ length: 14 }, (_, index) => entry(`kept-${index}`, GB));
    const frame = show({ entries: many });

    expect(frame).toContain('kept-0');
    expect(frame).toContain('…and 2 more');
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
    expect(frame).not.toContain('enter confirm');
    expect(frame).toContain('esc back');
  });

  it('offers the confirmation as soon as one directory survives', () => {
    const frame = show({
      entries: [entry('bump/dist', GB)],
      blocked: [blocked('tinysync/target', 67 * GB, 'contains-repository')],
    });

    expect(frame).toContain('enter confirm · esc cancel · q quit');
    expect(frame).not.toContain('Nothing here can be moved to the Trash.');
  });
});
