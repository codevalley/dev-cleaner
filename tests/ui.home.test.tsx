/**
 * Home: default post-splash surface with one reclaim CTA.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { WORDMARK } from '../src/ui/Banner.js';
import { formatBytes } from '../src/ui/format.js';
import {
  Home,
  homeActionLines,
  homeCaptionText,
  homeDiskNote,
} from '../src/ui/Home.js';
import type { DiskUsage } from '../src/ui/diskbar.js';

type Instance = ReturnType<typeof render>;
const rendered: Instance[] = [];

afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

const GB = 1024 ** 3;

const disk: DiskUsage = { total: 500 * GB, used: 400 * GB, free: 100 * GB };

function show(props: Partial<React.ComponentProps<typeof Home>> = {}): string {
  const instance = render(
    <Home
      width={props.width ?? 80}
      height={props.height ?? 24}
      rootsLabel={props.rootsLabel ?? '~/develop'}
      scanning={props.scanning ?? false}
      recommendedCount={props.recommendedCount ?? 4}
      recommendedBytes={props.recommendedBytes ?? 1.9e9}
      dormantCount={props.dormantCount ?? 12}
      activeCount={props.activeCount ?? 3}
      cacheCount={props.cacheCount ?? 1}
      disk={props.disk}
      session={props.session}
    />,
  );
  rendered.push(instance);
  return instance.lastFrame() ?? '';
}

describe('homeActionLines', () => {
  it('offers enter reclaim when recommendedCount > 0', () => {
    const lines = homeActionLines(4, 1.9e9);
    expect(lines.join('\n')).toMatch(/enter/);
    expect(lines.join('\n')).toMatch(/recommended/);
    expect(lines.join('\n')).toMatch(/4 items/);
    expect(lines.join('\n')).toMatch(formatBytes(1.9e9));
  });

  it('hides enter reclaim when nothing is recommended', () => {
    const lines = homeActionLines(0, 0);
    expect(lines.join('\n')).not.toMatch(/trash the recommended/);
    expect(lines.join('\n')).toMatch(/nothing recommended/);
    expect(lines.join('\n')).toMatch(/browse/);
  });
});

describe('Home', () => {
  it('offers enter reclaim when recommendedCount > 0', () => {
    const frame = show({ recommendedCount: 4, recommendedBytes: 1.9e9 });
    expect(frame).toMatch(/enter/);
    expect(frame).toMatch(/recommended/);
  });

  it('hides enter reclaim when nothing is recommended', () => {
    const frame = show({ recommendedCount: 0, recommendedBytes: 0 });
    expect(frame).not.toMatch(/trash the recommended/);
    expect(frame).toMatch(/browse/);
  });

  it('shows compact mark, counts caption, and disk note when available', () => {
    const frame = show({ disk, recommendedCount: 4, recommendedBytes: 2 * GB });
    expect(frame).toContain(WORDMARK);
    expect(frame).toContain(homeCaptionText(12, 3, 1, disk));
    expect(frame).toContain(homeDiskNote(disk, 2 * GB));
  });

  it('shows session ledger when provided', () => {
    const frame = show({ session: '9.0G trashed this session' });
    expect(frame).toContain('9.0G trashed this session');
  });

  it('never exceeds the allotted height', () => {
    for (const height of [10, 15, 20, 24]) {
      for (const width of [40, 60, 80]) {
        const frame = show({ width, height, recommendedCount: 0, recommendedBytes: 0 });
        expect(frame.split('\n').length, `${width}x${height}`).toBeLessThanOrEqual(height);
      }
    }
  });
});
