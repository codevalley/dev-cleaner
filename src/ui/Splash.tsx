/**
 * Brand entry while the scan starts. Tall wordmark, one purpose line, scan pulse.
 *
 * `splashReady` is the handoff contract: minimum dwell so the mark is perceptible, then leave
 * once the scan has finished, a recommended total exists, or rows have arrived while the walk
 * is still running.
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

export const SPLASH_MIN_DWELL_MS = 400;
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

/** Pure: may leave splash when dwell elapsed AND (scan done OR recommendedBytes > 0 OR scanning stalled with rows). */
export function splashReady(input: {
  dwellElapsedMs: number;
  scanning: boolean;
  recommendedBytes: number;
  hasAnyRow: boolean;
}): boolean {
  if (input.dwellElapsedMs < SPLASH_MIN_DWELL_MS) return false;
  if (!input.scanning) return true;
  if (input.recommendedBytes > 0) return true;
  if (input.hasAnyRow) return true;
  return false;
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

/** Lays out title, purpose, and status within `height` lines — pad to center, truncate title if needed. */
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
  const { lines: titleLines } = splashTitle(width);
  const body: SplashLine[] = [
    { kind: 'purpose' },
    { kind: 'status', text: splashStatusLine(scanning, mark, rootsLabel, projects, caches, bytes, width) },
  ];
  const title: SplashLine[] = titleLines.map((text) => ({ kind: 'title', text }));
  let content: SplashLine[] = [...title, ...body];

  if (content.length > height) {
    const titleBudget = Math.max(0, height - body.length);
    content = [...title.slice(-titleBudget), ...body];
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
