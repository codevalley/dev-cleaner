/**
 * Key hints and the running total of the current selection.
 *
 * The scan indicator is load-bearing for trust rather than decoration: the interface
 * renders before the scan finishes (spec: "Progressive rendering"), so without it a
 * half-scanned list is indistinguishable from a finished one, and a user could confirm a
 * clean believing they had seen everything.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { formatBytes } from './format.js';
import type { Preset } from '../types.js';

export const KEY_HINTS = 'space toggle · a all · p preset · enter clean · q quit';

export interface FooterProps {
  preset: Preset;
  selectedCount: number;
  selectedBytes: number;
  scanning: boolean;
  message?: string | undefined;
}

export function Footer({
  preset,
  selectedCount,
  selectedBytes,
  scanning,
  message,
}: FooterProps): React.ReactElement {
  const status = [
    `preset ${preset}`,
    `selected ${selectedCount}`,
    formatBytes(selectedBytes),
    ...(scanning ? ['scanning…'] : []),
  ].join(' · ');

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>{KEY_HINTS}</Text>
      <Text>
        <Text color="cyan">{status}</Text>
        {message === undefined ? null : <Text color="yellow">{`  ${message}`}</Text>}
      </Text>
    </Box>
  );
}
