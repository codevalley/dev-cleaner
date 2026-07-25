/**
 * The second confirmation. `enter` in the list opens this; `enter` here is what actually
 * runs `clean`.
 *
 * It lists the selected rows rather than the individual `CleanTarget`s: a user recognises
 * "tinysync 67.0G", not "tinysync/apps/macos/build". The target count is still shown, so
 * the number of separate deletes is never hidden behind a tidy summary.
 *
 * The Trash disclosure appears here as well as in the post-run summary (invariant 8). A
 * user deciding whether to proceed is exactly who needs to know that the space does not
 * come back until the Trash is emptied.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { BYTES_WIDTH, formatBytes, formatBytesPadded, padLabel } from './format.js';
import type { Row } from './model.js';

/** Beyond this, the list is summarised — a confirmation nobody can read is not one. */
const MAX_LISTED = 12;

export interface ConfirmProps {
  rows: readonly Row[];
  targetCount: number;
  bytes: number;
  width: number;
}

export function Confirm({ rows, targetCount, bytes, width }: ConfirmProps): React.ReactElement {
  const listed = rows.slice(0, MAX_LISTED);
  const hidden = rows.length - listed.length;
  const labelWidth = Math.max(12, width - BYTES_WIDTH - 4);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="yellow">
        Move to Trash?
      </Text>
      <Text> </Text>
      {listed.map((row) => (
        <Text key={row.id}>
          {`  ${padLabel(row.label, labelWidth)} ${formatBytesPadded(row.bytes)}`}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>{`  …and ${hidden} more`}</Text> : null}
      <Text> </Text>
      <Text bold>
        {`  ${formatBytes(bytes)} across ${targetCount} ${targetCount === 1 ? 'directory' : 'directories'}`}
      </Text>
      <Text dimColor>{'  Trash still holds the space until you empty it.'}</Text>
      <Text> </Text>
      <Text dimColor>enter confirm · esc cancel · q quit</Text>
    </Box>
  );
}
