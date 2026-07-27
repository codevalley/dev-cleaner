/**
 * The frame must never be taller than the terminal, in any phase, at any size.
 *
 * This is a correctness test wearing a layout costume. Ink redraws by clearing the lines it
 * previously wrote; a frame taller than the terminal leaves the rows it could not clear on
 * screen, which the user sees as a duplicated header. It was reported from a real session and
 * reproduced here: the confirmation pane rendered 26 lines into 24 rows, because its entry
 * caps were constants chosen against a layout that had since grown a byte banner and a prompt
 * box, and because App handed it the whole terminal while spending two rows of its own.
 *
 * Note on widths: ink-testing-library lays out against its own fixed width (100), so a
 * declared width above that makes rows wrap and the frame overflow for reasons that have
 * nothing to do with the app. The widths swept here stay at or below it — otherwise this
 * would be a test of the harness.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../src/ui/App.js';
import type { ScanEvent } from '../src/scan.js';

const proj = (i: number, dormant: boolean): ScanEvent => ({
  kind: 'project',
  project: {
    root: `/s/p${i}`, name: `project-number-${i}`, types: new Set(['rust' as const]),
    artifacts: [{ path: `/s/p${i}/target`, relPath: 'target', category: 'build' as const, bytes: 2 ** 30 }],
    bytes: 2 ** 30,
    git: { branch: 'main', lastCommitMs: 0, hasUncommittedChanges: true, isWorktree: false },
    activity: { status: dormant ? 'dormant' as const : 'active' as const, idleMs: 0, reason: 'edited 3 days ago' },
  },
});
async function* stream(): AsyncIterable<ScanEvent> {
  for (let i = 0; i < 60; i += 1) yield proj(i, i % 2 === 0);
  yield { kind: 'done' } as ScanEvent;
}

describe('frame fits the terminal', () => {
  for (const h of [15, 20, 24, 40]) {
    for (const w of [40, 60, 80, 100]) {
      it(`list phase ${w}x${h}`, async () => {
        const r = render(<App stream={stream()} categoriesFor={() => new Set(['build'])}
          onClean={async () => []} width={w} height={h} />);
        await new Promise((res) => setTimeout(res, 350));
        const lines = (r.lastFrame() ?? '').split('\n');
        r.unmount();
        expect(lines.length).toBeLessThanOrEqual(h);
      });
    }
  }
  it('confirm phase stays inside 24 rows', async () => {
    const r = render(<App stream={stream()} categoriesFor={() => new Set(['build'])}
      onClean={async () => []} width={100} height={24} />);
    await new Promise((res) => setTimeout(res, 350));
    r.stdin.write('\r');
    await new Promise((res) => setTimeout(res, 200));
    const lines = (r.lastFrame() ?? '').split('\n');
    r.unmount();
    expect(lines.length).toBeLessThanOrEqual(24);
  });
});
