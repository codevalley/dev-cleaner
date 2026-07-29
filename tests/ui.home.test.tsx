/**
 * Home: default post-splash surface with one reclaim CTA.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { WORDMARK } from '../src/ui/Banner.js';
import { formatBytes } from '../src/ui/format.js';
import { bigTextLines } from '../src/ui/glyphs.js';
import {
  Home,
  clampHomeFocus,
  defaultHomeFocus,
  homeActionLines,
  homeActions,
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
      focusIndex={props.focusIndex}
      foundLabel={props.foundLabel}
      disk={props.disk}
      session={props.session}
    />,
  );
  rendered.push(instance);
  return instance.lastFrame() ?? '';
}

describe('homeActions', () => {
  it('offers reclaim when recommendedCount > 0', () => {
    const lines = homeActionLines(4, 1.9e9);
    expect(lines.join('\n')).toMatch(/enter/);
    expect(lines.join('\n')).toMatch(/reclaim/);
    expect(lines.join('\n')).toMatch(/4 items/);
    expect(lines.join('\n')).toMatch(formatBytes(1.9e9));
    expect(lines.join('\n')).toMatch(/empty Trash/);
  });

  it('hides reclaim when nothing is recommended', () => {
    const lines = homeActionLines(0, 0);
    expect(lines.join('\n')).not.toMatch(/reclaim/);
    expect(lines.join('\n')).toMatch(/browse/);
    expect(homeActions(0, 0)[0]?.id).toBe('browse');
  });

  it('defaults focus to the first row (reclaim or browse), never Trash', () => {
    expect(defaultHomeFocus(4)).toBe(0);
    expect(defaultHomeFocus(0)).toBe(0);
    expect(homeActions(4, 1)[clampHomeFocus(0, 4)]?.id).toBe('reclaim');
    expect(homeActions(0, 0)[clampHomeFocus(0, 3)]?.id).toBe('browse');
  });
});

describe('Home', () => {
  it('offers reclaim when recommendedCount > 0', () => {
    const frame = show({ recommendedCount: 4, recommendedBytes: 1.9e9 });
    expect(frame).toMatch(/enter/);
    expect(frame).toMatch(/reclaim/);
    expect(frame).toMatch(/▸/);
  });

  it('hides reclaim when nothing is recommended', () => {
    const frame = show({ recommendedCount: 0, recommendedBytes: 0 });
    expect(frame).not.toMatch(/reclaim \d/);
    expect(frame).toMatch(/browse/);
  });

  it('draws the solid five-row face when height allows', () => {
    const bytes = 102 * 1024 * 1024;
    const frame = show({
      height: 24,
      width: 80,
      recommendedCount: 1,
      recommendedBytes: bytes,
    });
    const solid = bigTextLines(formatBytes(bytes));
    expect(solid).toBeDefined();
    expect(frame).toContain(solid![0]!);
  });

  it('shows compact mark, counts caption, and disk note when available', () => {
    const frame = show({ disk, recommendedCount: 4, recommendedBytes: 2 * GB });
    expect(frame).toContain(WORDMARK);
    expect(frame).toContain(homeCaptionText(12, 3, 1, disk));
    expect(frame).toContain(homeDiskNote(disk, 2 * GB));
  });

  it('shows live scan progress when provided', () => {
    const frame = show({
      scanning: true,
      foundLabel: 'found 3 projects · 1 caches · 102M so far · b to watch',
    });
    expect(frame).toContain('found 3 projects');
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

  it('keeps the action box bottom border when height is tight', () => {
    const frame = show({
      height: 14,
      width: 60,
      recommendedCount: 1,
      recommendedBytes: GB,
      disk,
      foundLabel: 'found 9 projects · 2 caches · 1.0G so far · b to watch',
      session: '9.0G trashed this session',
    });
    expect(frame).toMatch(/╰─+╯/);
    expect(frame).toMatch(/quit/);
  });
});
