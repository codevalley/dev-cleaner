/**
 * The pinned command bar: what the keys do, and — on the right — what the session has
 * reclaimed, or what just went wrong.
 *
 * It is *pinned* in the strong sense — it is the last thing in the frame and the frame is sized
 * so that it fits. That is the whole point of the windowed list above it: the footer is the only
 * place the keybindings are written down, so a layout that can push it off the bottom of the
 * terminal leaves the user holding an interface they cannot operate.
 *
 * # Why it is one line now, and what moved
 *
 * It used to be two: the key hints, and a status line reading `preset recommended · selected 8 ·
 * 104G · 9.0G trashed this session`. Everything on that second line was either duplicated
 * elsewhere or in the wrong place. The selection total was the number the user opened the tool
 * to see, printed in the dimmest six characters on the screen; it is now the headline figure
 * (`Banner.tsx`). The preset is configuration and sits with the wordmark. What is genuinely
 * left is a ledger — how much this session has actually put in the Trash — and that fits beside
 * the hints.
 *
 * The height is fixed at one line whatever it is handed. A message appears *on* that line
 * rather than below it, because a second line that came and went would change the frame height
 * every time the user pressed enter on an empty selection — which is exactly the defect the
 * pinning exists to prevent, arriving by a different route.
 *
 * # Why the right-hand column is capped
 *
 * A message can be as long as an operating system wants it to be (`clean failed: EMFILE: too
 * many open files`). Given the whole line it would erase the keybindings, and a user who has
 * just seen an error is precisely the user who needs to know which key gets them out. So the
 * right-hand column may take at most half the bar, and the hints keep the rest.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { truncateLabel } from './format.js';

export const KEY_HINTS =
  'space toggle · a section · j/k move · p preset · enter clean · t Trash · q quit';

export interface FooterProps {
  /** From `sessionSummary` in model.ts. `undefined` until a round has completed. */
  session?: string | undefined;
  message?: string | undefined;
  width: number;
}

export function Footer({ session, message, width }: FooterProps): React.ReactElement {
  const inner = Math.max(0, width - 2);

  // A message displaces the ledger rather than joining it: the ledger is standing information
  // the user can re-read at leisure, the message is about the keystroke they just made.
  const right = truncateLabel(message ?? session ?? '', Math.floor(inner / 2));
  const gap = right.length === 0 ? 0 : 2;
  const hints = truncateLabel(KEY_HINTS, Math.max(0, inner - right.length - gap));
  // Assembled by arithmetic rather than by `justifyContent`, so the three pieces provably sum
  // to `inner` and the bar cannot be one column wider than the terminal on any input.
  const filler = ' '.repeat(Math.max(0, inner - hints.length - right.length));

  return (
    <Box paddingX={1}>
      <Text dimColor>{hints}</Text>
      <Text>{filler}</Text>
      <Text bold={message !== undefined} color={message === undefined ? 'cyan' : 'yellow'}>
        {right}
      </Text>
    </Box>
  );
}
