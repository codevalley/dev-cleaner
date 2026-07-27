/**
 * Emptying the Trash: the one action in this tool with no undo.
 *
 * Everything else dev-cleaner does is recoverable *because* it ends in the Trash. This is
 * where that recoverability is spent, and the interface has to be built around that fact
 * rather than around the convenience of the person pressing the key.
 *
 * # The number shown is the whole Trash, and that is not a detail
 *
 * The dangerous screen is the one right after a clean: it says "18.1G moved to the Trash",
 * and an offer to empty appears beneath it. That juxtaposition implies the offer empties
 * *this run's* 18.1 G. It does not, and it cannot — `trash.ts` explains at length why no
 * subset can be identified once an item is in there. Emptying takes the holiday photos too.
 *
 * So this pane shows `readTrashSummary`'s figures and refuses to show the round's.
 *
 * # Three panes, because there are three things that can be known
 *
 * `trash.ts` establishes that on a stock Mac the Trash usually *cannot* be measured: reading
 * `~/.Trash` needs Full Disk Access, and Finder — which has it — will report how many items
 * are in there but not how large they are. So this component renders one of three prompts:
 *
 * 1. **Measured.** The total is shown, prominently, and it is the whole Trash. This is the
 *    only pane that prints a byte figure.
 * 2. **Unseen, but emptiable.** No byte figure at all, because an understated total under a
 *    prompt that destroys everything is the one arrangement `trash.ts` forbids. What is shown
 *    instead is the truth: dev-cleaner cannot see inside, emptying takes all of it including
 *    whatever the user put there, and here is the permission that would let it show more.
 *    The offer stands, because withholding it does not protect anyone — it just leaves the
 *    reclaimed space unreclaimed and sends the user to Finder to do the same thing blind.
 * 3. **Nothing to offer.** `mayOfferEmpty` said no — an unsupported platform, or a summary
 *    that arrived without saying why it is empty-handed. No figure and no prompt.
 *
 * # Why the confirmation is a typed word
 *
 * Every other confirmation in this tool is `enter`, and `enter` is exactly what a user's
 * finger is already resting on when they arrive here — from the confirmation dialog, from the
 * round summary, from a key repeat that has not yet caught up with the screen. A yes/no
 * prompt answered by the key they have been pressing for the last four screens is not a
 * decision, it is a coincidence.
 *
 * Typing `empty` cannot be produced by a held key, cannot be produced by a double-tap, and
 * cannot be produced by any single keystroke at all. It is five deliberate acts, and the word
 * itself names what is about to happen. That is the entire justification: this is the one
 * place where making the user do more work is the correct design. It applies to pane 2 exactly
 * as it does to pane 1 — less is known there, not less is at stake.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { formatBytes, truncateLabel } from './format.js';
import { mayOfferEmpty, type TrashSummary } from '../trash.js';

/**
 * The word. A lone constant so there is exactly one string in the interface that unlocks the
 * irreversible action, and it is greppable — the same discipline `trash.ts` applies to the
 * AppleScript that performs it.
 */
export const EMPTY_TRASH_WORD = 'empty';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export interface TrashConfirmProps {
  summary: TrashSummary;
  /** What the user has typed so far. Compared for exact equality, never as a prefix. */
  typed: string;
  width: number;
}

/**
 * The prompt. Shows what emptying would destroy — all of it — and unlocks only on the word.
 *
 * `armed` is exported alongside so that "does this keystroke perform the deletion" is one
 * expression, asserted once, rather than a comparison repeated in the pane and in the input
 * handler where the two could drift apart. Whether an offer exists at all is `trash.ts`'s
 * call, not this file's: `mayOfferEmpty` is the single place that line is drawn.
 */
export function trashConfirmArmed(summary: TrashSummary, typed: string): boolean {
  return mayOfferEmpty(summary) && typed === EMPTY_TRASH_WORD;
}

/**
 * The five deliberate acts, and the footer that only names `enter` once they are done. Shared
 * by both offering panes so the measured and the unseen prompt cannot drift apart on the one
 * detail that decides whether a keystroke destroys anything.
 */
function TypedConfirmation({ typed, armed }: { typed: string; armed: boolean }): React.ReactElement {
  return (
    <>
      <Text> </Text>
      <Text>
        {'  type '}
        <Text bold color={armed ? 'green' : 'yellow'}>
          {EMPTY_TRASH_WORD}
        </Text>
        {' to confirm:  '}
        <Text bold>{typed.length === 0 ? '_' : typed}</Text>
      </Text>
      <Text> </Text>
      <Text dimColor>{armed ? 'enter empties the Trash · esc cancel' : 'esc cancel'}</Text>
    </>
  );
}

export function TrashConfirm({ summary, typed, width }: TrashConfirmProps): React.ReactElement {
  // Pane 3: nothing that can honestly be offered. See `mayOfferEmpty`.
  if (!mayOfferEmpty(summary)) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="yellow">
          Empty the Trash?
        </Text>
        <Text> </Text>
        <Text>
          {truncateLabel(
            'dev-cleaner could not read the Trash, so it cannot tell you what emptying would destroy.',
            width,
          )}
        </Text>
        <Text dimColor>
          {truncateLabel(
            summary.detail ??
              'Reading the Trash needs Full Disk Access on macOS. Empty it from Finder instead.',
            width,
          )}
        </Text>
        <Text> </Text>
        <Text dimColor>esc back</Text>
      </Box>
    );
  }

  const armed = trashConfirmArmed(summary, typed);

  // Pane 2: the offer stands, but no byte figure may appear anywhere on it. `summary.bytes` is
  // zero here because it is *unknown*, and printing it would be the understatement `trash.ts`
  // exists to prevent — so this branch does not read `summary.bytes` at all.
  if (!summary.available) {
    const counted = summary.knownItems;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">
          Empty the Trash? This cannot be undone.
        </Text>
        <Text> </Text>
        <Text bold>
          {counted === undefined
            ? '  Trash contents unknown — not the size, not even the item count.'
            : `  Finder counts ${plural(counted, 'item')} · size unknown`}
        </Text>
        <Text color="red">
          {truncateLabel(
            '  dev-cleaner cannot see inside the Trash or say what emptying takes.',
            width,
          )}
        </Text>
        <Text color="red">
          {truncateLabel(
            '  It takes everything in there, including what you put there yourself.',
            width,
          )}
        </Text>
        <Text dimColor>
          {truncateLabel('  Files removed this way cannot be recovered — there is no Put Back.', width)}
        </Text>
        {summary.detail === undefined ? null : (
          <Text dimColor>{truncateLabel(`  ${summary.detail}`, width)}</Text>
        )}
        <TypedConfirmation typed={typed} armed={armed} />
      </Box>
    );
  }

  // Pane 1: measured.
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="red">
        Empty the Trash? This cannot be undone.
      </Text>
      <Text> </Text>
      {/*
        The whole Trash, always — never this run's bytes. See the module note; this is the
        single most important line on the screen.
      */}
      <Text bold>
        {`  ${formatBytes(summary.bytes)} · ${plural(summary.items, 'item')} in the Trash`}
      </Text>
      <Text color="red">
        {truncateLabel(
          '  This is everything in the Trash, not only what dev-cleaner put there.',
          width,
        )}
      </Text>
      <Text dimColor>
        {truncateLabel('  Files removed this way cannot be recovered — there is no Put Back.', width)}
      </Text>
      <TypedConfirmation typed={typed} armed={armed} />
    </Box>
  );
}

export interface TrashResultProps {
  ok: boolean;
  detail: string | undefined;
  /** The Trash re-read after the attempt — never assumed from the attempt's own verdict. */
  summary: TrashSummary | undefined;
  width: number;
}

/**
 * What happened, read back from the Trash rather than inferred.
 *
 * `emptyTrash` returning `ok: false` is not proof that nothing happened — Finder may have
 * emptied part of it before erroring, and a timeout on a very large empty means "still
 * working" more often than it means "failed". So the pane reports the attempt's verdict *and*
 * a fresh reading, and lets them disagree on screen rather than picking one to believe.
 *
 * The re-read is subject to the same permissions as the first one, so it too may come back
 * countable-but-unmeasurable. A count is worth showing: "Finder counts 0 items" is the
 * confirmation the user came for even when no byte figure can accompany it.
 */
export function TrashResult({ ok, detail, summary, width }: TrashResultProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={ok ? 'green' : 'red'}>
        {ok ? 'Trash emptied.' : 'The Trash was not emptied.'}
      </Text>
      <Text> </Text>
      {detail === undefined ? null : (
        <Text dimColor>{truncateLabel(`  ${detail}`, width)}</Text>
      )}
      {summary !== undefined && summary.available ? (
        <Text>
          {`  ${formatBytes(summary.bytes)} · ${plural(summary.items, 'item')} in the Trash now`}
        </Text>
      ) : summary?.knownItems !== undefined ? (
        <Text>{`  Finder counts ${plural(summary.knownItems, 'item')} in the Trash now`}</Text>
      ) : (
        <Text dimColor>{'  dev-cleaner cannot read the Trash to confirm.'}</Text>
      )}
      <Text> </Text>
      <Text dimColor>esc back to the list · q quit</Text>
    </Box>
  );
}
