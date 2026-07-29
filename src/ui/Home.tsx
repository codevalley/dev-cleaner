/**
 * Default post-splash surface: one reclaim CTA, or browse when nothing is recommended.
 *
 * Home is a short menu, not a form. Arrow keys move a focus cursor; enter activates the
 * focused row. Letter shortcuts still work. The reclaim figure uses the solid five-row face
 * when the terminal is tall enough — the two-row half-block face is too dense to read as a
 * number from a glance.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { WORDMARK } from './Banner.js';
import { type DiskUsage, diskLabels } from './diskbar.js';
import { formatBytes, truncateLabel } from './format.js';
import { BIG_ROWS, bigTextLines } from './glyphs.js';
import { promptBox } from './Round.js';
import {
  SCANNING_LABEL,
  SETTLED_MARK,
  useSpinner,
} from './ScanStatus.js';

export const HOME_READY_LABEL = 'ready';

export type HomeActionId = 'reclaim' | 'browse' | 'trash' | 'quit';

export interface HomeAction {
  id: HomeActionId;
  /** Left column: the key that activates this row without moving focus. */
  key: string;
  label: string;
}

export interface HomeProps {
  width: number;
  height: number;
  rootsLabel: string;
  scanning: boolean;
  recommendedCount: number;
  recommendedBytes: number;
  dormantCount: number;
  activeCount: number;
  cacheCount: number;
  /** Index into `homeActions(...)`; clamped by the renderer. */
  focusIndex?: number;
  foundLabel?: string | undefined;
  disk?: DiskUsage | undefined;
  session?: string | undefined;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function homeCaptionText(
  dormantCount: number,
  activeCount: number,
  cacheCount: number,
  disk?: DiskUsage,
): string {
  const parts = [
    plural(dormantCount, 'dormant'),
    plural(activeCount, 'active'),
    plural(cacheCount, 'cache'),
  ];
  if (disk !== undefined) {
    parts.push(`${formatBytes(disk.free)} free`);
  }
  return parts.join(' · ');
}

export function homeDiskNote(disk: DiskUsage | undefined, reclaiming: number): string {
  if (disk === undefined) return '';
  const labels = diskLabels(disk, reclaiming);
  return labels.projected ?? `${labels.free} on volume`;
}

/**
 * Menu rows. Reclaim is omitted when nothing is recommended so enter cannot pretend to
 * clean an empty set. Labels say "reclaim" / "empty Trash" — both used to say "trash" and
 * that made enter feel like it had chosen `t`.
 */
export function homeActions(
  recommendedCount: number,
  recommendedBytes: number,
): HomeAction[] {
  const actions: HomeAction[] = [];
  if (recommendedCount > 0) {
    actions.push({
      id: 'reclaim',
      key: 'enter',
      label: `reclaim ${plural(recommendedCount, 'item')} · ${formatBytes(recommendedBytes)}`,
    });
  }
  actions.push(
    { id: 'browse', key: 'b', label: 'browse & adjust' },
    { id: 'trash', key: 't', label: 'empty Trash' },
    { id: 'quit', key: 'q', label: 'quit' },
  );
  return actions;
}

/** @deprecated Prefer `homeActions` — kept for tests that assert the old line list. */
export function homeActionLines(recommendedCount: number, recommendedBytes: number): string[] {
  return homeActions(recommendedCount, recommendedBytes).map((action) => {
    if (action.id === 'reclaim') return `enter  ${action.label}`;
    return `${action.key} ${action.label}`;
  });
}

export function homeChromeLine(
  scanning: boolean,
  mark: string,
  rootsLabel: string,
  width: number,
): string {
  const label = scanning ? SCANNING_LABEL : HOME_READY_LABEL;
  const root = truncateLabel(rootsLabel, Math.max(0, width));
  return truncateLabel(`${WORDMARK} · ${mark} ${label} · ${root}`, Math.max(0, width));
}

/** Default focus: reclaim when offered, otherwise browse — never Trash. */
export function defaultHomeFocus(recommendedCount: number): number {
  return 0;
}

export function clampHomeFocus(focusIndex: number, actionCount: number): number {
  if (actionCount <= 0) return 0;
  if (focusIndex < 0) return 0;
  if (focusIndex >= actionCount) return actionCount - 1;
  return focusIndex;
}

/** Height the solid figure needs, including a blank gap under it. */
const TALL_FIGURE_BUDGET = BIG_ROWS + 1;

function figureLines(bytes: number, width: number, allowTall: boolean): string[] {
  if (allowTall) {
    const tall = bigTextLines(formatBytes(bytes));
    if (tall !== undefined) {
      const drawn = tall.reduce((w, line) => Math.max(w, line.length), 0);
      if (drawn > 0 && drawn <= width) return [...tall];
    }
  }
  // Compact fallback: one bold plain line — readable when the tall face will not fit.
  return [formatBytes(bytes)];
}

function renderActionRow(action: HomeAction, focused: boolean, width: number): string {
  const mark = focused ? '▸' : ' ';
  // Single spaces so substring checks like "b browse" still match the painted line.
  return truncateLabel(`${mark} ${action.key} ${action.label}`, Math.max(0, width));
}

export function Home({
  width,
  height,
  rootsLabel,
  scanning,
  recommendedCount,
  recommendedBytes,
  dormantCount,
  activeCount,
  cacheCount,
  focusIndex = 0,
  foundLabel,
  disk,
  session,
}: HomeProps): React.ReactElement {
  const spinner = useSpinner(scanning);
  const mark = scanning ? spinner : SETTLED_MARK;
  const actions = homeActions(recommendedCount, recommendedBytes);
  const focus = clampHomeFocus(focusIndex, actions.length);

  const chrome = homeChromeLine(scanning, mark, rootsLabel, width);
  const caption = homeCaptionText(dormantCount, activeCount, cacheCount, disk);
  const note = homeDiskNote(disk, recommendedBytes);
  const progress =
    foundLabel !== undefined && foundLabel.length > 0
      ? foundLabel
      : scanning
        ? 'b browse to watch the list fill in'
        : '';

  const actionBlock = promptBox(
    actions.map((action, index) => renderActionRow(action, index === focus, Math.max(0, width - 4))),
    width,
  );

  // Fixed lines excluding the reclaim figure: chrome · gap · [figure] · gap · caption · …
  const fixedWithoutFigure =
    1 + // chrome
    1 + // gap under chrome
    1 + // gap under figure
    1 + // caption
    (note.length > 0 ? 1 : 0) +
    (progress.length > 0 ? 1 : 0) +
    (session !== undefined ? 1 : 0) +
    1 + // gap above actions
    actionBlock.length;

  const allowTall = height >= fixedWithoutFigure + TALL_FIGURE_BUDGET;
  const figure = figureLines(recommendedBytes, width, allowTall);
  const muted = recommendedBytes <= 0;

  type Line = { key: string; node: React.ReactElement; keep: boolean };
  const lines: Line[] = [];
  const pushGap = (key: string, keep = true): void => {
    lines.push({ key, node: <Text key={key}> </Text>, keep });
  };
  const pushText = (
    key: string,
    node: React.ReactElement,
    keep = true,
  ): void => {
    lines.push({ key, node, keep });
  };

  pushText(
    'chrome',
    <Text key="chrome" color={scanning ? 'cyan' : 'green'} wrap="truncate-end">
      {chrome}
    </Text>,
  );
  pushGap('gap-chrome');

  for (const [index, line] of figure.entries()) {
    pushText(
      `fig-${index}`,
      <Text key={`fig-${index}`} bold color={muted ? undefined : 'green'} dimColor={muted}>
        {truncateLabel(line, width)}
      </Text>,
    );
  }
  pushGap('gap-figure');

  pushText(
    'caption',
    <Text key="caption" wrap="truncate-end">
      {truncateLabel(caption, width)}
    </Text>,
  );
  if (note.length > 0) {
    pushText(
      'note',
      <Text key="note" dimColor wrap="truncate-end">
        {truncateLabel(note, width)}
      </Text>,
      false,
    );
  }
  if (progress.length > 0) {
    pushText(
      'progress',
      <Text key="progress" dimColor wrap="truncate-end">
        {truncateLabel(progress, width)}
      </Text>,
      false,
    );
  }
  if (session !== undefined) {
    pushText(
      'session',
      <Text key="session" dimColor wrap="truncate-end">
        {truncateLabel(session, width)}
      </Text>,
      false,
    );
  }

  pushGap('gap-actions');
  for (const [index, line] of actionBlock.entries()) {
    const focusedLine = line.includes('▸');
    pushText(
      `act-${index}`,
      <Text
        key={`act-${index}`}
        bold={focusedLine}
        color={focusedLine ? 'yellow' : undefined}
        dimColor={!focusedLine}
      >
        {line}
      </Text>,
    );
  }

  // Drop optional middle lines first so the action box (and its bottom border) never clips.
  while (lines.length > height) {
    const dropAt = lines.findIndex((line) => !line.keep);
    if (dropAt < 0) break;
    lines.splice(dropAt, 1);
  }
  const fitted = lines.slice(0, height).map((line) => line.node);
  while (fitted.length < height) {
    fitted.push(<Text key={`pad-${fitted.length}`}> </Text>);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {fitted}
    </Box>
  );
}
