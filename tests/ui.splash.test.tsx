/**
 * The splash screen: brand on entry, honest handoff once the scan has something to say.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { bigText, LOGO_TEXT, splashTitle } from '../src/ui/Banner.js';
import {
  SPLASH_MIN_DWELL_MS,
  SPLASH_PURPOSE,
  Splash,
  splashReady,
} from '../src/ui/Splash.js';

type Instance = ReturnType<typeof render>;
const rendered: Instance[] = [];

afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

function show(props: Partial<React.ComponentProps<typeof Splash>> = {}): string {
  const instance = render(
    <Splash
      width={props.width ?? 80}
      height={props.height ?? 24}
      scanning={props.scanning ?? true}
      rootsLabel={props.rootsLabel ?? '~/develop'}
      projects={props.projects ?? 3}
      caches={props.caches ?? 1}
      bytes={props.bytes ?? 2 ** 30}
      />,
  );
  rendered.push(instance);
  return instance.lastFrame() ?? '';
}

describe('splashReady', () => {
  it('splashReady waits for min dwell', () => {
    expect(
      splashReady({
        dwellElapsedMs: 100,
        scanning: false,
        recommendedBytes: 1_000_000,
        hasAnyRow: true,
      }),
    ).toBe(false);
  });

  it('splashReady after dwell when recommended bytes exist', () => {
    expect(
      splashReady({
        dwellElapsedMs: 400,
        scanning: true,
        recommendedBytes: 1_000_000,
        hasAnyRow: true,
      }),
    ).toBe(true);
  });

  it('splashReady after dwell when scan finished even if zero reclaim', () => {
    expect(
      splashReady({
        dwellElapsedMs: 400,
        scanning: false,
        recommendedBytes: 0,
        hasAnyRow: false,
      }),
    ).toBe(true);
  });

  it('splashReady after dwell when scanning stalled with rows', () => {
    expect(
      splashReady({
        dwellElapsedMs: 400,
        scanning: true,
        recommendedBytes: 0,
        hasAnyRow: true,
      }),
    ).toBe(true);
  });

  it('splashReady stays while scanning with no rows yet', () => {
    expect(
      splashReady({
        dwellElapsedMs: 400,
        scanning: true,
        recommendedBytes: 0,
        hasAnyRow: false,
      }),
    ).toBe(false);
  });

  it('uses exactly 400ms minimum dwell', () => {
    expect(SPLASH_MIN_DWELL_MS).toBe(400);
    expect(
      splashReady({
        dwellElapsedMs: 399,
        scanning: false,
        recommendedBytes: 0,
        hasAnyRow: false,
      }),
    ).toBe(false);
  });
});

describe('Splash', () => {
  it('shows block title, purpose line, and scanning status', () => {
    const frame = show({ width: 80, scanning: true });
    const [top] = bigText(LOGO_TEXT);
    expect(frame).toContain(top);
    expect(frame).toContain(SPLASH_PURPOSE);
    expect(frame).toContain('scanning');
  });

  it('degrades to WORDMARK when too narrow', () => {
    const frame = show({ width: 10, scanning: true });
    expect(frame).toContain('▓▒░');
    expect(frame).toContain('reclaim');
    expect(frame).toContain('scannin');
  });

  it('renders stacked DEV and CLEANER when width forces it', () => {
    const [d0] = bigText('DEV');
    const [c0] = bigText('CLEANER');
    const stackWidth = Math.max(d0.length, c0.length);
    const stacked = splashTitle(stackWidth);
    expect(stacked.degraded).toBe(false);
    expect(stacked.lines.length).toBeGreaterThan(2);

    const frame = show({ width: stackWidth, scanning: true, height: 24 });
    expect(frame).toContain(d0);
    expect(frame).toContain(c0);
    expect(frame).toContain('reclaim regenerable');
  });

  it('never exceeds the allotted height', () => {
    for (const height of [10, 15, 20, 24]) {
      for (const width of [10, 40, 80]) {
        const frame = show({ width, height, scanning: true });
        expect((frame.split('\n').length), `${width}x${height}`).toBeLessThanOrEqual(height);
      }
    }
  });
});
