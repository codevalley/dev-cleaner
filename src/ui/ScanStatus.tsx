/**
 * The scan indicator: an animation while the scan runs, and an unambiguous settled state
 * when it stops.
 *
 * # Why this is not decoration
 *
 * Rendering is progressive (see `App.tsx`): rows appear as the walk finds them, for as long
 * as the walk takes. A user watching a list grow has no way to tell "still arriving" from
 * "that's everything" — and the difference matters, because the second one is when it is safe
 * to press enter. The old footer said `scanning…` and then said nothing at all, which made
 * *finished* indistinguishable from *the word was dropped in a re-layout*. Absence is not a
 * state the eye can read. So the settled case says so in words, with a mark of its own.
 *
 * # Why the animation needs a timer, and why the timer needs care
 *
 * Ink re-renders on state change and nothing else. A scan that finds nothing for thirty
 * seconds — entirely ordinary while `dirSize` walks a 67 GB `target/` — produces no events,
 * so a spinner driven by re-renders would freeze on exactly the screen it exists to
 * reassure. It therefore needs its own clock.
 *
 * Two properties follow, and both are load-bearing:
 *
 * 1. **The interval is cleared on unmount.** The effect's cleanup runs when the component
 *    goes away *and* when `active` flips, so a settled scan stops ticking rather than
 *    re-rendering the whole frame ten times a second forever.
 * 2. **The interval cannot hold the process open.** `unref()` is what makes that true. A
 *    CLI whose last act is `exit()` must actually leave; a referenced interval keeps Node's
 *    event loop alive and the terminal hangs after the interface is gone, which reads as a
 *    crash. `unref` is guarded with `?.` because the return of `setInterval` is a `Timeout`
 *    on Node and a number under a DOM lib, and this must not become a load-time crash over
 *    an animation.
 */

import { Text } from 'ink';
import React, { useEffect, useState } from 'react';

import { formatBytes } from './format.js';

/**
 * Braille dots: they occupy one cell, animate by rotation rather than by changing width, and
 * degrade to *something* in every font that has them. A spinner whose frames differ in width
 * shifts the whole line under it on every tick.
 */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Fast enough to read as motion, slow enough not to repaint the frame constantly. */
export const SPINNER_INTERVAL_MS = 90;

/**
 * The settled mark. A glyph *and* a word, never the glyph alone: colour and symbols are the
 * first things to go in a terminal that lacks them, and "is the scan finished" is not a
 * question the user should have to answer from a tick mark.
 */
export const SETTLED_MARK = '✓';
export const SETTLED_LABEL = 'scan complete';
export const SCANNING_LABEL = 'scanning…';

/**
 * The current spinner frame while `active`, and a fixed-width blank when not.
 *
 * A blank rather than nothing, so the line does not shift left by one column the instant the
 * scan finishes — the settled line has to look like the same line, having changed its mind.
 */
export function useSpinner(active: boolean, intervalMs: number = SPINNER_INTERVAL_MS): string {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setTick((current) => current + 1);
    }, intervalMs);
    // See the module note: without this the interval keeps Node's event loop alive and the
    // CLI never exits.
    timer.unref?.();
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);

  if (!active) return ' ';
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0] ?? ' ';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The running count, as one line. Exported as a string function so the copy — the part a
 * user actually reads — is asserted directly rather than through a rendered frame.
 *
 * Caches are counted separately from projects because they are a different kind of thing and
 * a single "17 items" would let a scan that found one project and sixteen caches read as a
 * thorough one.
 */
export function scanCountLine(projects: number, caches: number, bytes: number): string {
  const parts = [plural(projects, 'project')];
  if (caches > 0) parts.push(plural(caches, 'cache'));
  parts.push(formatBytes(bytes));
  return parts.join(' · ');
}

export interface ScanStatusProps {
  scanning: boolean;
  projects: number;
  caches: number;
  bytes: number;
}

export function ScanStatus({
  scanning,
  projects,
  caches,
  bytes,
}: ScanStatusProps): React.ReactElement {
  const spinner = useSpinner(scanning);
  const mark = scanning ? spinner : SETTLED_MARK;
  const label = scanning ? SCANNING_LABEL : SETTLED_LABEL;

  return (
    // `truncate-end` rather than wrapping: this line grows with the project count and the
    // bytes found, so on a narrow terminal it would wrap and cost the list a row — and the
    // frame is a fixed budget in which nothing above the footer may exceed its share.
    <Text color={scanning ? 'cyan' : 'green'} wrap="truncate-end">
      {`${mark} ${label} · ${scanCountLine(projects, caches, bytes)}`}
    </Text>
  );
}
