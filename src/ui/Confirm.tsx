/**
 * The second confirmation. `enter` in the list opens this; `enter` here is what actually
 * runs `clean`.
 *
 * It lists what will be trashed per *row* rather than per `CleanTarget`: a user recognises
 * "tinysync 67.0G", not "tinysync/apps/macos/build". The target count is still shown, so
 * the number of separate deletes is never hidden behind a tidy summary.
 *
 * ## The blocked list, and why the headline must not include it
 *
 * This is the screen the user answers, so it is the screen that has to be true. Everything
 * `clean.ts` would refuse has already been established by `screenTargets` before this
 * component renders (see `App.tsx`), and the results arrive here as two disjoint lists:
 * `entries`, which will be trashed, and `blocked`, which will not.
 *
 * The headline totals `entries` **only**. A user who reads "18.4G across 7 directories" and
 * receives 10.9G has been told a number the tool never intended to deliver; the second time
 * that happens they stop reading the refusals at all, which is the same failure `clean.ts`
 * names from the other side ("a guard nobody can satisfy is a guard that gets switched
 * off"). Blocked rows are still *shown* — with their size and their reason — because
 * silently dropping 7.5G from a total the section headers said was there is its own kind of
 * lie. Stated and excluded; never counted and refused.
 *
 * When `entries` is empty every selected directory was blocked. The screen then offers no
 * confirmation at all: there is nothing to consent to, and an `enter` that ran a clean of
 * zero targets would report "nothing was selected" for a user who selected plenty.
 *
 * ## The reason is the code, not the sentence
 *
 * A `Refusal` is rendered through `REASONS` rather than by printing the boundary's `detail`
 * string. The details are full sentences carrying absolute paths — right for the report and
 * the post-run summary, which are read in a pager — and this box is 56 columns wide, where
 * they would wrap into an unreadable block. `REASONS` is a total `Record`, so a new
 * `Refusal` that reaches the user without a phrase is a compile error rather than a blank.
 *
 * The Trash disclosure appears here as well as in the post-run summary (invariant 8). A
 * user deciding whether to proceed is exactly who needs to know that the space does not
 * come back until the Trash is emptied.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { BYTES_WIDTH, formatBytes, formatBytesPadded, padLabel } from './format.js';
import type { Refusal } from '../types.js';

/** Beyond this, the list is summarised — a confirmation nobody can read is not one. */
const MAX_LISTED = 12;
/** Blocked entries cost two lines each (the row and its reason), so fewer of them fit. */
const MAX_BLOCKED_LISTED = 6;

/**
 * Every refusal, in one short phrase. Total by construction: a `Refusal` added to
 * `types.ts` without a phrase here fails to compile, which is the only way to be sure the
 * user is never shown a blocked row with nothing said about why.
 */
const REASONS: Record<Refusal, string> = {
  'not-in-artifact-table': 'not a name the artifact table claims',
  'outside-project-root': 'outside its project root',
  symlink: 'a symbolic link is on its path',
  'guarded-path': 'a protected path',
  'worktree-root': 'a linked git worktree',
  'unknown-cache': 'not a cache this scan found',
  'store-prune-unsafe': 'a node_modules still links into it',
  'contains-repository': 'holds a git repository',
};

/** One line of the confirmation: a label and a size, already screened. */
export interface ConfirmEntry {
  id: string;
  label: string;
  bytes: number;
}

/** An entry the deletion boundary would refuse, with the code that says why. */
export interface BlockedEntry extends ConfirmEntry {
  refusal: Refusal;
}

export interface ConfirmProps {
  /** What will actually be trashed, one line per row. */
  entries: readonly ConfirmEntry[];
  /** What was selected and will not be trashed. Never counted into `bytes`. */
  blocked: readonly BlockedEntry[];
  /** Number of directories that will actually be trashed. */
  targetCount: number;
  /** Bytes of those directories, and of nothing else. */
  bytes: number;
  blockedBytes: number;
  width: number;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function Confirm({
  entries,
  blocked,
  targetCount,
  bytes,
  blockedBytes,
  width,
}: ConfirmProps): React.ReactElement {
  const listed = entries.slice(0, MAX_LISTED);
  const hidden = entries.length - listed.length;
  const listedBlocked = blocked.slice(0, MAX_BLOCKED_LISTED);
  const hiddenBlocked = blocked.length - listedBlocked.length;
  const labelWidth = Math.max(12, width - BYTES_WIDTH - 4);
  const nothingToDo = entries.length === 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="yellow">
        Move to Trash?
      </Text>
      <Text> </Text>
      {listed.map((entry) => (
        <Text key={entry.id}>
          {`  ${padLabel(entry.label, labelWidth)} ${formatBytesPadded(entry.bytes)}`}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>{`  …and ${hidden} more`}</Text> : null}
      {nothingToDo ? (
        <Text color="red">{'  Nothing here can be moved to the Trash.'}</Text>
      ) : null}
      {blocked.length === 0 ? null : (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold color="red">
            {`  Blocked · ${plural(blocked.length, 'item')} · ${formatBytes(blockedBytes)}` +
              ' — not in the total below'}
          </Text>
          {listedBlocked.flatMap((entry) => [
            <Text key={`${entry.id}:row`} color="red">
              {`  ! ${padLabel(entry.label, Math.max(10, labelWidth - 2))} ${formatBytesPadded(entry.bytes)}`}
            </Text>,
            <Text key={`${entry.id}:why`} dimColor>
              {`      ${REASONS[entry.refusal]}`}
            </Text>,
          ])}
          {hiddenBlocked > 0 ? (
            <Text dimColor>{`  …and ${hiddenBlocked} more blocked`}</Text>
          ) : null}
        </Box>
      )}
      <Text> </Text>
      <Text bold>
        {`  ${formatBytes(bytes)} across ${targetCount} ${targetCount === 1 ? 'directory' : 'directories'}`}
      </Text>
      <Text dimColor>{'  Trash still holds the space until you empty it.'}</Text>
      <Text> </Text>
      <Text dimColor>{nothingToDo ? 'esc back · q quit' : 'enter confirm · esc cancel · q quit'}</Text>
    </Box>
  );
}
