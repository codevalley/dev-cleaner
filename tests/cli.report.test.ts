/**
 * The wiring, end to end: `dev-cleaner ~/develop | less` must print a report whose total is
 * what a clean would actually deliver.
 *
 * `src/report.ts` can screen all it likes; if `runStaticReport` calls the unscreened renderer
 * the piped report goes on promising space the boundary then refuses — and the piped report
 * is the only view a CI job or a `| less` user ever gets. So these tests drive `main` on a
 * non-TTY stdout, against a **real** tree, and assert the marks, the reasons and the
 * arithmetic that come out the other end.
 *
 * Projects are constructed with `activity.status === 'dormant'` directly rather than scored:
 * `scoreActivity` ships as a stub returning `active` for everything, and a test that leaned
 * on it would assert nothing at all — nothing dormant, nothing selected, nothing promised.
 */

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { main, type CliIO, type MainDeps } from '../src/cli.js';
import type { ActivityScore, CacheEntry, Category, CleanOutcome, Preset, Project } from '../src/types.js';
import { file, fixture, worktree, type Fixture } from './fixture.js';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const DANGLING_GITDIR = '/nonexistent/repo/.git/worktrees/build';

const DORMANT: ActivityScore = { status: 'dormant', idleMs: 240 * DAY, reason: 'no commits' };

const CATEGORIES: Record<Preset, Set<Category>> = {
  recommended: new Set<Category>(['build', 'cache']),
  aggressive: new Set<Category>(['build', 'deps', 'cache']),
  custom: new Set<Category>(['build']),
};

let fx: Fixture;

function fakeIO(): CliIO & { out(): string } {
  const stdout: string[] = [];
  return {
    isTTY: false,
    write: (text: string) => void stdout.push(text),
    writeError: () => undefined,
    out: () => stdout.join(''),
  };
}

function project(root: string, relPath: string, bytes: number): Project {
  return {
    root,
    name: path.basename(root),
    types: new Set(['node' as const]),
    artifacts: [{ path: path.join(root, relPath), relPath, category: 'build', bytes }],
    bytes,
    activity: DORMANT,
  };
}

async function entries(root: string): Promise<string[]> {
  const seen: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(dir, entry.name);
      seen.push(`${rel}/${entry.name}`);
      if ((await lstat(absolute)).isDirectory()) await walk(absolute, `${rel}/${entry.name}`);
    }
  };
  await walk(root, '');
  return seen;
}

interface RunResult {
  code: number;
  out: string;
  runApp: ReturnType<typeof vi.fn>;
  clean: ReturnType<typeof vi.fn>;
}

/** `main` on a non-TTY stdout, with the scan stubbed and everything else real. */
async function run(
  argv: readonly string[],
  result: { projects: Project[]; caches: CacheEntry[] },
  overrides: Partial<MainDeps> = {},
): Promise<RunResult> {
  const io = fakeIO();
  const runApp = vi.fn(async () => ({
    cleaned: false,
    outcomes: [] as CleanOutcome[],
    trashedBytes: 0,
    rounds: 0,
    trashEmptied: false,
  }));
  const clean = vi.fn(async () => [] as CleanOutcome[]);
  const deps: MainDeps = {
    io,
    nowMs: NOW,
    scanAll: vi.fn(async () => result),
    scanStream: vi.fn(),
    runApp,
    clean,
    categoriesFor: (preset: Preset) => new Set(CATEGORIES[preset]),
    resolveScanRoot: async (root: string) => root,
    trash: async () => undefined,
    ...overrides,
  };

  return { code: await main([...argv], deps), out: io.out(), runApp, clean };
}

beforeAll(async () => {
  fx = await fixture({
    'scan/bump/dist/app.js': 'console.log(1)\n',
    'scan/tinysync/target/build.bin': file('x', { size: 2048 }),
    // `git worktree add build feature`: real source, wearing a name the artifact table claims.
    'scan/worktree-app/build': worktree(DANGLING_GITDIR),
  });
});

afterAll(async () => {
  await fx.cleanup();
});

describe('the piped report promises only what the boundary would deliver', () => {
  it('marks a row the run would refuse, explains it, and leaves it out of the total', async () => {
    const { code, out } = await run([fx.path('scan')], {
      projects: [
        project(fx.path('scan/bump'), 'dist', 3 * GB),
        project(fx.path('scan/worktree-app'), 'build', 9 * GB),
      ],
      caches: [],
    });

    expect(code).toBe(0);
    // Before this wiring the report read `Selected by default: 2 items · 12.0G`, and the
    // run then refused 9G of it — the promise the tool could not keep.
    expect(out).toContain('Selected by default: 1 item · 3.0G');
    expect(out).toMatch(/\[-\]\s+worktree-app/);
    expect(out).toMatch(/\[x\]\s+bump/);
    expect(out).toContain('blocked: worktree-root:');
    expect(out).toMatch(/Blocked \(not safe\):\s+1 item · 9\.0G/);
    // Still listed, and the section header still describes the disk.
    expect(out).toContain('PROJECTS  ·  2 items  ·  12.0G');
  });

  it('promises everything when everything is deliverable', async () => {
    const { out } = await run([fx.path('scan')], {
      projects: [
        project(fx.path('scan/bump'), 'dist', 3 * GB),
        project(fx.path('scan/tinysync'), 'target', 9 * GB),
      ],
      caches: [],
    });

    expect(out).toContain('Selected by default: 2 items · 12.0G');
    expect(out).not.toContain('[-]');
    expect(out).not.toContain('Blocked');
  });

  it('screens against the RESOLVED roots, as clean.ts’s containment check does', async () => {
    // `main` replaces the roots with their realpaths before either path runs. Screening with
    // the lexical ones would refuse every project as `outside-project-root` — on macOS that
    // is the everyday case, where `/var/...` really is `/private/var/...`.
    const { out } = await run(
      ['scan-alias'],
      { projects: [project(fx.path('scan/bump'), 'dist', 3 * GB)], caches: [] },
      { resolveScanRoot: async () => fx.path('scan') },
    );

    expect(out).toMatch(/\[x\]\s+bump/);
    expect(out).not.toContain('outside-project-root');
    expect(out).toContain('Selected by default: 1 item · 3.0G');
  });

  it('screens without deleting, rendering or cleaning anything', async () => {
    // The degradation rule is a negative property, and screening must not weaken it: it
    // reads the filesystem to answer a question and leaves it exactly as it found it.
    const before = await entries(fx.root);
    const { code, out, runApp, clean } = await run([fx.path('scan')], {
      projects: [
        project(fx.path('scan/worktree-app'), 'build', 9 * GB),
        project(fx.path('scan/bump'), 'dist', 3 * GB),
      ],
      caches: [],
    });

    expect(code).toBe(0);
    expect(await entries(fx.root)).toEqual(before);
    expect(runApp).not.toHaveBeenCalled();
    expect(clean).not.toHaveBeenCalled();
    expect(out).toMatch(/nothing was deleted/i);
  });
});
