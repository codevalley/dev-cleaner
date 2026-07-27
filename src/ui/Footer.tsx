/**
 * The pinned command bar: what the keys do, what is selected, and what the session has
 * reclaimed so far.
 *
 * It is *pinned* in the strong sense — it is the last thing in the frame and the frame is
 * sized so that it fits. That is the whole point of the windowed list above it: the footer is
 * the only place the keybindings are written down, so a layout that can push it off the
 * bottom of the terminal leaves the user holding an interface they cannot operate.
 *
 * The height is fixed at two lines, whatever it is handed. A message appears *on* the status
 * line rather than below it, because a third line that comes and goes would change the frame
 * height every time the user pressed enter on an empty selection — which is exactly the
 * defect the pinning exists to prevent, arriving by a different route.
 *
 * The running session total lives here rather than in the header because it is a *result*,
 * and results belong next to the selection they came from. It is absent until there is one:
 * `sessionSummary` returns `undefined` before the first round, and "0B reclaimed" reads as a
 * failure report rather than as an empty ledger.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { formatBytes, truncateLabel } from './format.js';
import type { Preset } from '../types.js';

export const KEY_HINTS =
  'space toggle · a section · j/k move · p preset · enter clean · t Trash · q quit';

export interface FooterProps {
  preset: Preset;
  selectedCount: number;
  selectedBytes: number;
  /** From `sessionSummary` in model.ts. `undefined` until a round has completed. */
  session?: string | undefined;
  message?: string | undefined;
  width: number;
}

export function Footer({
  preset,
  selectedCount,
  selectedBytes,
  session,
  message,
  width,
}: FooterProps): React.ReactElement {
  const status = [
    `preset ${preset}`,
    `selected ${selectedCount}`,
    formatBytes(selectedBytes),
    ...(session === undefined ? [] : [session]),
  ].join(' · ');

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>{truncateLabel(KEY_HINTS, Math.max(0, width - 2))}</Text>
      {/* Truncated for the same reason the hints line above is: the docstring promises this
          component is exactly two lines whatever it is handed, and an untruncated status —
          which grows with a session total and a message — wraps to three and pushes the
          frame past the terminal height, un-pinning the footer the viewport work pins. */}
      <Text>
        <Text color="cyan">{truncateLabel(status, Math.max(0, width - 2))}</Text>
        {message === undefined ? null : (
          <Text color="yellow">
            {truncateLabel(`  ${message}`, Math.max(0, width - 2 - status.length))}
          </Text>
        )}
      </Text>
    </Box>
  );
}
