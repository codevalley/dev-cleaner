/**
 * Default post-splash surface: one reclaim CTA, or browse when nothing is recommended.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { Headline, WORDMARK } from './Banner.js';
import { type DiskUsage, diskLabels } from './diskbar.js';
import { formatBytes, truncateLabel } from './format.js';
import { promptBox } from './Round.js';
import {
  SCANNING_LABEL,
  SETTLED_MARK,
  useSpinner,
} from './ScanStatus.js';

export const HOME_READY_LABEL = 'ready';

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

export function homeActionLines(recommendedCount: number, recommendedBytes: number): string[] {
  const lines: string[] = [];
  if (recommendedCount > 0) {
    lines.push(
      `enter  trash the recommended ${plural(recommendedCount, 'item')} · ${formatBytes(recommendedBytes)}`,
    );
  } else {
    lines.push('nothing recommended');
  }
  lines.push('b browse & adjust', 't Trash', 'q quit');
  return lines;
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

type HomeLine =
  | { kind: 'pad' }
  | { kind: 'chrome'; text: string }
  | { kind: 'headline' }
  | { kind: 'session'; text: string }
  | { kind: 'action'; text: string };

function homeLineHeight(line: HomeLine): number {
  return line.kind === 'headline' ? 2 : 1;
}

function homeLinesHeight(lines: readonly HomeLine[]): number {
  return lines.reduce((sum, line) => sum + homeLineHeight(line), 0);
}

function homeActionRows(
  recommendedCount: number,
  recommendedBytes: number,
  width: number,
  maxLines: number,
): HomeLine[] {
  const choices = homeActionLines(recommendedCount, recommendedBytes);
  const boxed = promptBox(choices, width).map((text) => ({ kind: 'action' as const, text }));
  if (boxed.length <= maxLines) return boxed;
  return choices.map((text) => ({ kind: 'action' as const, text }));
}

function trimToHeight(lines: readonly HomeLine[], maxHeight: number): HomeLine[] {
  const result: HomeLine[] = [];
  let used = 0;
  for (const line of lines) {
    const next = homeLineHeight(line);
    if (used + next > maxHeight) break;
    result.push(line);
    used += next;
  }
  return result;
}

export function homeLayout(
  width: number,
  height: number,
  scanning: boolean,
  mark: string,
  rootsLabel: string,
  recommendedCount: number,
  recommendedBytes: number,
  session?: string,
): HomeLine[] {
  const chrome: HomeLine = {
    kind: 'chrome',
    text: homeChromeLine(scanning, mark, rootsLabel, width),
  };
  const headline: HomeLine = { kind: 'headline' };
  const sessionLine: HomeLine | undefined =
    session === undefined ? undefined : { kind: 'session', text: session };

  const fixed = [chrome, ...(sessionLine === undefined ? [] : [sessionLine]), headline];
  const fixedHeight = homeLinesHeight(fixed);
  const actions = homeActionRows(
    recommendedCount,
    recommendedBytes,
    width,
    Math.max(1, height - fixedHeight),
  );
  let body: HomeLine[] = [...fixed, ...actions];

  if (homeLinesHeight(body) > height && sessionLine !== undefined) {
    body = [chrome, headline, ...homeActionRows(recommendedCount, recommendedBytes, width, height - 3)];
  }

  const bodyHeight = homeLinesHeight(body);
  if (bodyHeight > height) {
    return trimToHeight(body, height);
  }

  const topPad = Math.floor((height - bodyHeight) / 2);
  const bottomPad = height - bodyHeight - topPad;
  return [
    ...Array<HomeLine>(topPad).fill({ kind: 'pad' }),
    ...body,
    ...Array<HomeLine>(bottomPad).fill({ kind: 'pad' }),
  ];
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
  disk,
  session,
}: HomeProps): React.ReactElement {
  const spinner = useSpinner(scanning);
  const mark = scanning ? spinner : SETTLED_MARK;
  const lines = homeLayout(
    width,
    height,
    scanning,
    mark,
    rootsLabel,
    recommendedCount,
    recommendedBytes,
    session,
  );
  const caption = homeCaptionText(dormantCount, activeCount, cacheCount, disk);
  const note = homeDiskNote(disk, recommendedBytes);

  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line, index) => {
        switch (line.kind) {
          case 'pad':
            return <Text key={index}> </Text>;
          case 'chrome':
            return (
              <Text key={index} color={scanning ? 'cyan' : 'green'} wrap="truncate-end">
                {line.text}
              </Text>
            );
          case 'session':
            return (
              <Text key={index} dimColor wrap="truncate-end">
                {truncateLabel(line.text, Math.max(0, width))}
              </Text>
            );
          case 'headline':
            return (
              <Headline
                key={index}
                bytes={recommendedBytes}
                caption={caption}
                note={note}
                width={Math.max(0, width)}
              />
            );
          case 'action':
            return (
              <Text key={index} dimColor={!line.text.includes('enter')}>
                {line.text}
              </Text>
            );
        }
      })}
    </Box>
  );
}
