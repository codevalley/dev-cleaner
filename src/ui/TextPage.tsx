/** Bounded, scrollable text shared by inspection and keyboard help. */
import React from 'react';
import { Box, Text } from 'ink';
import { truncateLabel } from './format.js';

export interface PageLine {
  text: string;
  dim?: boolean;
  bold?: boolean;
  color?: string;
}

export function pageOffset(offset: number, length: number, height: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, length - Math.max(1, height - 1))));
}

export function TextPage({ lines, offset = 0, width, height }: {
  lines: readonly PageLine[]; offset?: number; width: number; height: number;
}): React.ReactElement {
  const room = Math.max(1, height - 1);
  const start = pageOffset(offset, lines.length, height);
  const shown = lines.slice(start, start + room);
  return <Box flexDirection="column">
    {shown.map((line, index) => <Text key={start + index} dimColor={line.dim === true}
      bold={line.bold === true} {...(line.color === undefined ? {} : { color: line.color })}
      wrap="truncate-end">{line.text}</Text>)}
    {height > 1 ? <Text dimColor wrap="truncate-end">{truncateLabel(
      lines.length > room
        ? `lines ${start + 1}–${Math.min(lines.length, start + room)} of ${lines.length} · ↑↓ scroll · pgup/pgdn`
        : 'all contents shown', width)}</Text> : null}
  </Box>;
}
