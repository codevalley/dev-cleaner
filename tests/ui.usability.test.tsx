import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Home } from '../src/ui/Home.js';
import { Detail, detailLines } from '../src/ui/Detail.js';
import stringWidth from 'string-width';
import { App } from '../src/ui/App.js';
import { categoriesForPreset } from '../src/artifacts.js';
import { buildRows } from '../src/ui/model.js';
import type { Project } from '../src/types.js';
import type { ScanEvent } from '../src/scan.js';
import type { TrashSummary } from '../src/trash.js';

afterEach(cleanup);
const GB = 1024 ** 3;
const project: Project = {
  root: '/projects/example', name: 'example', types: new Set(['node']), bytes: GB,
  activity: { status: 'dormant', idleMs: 100 * 86400000, reason: 'edited 3mo ago' },
  artifacts: [
    ...Array.from({ length: 30 }, (_, i) => ({
      path: `/projects/example/packages/app-${i}/dist`, relPath: `packages/app-${i}/dist`,
      category: 'build' as const, bytes: 1024 ** 2,
    })),
    { path: '/projects/example/node_modules', relPath: 'node_modules', category: 'deps', bytes: GB },
  ],
};
const categories = categoriesForPreset('recommended');
const row = buildRows({ projects: [project], caches: [], categories }).find(r => r.kind === 'project');
async function* stream(): AsyncGenerator<ScanEvent> {
  yield { kind: 'project', project };
  yield { kind: 'done' };
}

describe('Home Trash preview', () => {
  const show = (extra = {}) => render(<Home width={78} height={23} rootsLabel="~/projects"
    scanning={false} recommendedCount={1} recommendedBytes={GB} dormantCount={1}
    activeCount={0} cacheCount={0} {...extra} />).lastFrame() ?? '';

  it('discloses the size of the whole Trash beside the action', () => {
    const frame = show({ trash: { available: true, bytes: 2 * GB, items: 4 }, trashLoading: false });
    expect(frame).toContain('2.0G');
    expect(frame).toContain('4 items');
    expect(frame).toContain('empty Trash');
  });
  it('distinguishes loading and unavailable sizes from an empty Trash', () => {
    expect(show({ trashLoading: true })).toContain('measuring');
    const frame = show({ trash: { available: false, bytes: 0, items: 0, source: 'blind' } });
    expect(frame).toContain('size unavailable');
    expect(frame).not.toContain('0B in Trash');
  });
  it('lets users browse while the first project and Trash measurement are still pending', async () => {
    let finishScan!: () => void;
    const held = new Promise<void>(resolve => { finishScan = resolve; });
    async function* slow(): AsyncGenerator<ScanEvent> { await held; yield { kind: 'done' }; }
    const ui = render(<App stream={slow()} categoriesFor={categoriesForPreset} onClean={async () => []}
      readTrashPreview={async () => { await held; return { available: true, bytes: 0, items: 0 }; }}
      width={80} height={24} />);
    try {
      await expect.poll(() => ui.lastFrame(), { timeout: 2000 }).toContain('b browse');
      expect(ui.lastFrame()).toContain('measuring');
      expect(ui.lastFrame()).toContain('Scanning');
    } finally { finishScan(); ui.unmount(); }
  });
  it('refreshes after cleanup and ignores an older preview that finishes later', async () => {
    let resolveOld!: (value: TrashSummary) => void;
    let reads = 0;
    const old = new Promise<TrashSummary>(resolve => { resolveOld = resolve; });
    const ui = render(<App stream={stream()} categoriesFor={categoriesForPreset}
      readTrashPreview={async () => ++reads === 1 ? old : { available: true, bytes: 2 * GB, items: 4 }}
      onClean={async targets => targets.map(target => ({ target, label: 'dist', bytes: 1024 ** 2, outcome: 'trashed' as const }))}
      width={80} height={24} />);
    const frame = () => ui.lastFrame() ?? '';
    const press = async (key: string) => { await new Promise(r => setTimeout(r, 30)); ui.stdin.write(key); };
    await expect.poll(frame, { timeout: 2500 }).toContain('b browse');
    await press('\r');
    await expect.poll(frame).toContain('Move to Trash?');
    await press('\r');
    await expect.poll(frame).toContain('to the Trash.');
    await expect.poll(() => reads).toBe(2);
    resolveOld({ available: true, bytes: 8 * GB, items: 90 });
    await press('\u001b');
    await expect.poll(frame).toContain('b browse');
    expect(frame()).toContain('2.0G');
    expect(frame()).not.toContain('8.0G');
    ui.unmount();
  });
});

describe('inspection', () => {
  it('preserves spaces and every Unicode path character on narrow screens', () => {
    const relPath = `packages/${'测试'.repeat(15)}/two  spaces/👩🏽‍💻/dist`;
    const unicodeProject: Project = { ...project, root: '/tmp/demo  two', artifacts: [
      { path: `/tmp/demo  two/${relPath}`, relPath, category: 'build', bytes: GB },
    ] };
    const unicodeRow = buildRows({ projects: [unicodeProject], caches: [], categories }).find(r => r.kind === 'project');
    const lines = detailLines(unicodeRow, categories, 36).map(line => line.text);
    const start = lines.findIndex(line => line.startsWith('  packages/'));
    const end = lines.findIndex(line => line.includes('included ·'));
    const pathLines = lines.slice(start, end);
    expect(pathLines.map(line => line.slice(2)).join('')).toBe(relPath + '/');
    expect(pathLines.every(line => stringWidth(line) <= 36)).toBe(true);
    const frame = render(<Detail row={unicodeRow} categories={categories} width={36} height={100} />).lastFrame() ?? '';
    expect(frame).toContain('/tmp/demo  two');
    expect(frame).not.toContain('…');
  });

  it('shows exact project paths and the preset status of dependencies', () => {
    const frame = render(<Detail row={row} categories={categories} width={76} height={150} />).lastFrame() ?? '';
    expect(frame).toContain('/projects/example');
    expect(frame).toContain('packages/app-29/dist');
    expect(frame).toContain('node_modules');
    expect(frame).toContain('kept');
    expect(frame).toContain('included');
  });

  it('opens with right arrow, scrolls to the last artifact, and preserves selection on return', async () => {
    let attempts = 0;
    const ui = render(<App stream={stream()} categoriesFor={categoriesForPreset}
      onClean={async () => { attempts++; return []; }} width={80} height={20} />);
    const frame = () => ui.lastFrame() ?? '';
    const press = async (key: string) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      ui.stdin.write(key);
    };
    await expect.poll(frame, { timeout: 2500 }).toContain('b browse');
    await press('b');
    await expect.poll(frame).toContain('space toggle');
    await press('\u001b[C');
    await expect.poll(frame).toContain('Cleanup candidates');
    for (let page = 0; page < 8 && !frame().includes('node_modules'); page++) {
      await press('\u001b[6~');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(frame()).toContain('node_modules');
    await press('G');
    await expect.poll(frame).not.toContain('Cleanup candidates');
    expect(frame()).toContain('lines');
    await press('g');
    await expect.poll(frame).toContain('Cleanup candidates');
    await press('\u001b[D');
    await expect.poll(frame).toContain('selected 1');
    await press('?');
    await expect.poll(frame).toContain('Keyboard help');
    expect(frame()).toContain('toggle section');
    await press('\u001b');
    await expect.poll(frame).toContain('selected 1');
    expect(attempts).toBe(0);
    ui.unmount();
  });
});
