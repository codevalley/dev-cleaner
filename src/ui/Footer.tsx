/** Pinned contextual actions. Triage reserves two rows; other modes use one.
 * Narrow terminals keep whole key/action pairs, with the full list available under ?.
 * Messages and the session ledger share the secondary row and cannot consume it all.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { truncateLabel } from './format.js';

export type HintMode =
  | 'home'
  | 'triage'
  | 'detail'
  | 'help'
  | 'confirm'
  | 'done'
  | 'trash-confirm'
  | 'screening'
  | 'cleaning';

const HINTS: Record<HintMode, string> = {
  // Help must remain discoverable when narrow terminals omit other actions.
  home: '↑↓ move · enter choose · ? help · q quit',
  triage: 'space toggle · ? help · →/d inspect · enter review',
  detail: 'esc back · ↑↓ scroll · ? help · q quit',
  help: 'esc back · ↑↓ scroll · q quit',
  confirm: 'enter confirm · esc back · q quit',
  done: 'press any key · t empty Trash · q quit',
  'trash-confirm': 'esc cancel · ctrl+c quit',
  screening: 'esc cancel · q quit',
  cleaning: '',
};

export function hintsFor(mode: HintMode): string {
  return HINTS[mode];
}

/** @deprecated Use `hintsFor('triage')` — kept for one release of import churn. */
export const KEY_HINTS = hintsFor('triage');

export interface FooterProps {
  hints: string;
  secondaryHints?: string | undefined;
  /** From `sessionSummary` in model.ts. `undefined` until a round has completed. */
  session?: string | undefined;
  message?: string | undefined;
  width: number;
}

/** Fit complete actions, never dangling letters or half a label. Full list lives under ?. */
export function fitHints(hints: string, width: number): string {
  const kept: string[] = [];
  for (const action of hints.split(' · ')) {
    if ([...kept, action].join(' · ').length <= width) kept.push(action);
  }
  return kept.join(' · ');
}

export const TRIAGE_MORE_HINTS = 'q quit · ↑↓/jk move · a toggle section · p preset · t Trash · esc home';

export function Footer({ hints, secondaryHints, session, message, width }: FooterProps): React.ReactElement {
  const inner = Math.max(0, width - 2);

  // A message displaces the ledger rather than joining it: the ledger is standing information
  // the user can re-read at leisure, the message is about the keystroke they just made.
  const right = truncateLabel(message ?? session ?? '', Math.floor(inner / 2));
  const gap = right.length === 0 ? 0 : 2;
  const shown = fitHints(secondaryHints ?? hints, Math.max(0, inner - right.length - gap));
  // Assembled by arithmetic rather than by `justifyContent`, so the three pieces provably sum
  // to `inner` and the bar cannot be one column wider than the terminal on any input.
  const filler = ' '.repeat(Math.max(0, inner - shown.length - right.length));

  return (
    <Box paddingX={1} flexDirection="column">
      {secondaryHints === undefined ? null : <Text dimColor>{fitHints(hints, inner)}</Text>}
      <Box>
      <Text dimColor>{shown}</Text>
      <Text>{filler}</Text>
      <Text bold={message !== undefined} color={message === undefined ? 'cyan' : 'yellow'}>
        {right}
      </Text>
      </Box>
    </Box>
  );
}
