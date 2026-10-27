/** Scrollable inspection of the exact artifact inventory collected by the scan. */
import React from 'react';
import stringWidth from 'string-width';

import {
  formatBytes,
  formatDate,
  padLabel,
} from './format.js';
import { LABEL_HELP, joinLabels, labelsFor, type Label, type LabelTone } from './labels.js';
import { SAFE_TO_CHECK, SECTION_NOTES, enabledArtifacts, type Row } from './model.js';
import type { Category } from '../types.js';
import { TextPage, type PageLine } from './TextPage.js';

export interface DetailProps {
  row: Row | undefined;
  categories: ReadonlySet<Category>;
  width: number;
  /** Hard ceiling on rendered lines. See the module note — this is a layout guarantee. */
  height: number;
  offset?: number;
}

/** A rendered line plus how it is styled. Kept as data so the list can be cut before it is drawn. */
type Line = PageLine;

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

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Preserve paths verbatim while wrapping by terminal columns, including emoji and CJK. */
export function wrapPath(value: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = '';
  let columns = 0;
  for (const { segment } of graphemes.segment(value)) {
    const nextColumns = stringWidth(segment);
    if (current.length > 0 && columns + nextColumns > width) {
      lines.push(current);
      current = '';
      columns = 0;
    }
    current += segment;
    columns += nextColumns;
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
  const { git, activity } = project;
  const labels = labelsFor(project, categories);

  const lines: Line[] = [
    { text: `Cleanup candidates · ${project.name}`, bold: true },
    ...wrapPath(project.root, width).map(text => ({ text, dim: true })),
    ...wrapText(joinLabels(labels, 'long'), width).map(text => ({ text })),
    blank(),
    ...wrapText('Only included directories are candidates. The project folder stays. Safety checks run before confirmation.', width).map(text => ({ text, dim: true })),
    blank(),
    ...project.artifacts.flatMap((artifact): Line[] => [
      ...wrapPath(artifact.relPath + '/', Math.max(1, width - 2)).map(text => ({ text: `  ${text}` })),
      ...wrapText(`${categories.has(artifact.category) ? 'included' : 'kept (outside preset)'} · ${formatBytes(artifact.bytes)} · ${artifact.category}`, Math.max(1, width - 2)).map(text => ({ text: `  ${text}`, dim: !categories.has(artifact.category) })),
    ]),
    { text: `Included total: ${formatBytes(total)}`, bold: true },
    blank(),
  ];

  if (git === undefined) {
    lines.push({ text: padLabel('  not a git repository', width), dim: true });
  } else {
    lines.push({ text: padLabel(`  branch: ${git.branch}`, width) });
    lines.push({ text: padLabel(`  last commit: ${formatDate(git.lastCommitMs)}`, width) });
    lines.push({ text: padLabel(`  uncommitted: ${git.hasUncommittedChanges ? 'yes' : 'no'}`, width) });
    if (git.worktree !== undefined) {
      lines.push(...wrapPath(`  worktree of: ${git.worktree.mainRepo}`, width).map(text => ({ text })));
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
    ...wrapPath(cache.path, Math.max(1, width - 2)).map((text) => ({ text: `  ${text}` })),
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

export function detailLines(row: Row | undefined, categories: ReadonlySet<Category>, width: number): PageLine[] {
  return row === undefined || row.kind === 'header'
    ? [{ text: 'nothing highlighted', dim: true }]
    : [
        ...(row.kind === 'project' ? projectLines(row, categories, width) : cacheLines(row, width)),
        ...safetyLines(row, width),
      ];
}

export function Detail({ row, categories, width, height, offset = 0 }: DetailProps): React.ReactElement {
  return <TextPage lines={detailLines(row, categories, width)} offset={offset} width={width} height={height} />;
}
