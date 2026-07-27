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
 *    nothing else. The block-font banner is drawn from that same figure and no other, which is
 *    the whole reason it is computed here from `reclaimedBytes` rather than passed in as text.
 * 2. **What did not happen is named, not omitted.** A round that quietly reported only its
 *    successes would let a refusal go unread forever; the user selected those directories and
 *    is owed the reason. They are shown separately, below the total, never inside it. A round
 *    that trashed 2 G and refused 8 G celebrates 2 G and says so.
 * 3. **The session total is stated in the same breath.** It is the answer to "have I actually
 *    got anywhere", which is the question a second and third round are asked in service of.
 *
 * # Why this screen celebrates, and how far
 *
 * The first user to run this for real reclaimed 107 GB and got a terse list of outcomes for
 * it. That is a failure of the interface: the single most satisfying number the tool will ever
 * produce was rendered in the same weight as the word "directories". So the freshly trashed
 * figure is drawn in a block font, big enough to read from across the room, and the decoration
 * around it scales with the achievement — `celebrationFor` gives 107 G three marks and a rule,
 * and 200 M a plain sentence.
 *
 * Two constraints keep the celebration honest, and both are load-bearing:
 *
 * - **It celebrates trashing, never freeing.** The bytes are still on the volume. Nothing on
 *   this screen may imply otherwise, which is why the phrases name the *round* ("An enormous
 *   round.") and never the disk. Emptying the Trash is what frees them, and that is offered
 *   here as the obvious next thing to do — invariant 8, discharged inside the affordance that
 *   performs it rather than as a footnote under it.
 * - **It is instant and dismissable.** There is no animation, no timer and no state: the pane
 *   renders its final content on its first frame. A celebration you have to sit through is an
 *   obstacle the second time you see it, and this is a tool people run repeatedly.
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
import { bigBytes } from './glyphs.js';

/** Beyond this the list is summarised; a report nobody can read is not one. */
const MAX_PROBLEMS = 6;

const GIB = 1024 ** 3;

/* ------------------------------------------------------------------------ *
 * Shared display primitives
 *
 * The block font is used by this pane, by `Confirm` — which asks the question this pane
 * answers — and by the closing line `cli.ts` prints once Ink has gone. Two block fonts that
 * drifted apart would show the same 107 G in two different shapes on two consecutive screens,
 * which is precisely the "half-TUI" incoherence this file exists to end, so there is one.
 *
 * It lives in `glyphs.ts` rather than here only because `cli.ts` must be able to reach it
 * without pulling React and Ink into `--help`; it is re-exported from this module because this
 * is where its callers and its tests have always found it.
 * ------------------------------------------------------------------------ */

export { BIG_ROWS, bigBytes, bigTextLines } from './glyphs.js';

/**
 * A label and its size on one line, the size right-aligned into a fixed column.
 *
 * The label's budget is whatever `width` has left after the indent and the size column, with
 * no floor under it: a floor is how the old rows came to be 21 columns wide inside a 16-column
 * pane, and an overflowing row is not a wider row — Ink wraps it, and one directory becomes
 * two lines in a list whose whole job is one line per directory. The finished row is clipped
 * as well, so even a pane too narrow to hold the size column costs the frame one line and not
 * two.
 */
export function sizeRow(indent: string, label: string, bytes: number, width: number): string {
  const labelWidth = Math.max(1, width - indent.length - BYTES_WIDTH - 1);
  return truncateLabel(
    `${indent}${padLabel(label, labelWidth)} ${formatBytesPadded(bytes)}`,
    width,
  );
}

/**
 * A framed prompt: the choice on offer, drawn as a box so it cannot be mistaken for the dim
 * key hints it used to be. Degrades to bare truncated lines when the pane is too narrow to
 * hold a frame — at that width the border costs more columns than it buys.
 */
export function promptBox(lines: readonly string[], width: number): readonly string[] {
  const inner = width - 4;
  if (inner < 12) return lines.map((line) => truncateLabel(line, Math.max(1, width)));

  const rule = '─'.repeat(inner + 2);
  return [
    `╭${rule}╮`,
    ...lines.map((line) => `│ ${padLabel(line, inner)} │`),
    `╰${rule}╯`,
  ];
}

/* ------------------------------------------------------------------------ */

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
 * How loudly a round is worth celebrating. Four steps, because the difference between 200 M
 * and 107 G is the difference between "tidied up" and "got a tenth of the disk back", and one
 * fixed fanfare for both makes the big one feel routine and the small one feel oversold.
 *
 * No phrase claims the space is free — it is in the Trash. `big` gates the banner rather than
 * the whole pane: a sub-gigabyte round still says exactly what it did, in words.
 */
export interface Celebration {
  /** Draw the block-font banner. */
  big: boolean;
  /** Rules above and below it — reserved for the largest step. */
  rule: boolean;
  /** Zero to three marks, scaling with the figure. */
  sparks: string;
  /** The one-line verdict, absent below a gigabyte. */
  phrase: string | undefined;
}

const TIERS: readonly { readonly min: number; readonly celebration: Celebration }[] = [
  {
    min: 100 * GIB,
    celebration: { big: true, rule: true, sparks: '✦ ✦ ✦', phrase: 'An enormous round.' },
  },
  { min: 10 * GIB, celebration: { big: true, rule: false, sparks: '✦ ✦', phrase: 'A big round.' } },
  { min: GIB, celebration: { big: true, rule: false, sparks: '✦', phrase: 'A good round.' } },
];

const NO_CELEBRATION: Celebration = { big: false, rule: false, sparks: '', phrase: undefined };

export function celebrationFor(bytes: number): Celebration {
  if (!Number.isFinite(bytes) || bytes <= 0) return NO_CELEBRATION;
  for (const tier of TIERS) if (bytes >= tier.min) return tier.celebration;
  return NO_CELEBRATION;
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
  const listed = report.problems.slice(0, MAX_PROBLEMS);
  const hidden = report.problems.length - listed.length;
  const session = sessionLine(report);
  const nothingMoved = report.trashed === 0;

  /** Every line on this pane is clipped; a summary that wraps is one nobody re-reads. */
  const fit = (text: string): string => truncateLabel(text, width);

  // Both read `reclaimedBytes`, which `applyRound` fills from trashed outcomes alone. A round
  // whose refusals were folded in here would draw a number the Trash cannot honour.
  const cheer = nothingMoved ? NO_CELEBRATION : celebrationFor(report.reclaimedBytes);
  const banner = cheer.big ? bigBytes(report.reclaimedBytes, width) : undefined;
  const bannerWidth =
    banner === undefined ? 0 : banner.reduce((widest, line) => Math.max(widest, line.length), 0);

  return (
    <Box flexDirection="column" paddingX={1}>
      {banner === undefined ? null : (
        <Box flexDirection="column">
          <Text> </Text>
          {cheer.rule ? <Text color="green">{`  ${'━'.repeat(bannerWidth)}`}</Text> : null}
          {banner.map((line, index) => (
            <Text key={`banner-${index}`} bold color="green">
              {`  ${line}`}
            </Text>
          ))}
          {cheer.rule ? <Text color="green">{`  ${'━'.repeat(bannerWidth)}`}</Text> : null}
          <Text> </Text>
        </Box>
      )}

      {/* Indented to two, so the caption sits under the banner it captions. */}
      <Text bold color={nothingMoved ? 'yellow' : 'green'}>
        {fit(
          nothingMoved
            ? '  Nothing was moved to the Trash.'
            : `  Moved ${formatBytes(report.reclaimedBytes)} to the Trash.`,
        )}
      </Text>
      {cheer.phrase === undefined ? null : (
        <Text bold color="green">
          {fit(`  ${cheer.sparks}  ${cheer.phrase}`)}
        </Text>
      )}
      <Text dimColor>
        {fit(
          `  ${plural(report.trashed, 'directory', 'directories')} trashed` +
            (report.refused > 0 ? ` · ${report.refused} refused` : '') +
            (report.failed > 0 ? ` · ${report.failed} failed` : ''),
        )}
      </Text>

      {listed.length === 0 ? null : (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold color="red">
            {fit(
              `  Left in place · ${plural(report.problems.length, 'item')} — not in the total above`,
            )}
          </Text>
          {listed.flatMap((entry) => [
            <Text key={`${entry.id}:row`} color="red">
              {sizeRow('  ! ', entry.label, entry.bytes, width)}
            </Text>,
            <Text key={`${entry.id}:why`} dimColor>
              {fit(`      ${entry.detail ?? entry.outcome}`)}
            </Text>,
          ])}
          {hidden > 0 ? <Text dimColor>{fit(`  …and ${hidden} more`)}</Text> : null}
        </Box>
      )}

      <Text> </Text>
      {session === undefined ? null : (
        <Box flexDirection="column">
          <Text bold>{fit(`  ${session}`)}</Text>
          <Text> </Text>
        </Box>
      )}
      {/*
        Invariant 8, put where it is acted on. When the Trash can be emptied the disclosure
        rides on the offer itself — one line that says both what the key does and why it is
        the next thing worth doing. When it cannot, the same fact is stated on its own, because
        the fact does not depend on whether this tool happens to be able to act on it.
      */}
      {canEmptyTrash ? (
        <Box flexDirection="column">
          {promptBox(['t empty the Trash — the space is not free until you do'], width).map(
            (line, index) => (
              <Text key={`offer-${index}`} bold color="cyan">
                {line}
              </Text>
            ),
          )}
        </Box>
      ) : (
        <Text dimColor>{fit('  Trash still holds the space until you empty it.')}</Text>
      )}
      <Text> </Text>
      {/*
        `esc`, never `enter` — see the module note. The hint has to name the key that works,
        because a user who presses enter here and sees nothing happen will press it again.
      */}
      <Text dimColor>{fit('esc back to the list · q quit')}</Text>
    </Box>
  );
}
