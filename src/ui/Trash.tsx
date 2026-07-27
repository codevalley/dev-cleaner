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
 * So this pane shows `readTrashSummary`'s figures and refuses to show the round's. The user
 * must be able to see the photos in the number before they agree to destroy them. When the
 * summary reports `available: false` the total is *unknown*, not zero, and the pane offers no
 * empty at all: an understated figure under a prompt that destroys everything is the one
 * arrangement `trash.ts` says must never be rendered.
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
 * place where making the user do more work is the correct design.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { formatBytes, truncateLabel } from './format.js';
import type { TrashSummary } from '../trash.js';

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
 * handler where the two could drift apart.
 */
export function trashConfirmArmed(summary: TrashSummary, typed: string): boolean {
  return summary.available && typed === EMPTY_TRASH_WORD;
}

export function TrashConfirm({ summary, typed, width }: TrashConfirmProps): React.ReactElement {
  if (!summary.available) {
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
      <Text dimColor>
        {armed ? 'enter empties the Trash · esc cancel' : 'esc cancel'}
      </Text>
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
      {summary === undefined || !summary.available ? (
        <Text dimColor>{'  dev-cleaner cannot read the Trash to confirm.'}</Text>
      ) : (
        <Text>
          {`  ${formatBytes(summary.bytes)} · ${plural(summary.items, 'item')} in the Trash now`}
        </Text>
      )}
      <Text> </Text>
      <Text dimColor>esc back to the list · q quit</Text>
    </Box>
  );
}
