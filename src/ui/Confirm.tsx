/**
 * The second confirmation. `enter` in the list opens this; `enter` here is what actually
 * runs `clean`.
 *
 * It lists what will be trashed per *row* rather than per `CleanTarget`: a user recognises
 * "tinysync 67.0G", not "tinysync/apps/macos/build". The target count is still shown, so
 * the number of separate deletes is never hidden behind a tidy summary.
 *
 * ## This screen has to look like a question
 *
 * The first user to reach it did not realise it was waiting for them. That is the worst
 * failure a confirmation can have, and it was earned: a quiet heading, a plain list, a total
 * in the same weight as everything else, and the choice itself in dim grey at the bottom, the
 * position the eye has been trained by every other pane to read as decoration.
 *
 * So the pane is ordered by what the user came for, not by convention:
 *
 * 1. **The question**, first and bold.
 * 2. **What it frees**, in a block font. This is the number they opened the tool to see; at
 *    five rows tall it is not something a person scrolls past.
 * 3. **The choice**, framed, immediately under the number and *above* the detail. A boxed
 *    prompt in the middle of the pane cannot be read as a status bar. Putting it before the
 *    list is deliberate: the list is supporting evidence for an answer, and evidence goes
 *    after the thing it supports.
 * 4. **What moves**, then what will not.
 *
 * The Trash disclosure (invariant 8) is stated once, on the line under the total, where it
 * qualifies the figure it applies to. Repeating it beside the choice would only teach the
 * reader that the small print on this screen is boilerplate.
 *
 * `enter` still confirms and `esc` still cancels; nothing about the keys has moved. What
 * changed is that the screen now says so where the user is looking.
 *
 * ## The blocked list, and why the headline must not include it
 *
 * This is the screen the user answers, so it is the screen that has to be true. Everything
 * `clean.ts` would refuse has already been established by `screenTargets` before this
 * component renders (see `App.tsx`), and the results arrive here as two disjoint lists:
 * `entries`, which will be trashed, and `blocked`, which will not.
 *
 * The headline totals `entries` **only** — and so does the banner drawn from it. A user who
 * reads "18.4G across 7 directories" and receives 10.9G has been told a number the tool never
 * intended to deliver; the second time that happens they stop reading the refusals at all,
 * which is the same failure `clean.ts` names from the other side ("a guard nobody can satisfy
 * is a guard that gets switched off"). Blocked rows are still *shown* — with their size and
 * their reason — because silently dropping 7.5G from a total the section headers said was
 * there is its own kind of lie. Stated and excluded; never counted and refused.
 *
 * When `entries` is empty every selected directory was blocked. The screen then offers no
 * confirmation at all: there is nothing to consent to, and an `enter` that ran a clean of
 * zero targets would report "nothing was selected" for a user who selected plenty. The banner
 * is dropped with it — a giant `0B` over a framed prompt is a celebration of nothing.
 *
 * ## The reason is the code, not the sentence
 *
 * A `Refusal` is rendered through `REASONS` rather than by printing the boundary's `detail`
 * string. The details are full sentences carrying absolute paths — right for the report and
 * the post-run summary, which are read in a pager — and this box is 56 columns wide, where
 * they would wrap into an unreadable block. `REASONS` is a total `Record`, so a new
 * `Refusal` that reaches the user without a phrase is a compile error rather than a blank.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { formatBytes, truncateLabel } from './format.js';
// The block font and the framed prompt are defined next to the celebration they were written
// for; see the note in Round.tsx. The question and the answer draw the same number the same
// way on purpose.
import { bigBytes, promptBox, sizeRow } from './Round.js';
import type { Refusal } from '../types.js';

/**
 * Beyond this, the list is summarised — a confirmation nobody can read is not one. Six, not
 * twelve: the list is the supporting detail on this screen, and the rows it gives up are rows
 * the number and the choice get to keep on a short terminal.
 */
const MAX_LISTED = 6;
/** Blocked entries cost two lines each (the row and its reason), so fewer of them fit. */
const MAX_BLOCKED_LISTED = 4;

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
  /**
   * Rows this pane may occupy. Optional so a component test can render it unbounded, but
   * the app always passes it.
   *
   * The entry caps used to be the constants above, chosen once against a layout that has
   * since grown a byte banner and a prompt box. A static cap cannot know that: the pane
   * rendered 26 lines into a 24-row terminal, and because Ink redraws by clearing the lines
   * it previously wrote, the overflow left a stale header on screen — the duplicate header
   * the user reported. Caps derived from the space actually available cannot drift that way.
   */
  height?: number;
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
  height,
}: ConfirmProps): React.ReactElement {
  const nothingToList = entries.length === 0;
  // Short second halves on purpose: at 24 columns the frame truncates, and `esc … no — cancel`
  // must survive that where `no — back to the list` would not.
  const choice = nothingToList
    ? ['esc     back']
    : [`enter   yes — move ${formatBytes(bytes)} to the Trash`, 'esc     no — cancel'];

  // `bigBytes` returns undefined when the figure will not fit the width, so the banner is
  // not a fixed cost and must be measured rather than assumed.
  // The height budget, allocated cheapest-information-last.
  //
  // Two things made the old arithmetic wrong. Blocked rows are TWO lines each — a label and
  // the reason it was refused — and the big byte banner is six. So on a 24-row terminal the
  // pane rendered 26 lines, and because Ink redraws by clearing the lines it previously
  // wrote, the two it could not clear stayed on screen as a duplicated header.
  //
  // When it does not all fit, the BANNER goes first. It is decoration: it restates a figure
  // that is also printed as text on the line below it. A refusal reason is not decoration —
  // it is the tool explaining why it will not do something the user asked for — and a
  // directory name is what they are consenting to. Decoration yields to information.
  const BLOCKED_ROW_LINES = 2;
  const bannerRows = nothingToList ? undefined : bigBytes(bytes, width);
  const bannerCost = bannerRows === undefined ? 0 : bannerRows.length + 1;

  const baseChrome =
    2 + // heading, spacer
    (nothingToList ? 1 : 0) +
    3 + // total, Trash caveat, spacer
    promptBox(choice, width).length +
    (nothingToList ? 0 : 3) + // spacer, "what moves:", the "…and N more" line
    (blocked.length === 0 ? 0 : 3);

  const budget = height === undefined ? Number.POSITIVE_INFINITY : height;
  // Rows worth having before the banner earns its place: something from each section.
  const floorRows = (nothingToList ? 0 : 1) + (blocked.length === 0 ? 0 : BLOCKED_ROW_LINES);
  const showBanner = budget - baseChrome - bannerCost >= floorRows;
  const room = budget - baseChrome - (showBanner ? bannerCost : 0);

  // Blocked rows are allocated first and capped, because a refusal the user cannot see is a
  // refusal they will be surprised by.
  const blockedRoom =
    blocked.length === 0
      ? 0
      : Math.min(
          MAX_BLOCKED_LISTED,
          blocked.length,
          // Everything the room allows, less one line kept back so at least one directory
          // the user is actually consenting to is still named.
          Math.max(1, Math.floor((room - 1) / BLOCKED_ROW_LINES)),
        );
  const entryRoom = Math.max(
    1,
    Math.min(MAX_LISTED, room - blockedRoom * BLOCKED_ROW_LINES),
  );

  const listed = entries.slice(0, entryRoom);
  const hidden = entries.length - listed.length;
  const listedBlocked = blocked.slice(0, blockedRoom);
  const hiddenBlocked = blocked.length - listedBlocked.length;
  const nothingToDo = entries.length === 0;

  /** Every line on this pane is clipped: a confirmation that wraps has to be reassembled. */
  const fit = (text: string): string => truncateLabel(text, width);

  const banner = showBanner ? bannerRows : undefined;
  const total =
    `${formatBytes(bytes)} across ${targetCount} ` +
    `${targetCount === 1 ? 'directory' : 'directories'}`;

  // The two keys, spelled out as the answers they are. `enter` is offered only when there is
  // something to consent to — see the module note.
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="yellow">
        {fit('Move to Trash?')}
      </Text>

      <Text> </Text>
      {banner === undefined ? null : (
        <Box flexDirection="column">
          {banner.map((line, index) => (
            <Text key={`banner-${index}`} bold color="yellow">
              {`  ${line}`}
            </Text>
          ))}
          <Text> </Text>
        </Box>
      )}
      {nothingToDo ? (
        <Text bold color="red">
          {fit('  Nothing here can be moved to the Trash.')}
        </Text>
      ) : null}
      <Text bold>{fit(`  ${total}`)}</Text>
      <Text dimColor>{fit('  Trash still holds the space until you empty it.')}</Text>

      <Text> </Text>
      {promptBox(choice, width).map((line, index) => (
        <Text key={`choice-${index}`} bold color={nothingToDo ? 'yellow' : 'green'}>
          {line}
        </Text>
      ))}

      {nothingToDo ? null : (
        <Box flexDirection="column">
          <Text> </Text>
          <Text dimColor>{fit('  what moves:')}</Text>
          {listed.map((entry) => (
            <Text key={entry.id} dimColor>
              {sizeRow('  ', entry.label, entry.bytes, width)}
            </Text>
          ))}
          {hidden > 0 ? <Text dimColor>{fit(`  …and ${hidden} more`)}</Text> : null}
        </Box>
      )}

      {blocked.length === 0 ? null : (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold color="red">
            {fit(
              `  Blocked · ${plural(blocked.length, 'item')} · ${formatBytes(blockedBytes)}` +
                ' — not in the total above',
            )}
          </Text>
          {listedBlocked.flatMap((entry) => [
            <Text key={`${entry.id}:row`} color="red">
              {sizeRow('  ! ', entry.label, entry.bytes, width)}
            </Text>,
            <Text key={`${entry.id}:why`} dimColor>
              {fit(`      ${REASONS[entry.refusal]}`)}
            </Text>,
          ])}
          {hiddenBlocked > 0 ? (
            <Text dimColor>{fit(`  …and ${hiddenBlocked} more blocked`)}</Text>
          ) : null}
        </Box>
      )}

      <Text> </Text>
      <Text dimColor>q quit</Text>
    </Box>
  );
}
