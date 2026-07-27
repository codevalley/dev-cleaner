/**
 * The right pane: everything known about the highlighted row, and why touching it is safe.
 *
 * This is where worktree status lives. The spec is precise about its role — "Worktree
 * status (registered, clean, merged) is still computed and shown in the detail pane as
 * context for the user's decision. It informs; it never gates deletion" — so it appears
 * here, next to the branch and the last commit, and nowhere near a selection default.
 *
 * The pane never renders a selection glyph. Both panes share the physical lines of the
 * frame, and a marker on the right would be indistinguishable from one on the left.
 *
 * # Two things this pane now does that it did not
 *
 * **It answers "what does this section mean?".** A user looking at a header they did not
 * choose, above rows the tool has decided things about, is owed the reasoning — and if the
 * reasoning is absent they will supply their own, which in this case was "it feels like it
 * may corrupt something". `SECTION_NOTES` and `SAFE_TO_CHECK` are that answer, written in
 * `model.ts` next to the rules they describe so the copy cannot drift away from the
 * behaviour, and shown here against whatever the cursor is on.
 *
 * **It cannot outgrow its pane.** Every line is assembled into an array and the array is cut
 * to `height`. That is not tidiness: the two panes are flex siblings, so a detail pane one
 * line taller than the list pane makes the whole frame one line taller, and a frame taller
 * than the terminal scrolls the footer off the screen. A project with fifteen artifacts is
 * ordinary. The cut is what keeps it from breaking the layout.
 *
 * # The chips, twice
 *
 * The list pane can afford one or two chips per row and gives up the rest (`chipPlan` in
 * `List.tsx`). This pane is where the ones it gave up live, and it draws them twice on
 * purpose:
 *
 * - **as a line**, directly under the name, so the highlighted row's full answer is one glance
 *   away and survives the height cut even on a short terminal;
 * - **as a block at the bottom**, one `LABEL_HELP` sentence per chip, for the user who has
 *   read `needs network` and wants to know what it is asking of them.
 *
 * The explanations go last for the same reason the reassurance does: they are read once, when
 * a chip is new, and putting them above the sizes would push the actual contents of the pane
 * down on every pass where they are not.
 */

import { Box, Text } from 'ink';
import React from 'react';

import {
  BYTES_WIDTH,
  formatBytes,
  formatBytesPadded,
  formatDate,
  formatIdle,
  padLabel,
} from './format.js';
import { LABEL_HELP, joinLabels, labelsFor, type Label, type LabelTone } from './labels.js';
import { SAFE_TO_CHECK, SECTION_NOTES, enabledArtifacts, type Row } from './model.js';
import type { Category } from '../types.js';

export interface DetailProps {
  row: Row | undefined;
  categories: ReadonlySet<Category>;
  width: number;
  /** Hard ceiling on rendered lines. See the module note — this is a layout guarantee. */
  height: number;
}

/** A rendered line plus how it is styled. Kept as data so the list can be cut before it is drawn. */
interface Line {
  text: string;
  dim?: boolean;
  bold?: boolean;
  color?: string;
}

/**
 * `LabelTone` as an amount of emphasis, with one hue in the whole scheme.
 *
 * Three steps — bright, normal, dim — that a terminal with no colour at all still renders as
 * two, and that a user who has turned colour off loses nothing by: the chip says
 * `uncommitted changes` in words either way. The hue is spent only on `warn`, the single tone
 * that means *do something before you clean this* rather than *this is what cleaning costs*.
 * Spending it on `cost` as well would put the two on the same footing, which is the exact
 * confusion `labels.ts` refuses to encode by not handing components a colour in the first
 * place.
 */
const TONE_STYLE: Record<LabelTone, { color?: string; dim?: boolean }> = {
  warn: { color: 'yellow' },
  cost: {},
  info: { dim: true },
};

/**
 * Greedy word wrap. Ink can wrap a `<Text>` itself, but only by producing however many lines
 * the string needs — which is exactly the unbounded height this pane must not have. Wrapping
 * here makes the line count knowable before anything is drawn.
 *
 * A word longer than the width is hard-cut rather than allowed to overflow; a 60-character
 * path with no spaces in it is the common case, not the exotic one.
 */
export function wrapText(value: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = '';

  for (const word of value.split(/\s+/).filter((part) => part.length > 0)) {
    let piece = word;
    while (piece.length > width) {
      if (current.length > 0) {
        lines.push(current);
        current = '';
      }
      lines.push(piece.slice(0, width));
      piece = piece.slice(width);
    }
    if (current.length === 0) current = piece;
    else if (current.length + 1 + piece.length <= width) current = `${current} ${piece}`;
    else {
      lines.push(current);
      current = piece;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function blank(): Line {
  return { text: ' ' };
}

/**
 * One entry per chip: the phrase, then what it means for a decision.
 *
 * Every chip the row has, not the ones the list pane had room for — this is the pane the list
 * defers to, so a chip that appears nowhere else must appear here.
 */
function labelLines(labels: readonly Label[], width: number): Line[] {
  if (labels.length === 0) return [];
  const inner = Math.max(8, width - 4);
  return [
    blank(),
    ...labels.flatMap((label) => [
      { text: padLabel(`  ${label.long}`, width), ...TONE_STYLE[label.tone] },
      ...wrapText(LABEL_HELP[label.kind], inner).map((text) => ({ text: `    ${text}`, dim: true })),
    ]),
  ];
}

function projectLines(row: Extract<Row, { kind: 'project' }>, categories: ReadonlySet<Category>, width: number): Line[] {
  const { project } = row;
  const artifacts = enabledArtifacts(project, categories);
  const total = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  const labelWidth = Math.max(10, width - BYTES_WIDTH - 3);
  const { git, activity } = project;
  const labels = labelsFor(project, categories);

  const lines: Line[] = [
    { text: padLabel(project.name, width), bold: true },
    {
      text: padLabel(
        `${[...project.types].join(' · ')} · ${activity.status} ${formatIdle(activity.idleMs)}`,
        width,
      ),
      dim: true,
    },
    // Wrapped rather than truncated: this line is the list pane's overflow, so the chip it
    // could not afford is precisely the one that must not be cut off the end here.
    ...wrapText(joinLabels(labels, 'long'), width).map((text) => ({ text })),
    blank(),
    ...artifacts.map((artifact) => ({
      text: `  ${padLabel(artifact.relPath, labelWidth)} ${formatBytesPadded(artifact.bytes)}`,
    })),
    { text: `  ${padLabel('total', labelWidth)} ${formatBytesPadded(total)}` },
    blank(),
  ];

  if (git === undefined) {
    lines.push({ text: padLabel('  not a git repository', width), dim: true });
  } else {
    lines.push({ text: padLabel(`  branch: ${git.branch}`, width) });
    lines.push({ text: padLabel(`  last commit: ${formatDate(git.lastCommitMs)}`, width) });
    lines.push({ text: padLabel(`  uncommitted: ${git.hasUncommittedChanges ? 'yes' : 'no'}`, width) });
    if (git.worktree !== undefined) {
      lines.push({ text: padLabel(`  worktree of: ${git.worktree.mainRepo}`, width) });
      lines.push({
        text: padLabel(
          `  ${git.worktree.isMerged ? 'merged' : 'unmerged'}, ${git.worktree.isClean ? 'clean' : 'dirty'}`,
          width,
        ),
      });
    }
  }

  lines.push(blank());
  lines.push({ text: padLabel(`  ${activity.reason}`, width), dim: true });
  lines.push(...labelLines(labels, width));
  return lines;
}

function cacheLines(row: Extract<Row, { kind: 'cache' }>, width: number): Line[] {
  const { cache } = row;
  return [
    { text: padLabel(cache.label, width), bold: true },
    { text: padLabel(`global cache · ${formatBytes(cache.bytes)}`, width), dim: true },
    blank(),
    ...wrapText(cache.path, Math.max(8, width - 2)).map((text) => ({ text: `  ${text}` })),
    blank(),
    ...wrapText(cache.note, Math.max(8, width - 2)).map((text) => ({ text: `  ${text}`, dim: true })),
  ];
}

/**
 * The reassurance block, appended to whatever the row itself had to say.
 *
 * Placed last on purpose. It is the thing a hesitant user reads *after* they have looked at
 * the row and started to wonder, which is the moment the answer is wanted — and putting it
 * first would push the actual contents of the pane down for the many passes where it is not.
 */
function safetyLines(row: Row, width: number): Line[] {
  return [
    blank(),
    ...wrapText(SECTION_NOTES[row.section], width).map((text) => ({ text, dim: true })),
    ...wrapText(SAFE_TO_CHECK, width).map((text) => ({ text, dim: true })),
  ];
}

export function Detail({ row, categories, width, height }: DetailProps): React.ReactElement {
  const lines: Line[] =
    row === undefined || row.kind === 'header'
      ? [{ text: padLabel('nothing highlighted', width), dim: true }]
      : [
          ...(row.kind === 'project' ? projectLines(row, categories, width) : cacheLines(row, width)),
          ...safetyLines(row, width),
        ];

  // The cut. Never a scroll: the detail pane has no cursor, so a hidden line here is
  // information the user cannot reach by any key — which is why the row's own facts come
  // first and the standing reassurance comes last.
  const shown = lines.slice(0, Math.max(1, height));

  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key -- lines are positional by nature
        <Text
          key={index}
          dimColor={line.dim === true}
          bold={line.bold === true}
          {...(line.color === undefined ? {} : { color: line.color })}
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
