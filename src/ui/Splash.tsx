/**
 * Brand entry while the scan starts. Tall wordmark, one purpose line, scan pulse.
 *
 * `splashReady` is the handoff contract: minimum dwell so the mark is perceptible, then open Home even when
 * sizing the first project is slow. Home shows that its totals are provisional.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { splashTitle } from './Banner.js';
import { truncateLabel } from './format.js';
import {
  SCANNING_LABEL,
  SETTLED_LABEL,
  SETTLED_MARK,
  scanCountLine,
  useSpinner,
} from './ScanStatus.js';

export const SPLASH_MIN_DWELL_MS = 1200;
export const SPLASH_PURPOSE = 'reclaim regenerable build output';

export interface SplashProps {
  width: number;
  height: number;
  scanning: boolean;
  rootsLabel: string;
  projects: number;
  caches: number;
  bytes: number;
}

type SplashLine =
  | { kind: 'pad' }
  | { kind: 'title'; text: string }
  | { kind: 'purpose' }
  | { kind: 'status'; text: string };

/** Pure: the brand dwell is bounded independently of filesystem progress. */
export function splashReady(input: {
  dwellElapsedMs: number;
  scanning: boolean;
  recommendedBytes: number;
  hasAnyRow: boolean;
}): boolean {
  return input.dwellElapsedMs >= SPLASH_MIN_DWELL_MS;
}

function splashStatusLine(
  scanning: boolean,
  mark: string,
  rootsLabel: string,
  projects: number,
  caches: number,
  bytes: number,
  width: number,
): string {
  const label = scanning ? SCANNING_LABEL : SETTLED_LABEL;
  const counts = scanCountLine(projects, caches, bytes);
  const root = truncateLabel(rootsLabel, Math.max(0, width));
  return truncateLabel(`${mark} ${label} · ${root} · ${counts}`, Math.max(0, width));
}

/** Lays out title, purpose, and status within `height` lines — pad to center, keep title visible. */
export function splashLayout(
  width: number,
  height: number,
  scanning: boolean,
  mark: string,
  rootsLabel: string,
  projects: number,
  caches: number,
  bytes: number,
): SplashLine[] {
  const body: SplashLine[] = [
    { kind: 'purpose' },
    { kind: 'status', text: splashStatusLine(scanning, mark, rootsLabel, projects, caches, bytes, width) },
  ];
  // Prefer solid five-row brand when the frame can hold it — that is the canvas titling.
  const { lines: titleLines } = splashTitle(width, Math.max(0, height - body.length));
  const title: SplashLine[] = titleLines.map((text) => ({ kind: 'title', text }));
  let content: SplashLine[] = [...title, ...body];

  if (content.length > height) {
    // Keep at least one title row when possible; never drop brand to zero while height allows.
    const titleBudget = Math.max(title.length > 0 ? 1 : 0, height - body.length);
    content = [...title.slice(0, titleBudget), ...body];
    if (content.length > height) {
      content = content.slice(0, height);
    }
  }

  const topPad = Math.floor((height - content.length) / 2);
  const bottomPad = height - content.length - topPad;
  return [
    ...Array<SplashLine>(topPad).fill({ kind: 'pad' }),
    ...content,
    ...Array<SplashLine>(bottomPad).fill({ kind: 'pad' }),
  ];
}

export function Splash({
  width,
  height,
  scanning,
  rootsLabel,
  projects,
  caches,
  bytes,
}: SplashProps): React.ReactElement {
  const spinner = useSpinner(scanning);
  const mark = scanning ? spinner : SETTLED_MARK;
  const lines = splashLayout(width, height, scanning, mark, rootsLabel, projects, caches, bytes);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        switch (line.kind) {
          case 'pad':
            return <Text key={index}> </Text>;
          case 'title':
            return (
              <Text key={index} bold color="cyan">
                {truncateLabel(line.text, Math.max(0, width))}
              </Text>
            );
          case 'purpose':
            return (
              <Text key={index} dimColor>
                {truncateLabel(SPLASH_PURPOSE, Math.max(0, width))}
              </Text>
            );
          case 'status':
            return (
              <Text key={index} color={scanning ? 'cyan' : 'green'} wrap="truncate-end">
                {line.text}
              </Text>
            );
        }
      })}
    </Box>
  );
}
