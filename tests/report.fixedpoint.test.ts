/**
 * Screening the report has to reach a fixed point, because blocking a row can *add* a
 * refusal rather than only removing work.
 *
 * Every refusal reason but one is a property of a single target, so a second screening round
 * could only ever shrink the promised set. Invariant 5 is the exception: `store-prune-unsafe`
 * depends on `unselectedNodeModules` — which hardlink sources will still be on disk when the
 * run finishes — and that is a property of the whole selection. Block a project row and its
 * `node_modules` leaves the cleaned set, joins `unselectedNodeModules`, and can make a store
 * prune unsafe that screened clean moments earlier.
 *
 * An earlier version screened the pre-block selection exactly once and asserted in a comment
 * that later rounds "would only ever remove work, never add a refusal". True of every reason
 * except the one the screening exists for.
 *
 * This test is written so that a single-round implementation fails it: with MAX_ROUNDS = 1
 * the store is promised, with the fixed point it is blocked.
 */

import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderScreenedReport } from '../src/report.js';
import type { CacheEntry, Category, Project } from '../src/types.js';
import { fixture, type Fixture } from './fixture.js';

const GB = 1024 ** 3;
const AGGRESSIVE: ReadonlySet<Category> = new Set<Category>(['build', 'deps', 'cache']);

let fx: Fixture;

beforeAll(async () => {
  fx = await fixture({
    // `dist` is a real repository — the gh-pages deploy layout — so the full tier blocks the
    // whole `app` row. That is round one.
    'scan/app/package.json': '{ "name": "app" }\n',
    'scan/app/dist/.git/HEAD': 'ref: refs/heads/gh-pages\n',
    'scan/app/dist/index.html': '<!doctype html>\n',
    // ...which drops this from the cleaned set, and *that* is what makes the store unsafe.
    'scan/app/node_modules/.package-lock.json': '{}\n',
    // An ordinary project, so the report still has something to promise.
    'scan/lib/package.json': '{ "name": "lib" }\n',
    'scan/lib/dist/out.js': 'export const x = 1;\n',
    'caches/pnpm/store/v3/files/aa/deadbeef': 'x',
  });
});

afterAll(async () => {
  await fx?.cleanup();
});

function project(root: string, artifacts: ReadonlyArray<[string, Category]>): Project {
  const built = artifacts.map(([relPath, category]) => ({
    path: path.join(root, relPath),
    relPath,
    category,
    bytes: GB,
  }));
  return {
    root,
    name: path.basename(root),
    types: new Set(['node' as const]),
    artifacts: built,
    bytes: built.reduce((sum, a) => sum + a.bytes, 0),
    activity: { status: 'dormant', idleMs: 400 * 86_400_000, reason: 'test' },
  };
}

function storeCache(): CacheEntry {
  // Deliberately NOT pre-blocked by caches.ts: this test is about the report's own screening
  // reaching a fixed point, not about the cheap hardlink probe that runs earlier.
  return {
    id: 'pnpm-store',
    label: 'pnpm store',
    path: fx.path('caches/pnpm/store'),
    bytes: 8 * GB,
    note: 'hardlink target for project node_modules',
  };
}

describe('report screening reaches a fixed point', () => {
  it('blocks a store prune that only becomes unsafe once another row is blocked', async () => {
    const out = await renderScreenedReport({
      projects: [
        project(fx.path('scan/app'), [
          ['dist', 'build'],
          ['node_modules', 'deps'],
        ]),
        project(fx.path('scan/lib'), [['dist', 'build']]),
      ],
      caches: [storeCache()],
      categories: AGGRESSIVE,
      preset: 'aggressive',
      roots: [fx.root],
    });

    const line = (label: string): string =>
      out.split('\n').find((l) => l.includes(`] ${label}`)) ?? '';

    // Round one: `app` is a repository, so it is blocked and its node_modules is not cleaned.
    expect(line('app')).toContain('[-]');

    // Round two: with app/node_modules left on disk, pruning the store would orphan its
    // hardlinks. A single-round screen promises this row; the fixed point refuses it.
    expect(line('pnpm store')).toContain('[-]');
    expect(out).toMatch(/pnpm store[\s\S]*?blocked:/);

    // And the honest consequence: the store's bytes are not in the promised total.
    const promised = /Selected by default:.*·\s*([\d.]+)([KMGT])/.exec(out);
    expect(promised).not.toBeNull();
    expect(out).toContain('Blocked (not safe)');

    // `lib` is untouched by any of this and must still be promised — otherwise the test
    // would pass against an implementation that simply blocks everything.
    expect(line('lib')).toContain('[x]');
  });
});
