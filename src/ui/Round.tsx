/**
 * What one round of cleaning did, rendered **inside** the interface.
 *
 * The old flow ended the run at this point: the app unmounted, Ink's frame was torn off the
 * screen, and a block of plain text was printed where it had been. That ending is worse than
 * ugly. The interface disappears at the exact moment the user most wants to look at it — to
 * check what was refused, to see whether the number matches what they agreed to, to decide
 * what to do next — and what replaces it is a wall of prose in a different visual language,
 * below a prompt, with no way back. The user described it as a half-TUI ending, and they were
 * being generous.
 *
 * So the round reports itself in the frame, and the frame stays. `App` returns to the list
 * afterwards with the cleaned rows gone and the totals updated; this pane is the moment in
 * between.
 *
 * # Three rules about the numbers
 *
 * 1. **The headline counts trashed bytes only.** `refused` and `failed` mean the directory is
 *    still exactly where it was. Summing all three would tell a user who trashed 2 G and had
 *    an 8 G store prune refused that 10 G is waiting in the Trash — so they empty it, expect
 *    10 G back, and get 2 G. The figure comes from `applyRound`, which counts `trashed` and
 *    nothing else.
 * 2. **What did not happen is named, not omitted.** A round that quietly reported only its
 *    successes would let a refusal go unread forever; the user selected those directories and
 *    is owed the reason. They are shown separately, below the total, never inside it.
 * 3. **The session total is stated in the same breath.** It is the answer to "have I actually
 *    got anywhere", which is the question a second and third round are asked in service of.
 *
 * # Why `enter` does nothing here
 *
 * `enter` is this application's commit key: it opens the confirmation and it spends consent.
 * A user who holds it — and a confirmation dialog is precisely where people hold keys — would
 * otherwise chain through *dismiss this pane → list → enter → screening → confirm → enter*
 * and start a second round they never asked for. So the one screen that sits between two
 * rounds refuses the key that starts them. Dismissal is `esc`, and the pane says so.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { BYTES_WIDTH, formatBytes, formatBytesPadded, padLabel, truncateLabel } from './format.js';

/** Beyond this the list is summarised; a report nobody can read is not one. */
const MAX_PROBLEMS = 6;

/** A target that was selected, consented to, and did not move. */
export interface ProblemEntry {
  id: string;
  label: string;
  bytes: number;
  outcome: 'refused' | 'failed';
  /** The boundary's own sentence, when it gave one. */
  detail?: string | undefined;
}

/**
 * One round's result. Assembled by `App` from `applyRound` — which owns the arithmetic — so
 * this component adds up nothing at all.
 */
export interface RoundReport {
  /** Bytes moved to the Trash in **this** round. Trashed only. */
  reclaimedBytes: number;
  trashed: number;
  refused: number;
  failed: number;
  problems: readonly ProblemEntry[];
  /** Bytes moved to the Trash across the whole session, including this round. */
  sessionBytes: number;
  /** Completed rounds, including this one. */
  rounds: number;
}

export interface RoundSummaryProps {
  report: RoundReport;
  width: number;
  /** Whether the Trash can be measured and emptied — governs whether the offer is made. */
  canEmptyTrash: boolean;
}

/**
 * `1 directory` / `7 directories`. The plural is a parameter rather than an `s` appended to
 * the singular, because the only noun this file counts in quantity is the one that does not
 * take one — and "7 directorys" in the sentence reporting a bulk deletion is exactly the
 * detail that makes a person wonder what else the tool is careless about.
 */
function plural(count: number, singular: string, many: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

/** The session line, or `undefined` on a first round — where it would only restate the total. */
export function sessionLine(report: RoundReport): string | undefined {
  if (report.rounds <= 1) return undefined;
  return `${formatBytes(report.sessionBytes)} trashed this session · ${plural(report.rounds, 'round')}`;
}

export function RoundSummary({
  report,
  width,
  canEmptyTrash,
}: RoundSummaryProps): React.ReactElement {
  const labelWidth = Math.max(12, width - BYTES_WIDTH - 4);
  const listed = report.problems.slice(0, MAX_PROBLEMS);
  const hidden = report.problems.length - listed.length;
  const session = sessionLine(report);
  const nothingMoved = report.trashed === 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={nothingMoved ? 'yellow' : 'green'}>
        {nothingMoved
          ? 'Nothing was moved to the Trash.'
          : `Moved ${formatBytes(report.reclaimedBytes)} to the Trash.`}
      </Text>
      <Text dimColor>
        {`${plural(report.trashed, 'directory', 'directories')} trashed` +
          (report.refused > 0 ? ` · ${report.refused} refused` : '') +
          (report.failed > 0 ? ` · ${report.failed} failed` : '')}
      </Text>

      {listed.length === 0 ? null : (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold color="red">
            {`  Left in place · ${plural(report.problems.length, 'item')} — not in the total above`}
          </Text>
          {listed.flatMap((entry) => [
            <Text key={`${entry.id}:row`} color="red">
              {`  ! ${padLabel(entry.label, Math.max(10, labelWidth - 2))} ${formatBytesPadded(entry.bytes)}`}
            </Text>,
            <Text key={`${entry.id}:why`} dimColor>
              {`      ${truncateLabel(entry.detail ?? entry.outcome, Math.max(10, width - 6))}`}
            </Text>,
          ])}
          {hidden > 0 ? <Text dimColor>{`  …and ${hidden} more`}</Text> : null}
        </Box>
      )}

      <Text> </Text>
      {session === undefined ? null : <Text bold>{`  ${session}`}</Text>}
      <Text dimColor>{'  Trash still holds the space until you empty it.'}</Text>
      <Text> </Text>
      {/*
        `esc`, never `enter` — see the module note. The hint has to name the key that works,
        because a user who presses enter here and sees nothing happen will press it again.
      */}
      <Text dimColor>
        {canEmptyTrash ? 'esc back to the list · t empty the Trash · q quit' : 'esc back to the list · q quit'}
      </Text>
    </Box>
  );
}
