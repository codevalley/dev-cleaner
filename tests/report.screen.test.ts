/**
 * The static report against the defect it exists to close: **the report shows what is
 * selected, `clean` decides what is deletable, and when those are computed by different code
 * the tool promises space it then refuses.**
 *
 * One instance of that was already fixed — the pnpm store is screened in `caches.ts` before
 * selection, and `CacheEntry.blocked` carries the verdict — but an instance is not the class.
 * Two holes remained, and both are asserted here:
 *
 * 1. **Only the store was screened.** Any other cache could be promised and then refused.
 *    `mv ~/.gradle /Volumes/SSD/gradle && ln -s /Volumes/SSD/gradle ~/.gradle` is an ordinary
 *    thing to do when short of disk, and `listCaches` decides presence with an `lstat` of the
 *    *final* component, so the symlinked ancestor is invisible to it — the boundary refuses
 *    the delete, and the user reads a refusal for something the report had marked `[x]`.
 * 2. **Project rows got no pre-consent screening at all.** `defaultSelection` added every
 *    dormant project row unconditionally. That is invisible today only because `scoreActivity`
 *    ships as a stub returning `active` for everything — so nothing is ever dormant, so
 *    nothing is ever preselected. Every project below is therefore constructed with
 *    `activity.status === 'dormant'` **directly**, never via the scorer: these tests must
 *    describe the code path that goes live the day the scorer is authored, not the accident
 *    that hides it today.
 *
 * The vetting itself is not reimplemented here — that would be the same bug with the polarity
 * flipped. `screenReport` calls `clean.ts`'s exported guards, and what these tests pin is the
 * wiring: which tier runs where, which rows are marked, which bytes are promised, and that
 * nothing on disk is touched to find out.
 */

import { lstat, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clean } from '../src/clean.js';
import { renderScreenedReport, screenReport } from '../src/report.js';
import { formatBytes } from '../src/ui/format.js';
import {
  buildRows,
  defaultSelection,
  isSelected,
  selectedBytes,
  toTargets,
  toggleRow,
  type Row,
} from '../src/ui/model.js';
import type { ActivityScore, CacheEntry, Category, Project } from '../src/types.js';
import { file, fixture, worktree, type Fixture } from './fixture.js';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

const RECOMMENDED = new Set<Category>(['build', 'cache']);
const AGGRESSIVE = new Set<Category>(['build', 'deps', 'cache']);

/** Never `scoreActivity`. The stub returns `active` for everything, which would make every
 * assertion below pass for the wrong reason: nothing selected, so nothing to promise. */
const DORMANT: ActivityScore = { status: 'dormant', idleMs: 240 * DAY, reason: 'last commit 8mo ago' };
const ACTIVE: ActivityScore = { status: 'active', idleMs: 2 * DAY, reason: 'committed 2d ago' };

const DANGLING_GITDIR = '/nonexistent/repo/.git/worktrees/build';

let fx: Fixture;

interface ArtifactSpec {
  relPath: string;
  bytes: number;
  category?: Category;
  /** An absolute path, for the cases where the artifact is deliberately not under the root. */
  path?: string;
}

interface ProjectSpec {
  /** Absolute project root. */
  root: string;
  name?: string;
  activity?: ActivityScore;
  artifacts: readonly ArtifactSpec[];
}

function project(spec: ProjectSpec): Project {
  const artifacts = spec.artifacts.map((artifact) => ({
    path: artifact.path ?? path.join(spec.root, artifact.relPath),
    relPath: artifact.relPath,
    category: artifact.category ?? ('build' as Category),
    bytes: artifact.bytes,
  }));
  return {
    root: spec.root,
    name: spec.name ?? path.basename(spec.root),
    types: new Set(['node' as const]),
    artifacts,
    bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    activity: spec.activity ?? DORMANT,
  };
}

function cache(overrides: Partial<CacheEntry> & Pick<CacheEntry, 'id' | 'path'>): CacheEntry {
  return {
    label: overrides.id,
    bytes: GB,
    note: 'regenerable',
    ...overrides,
  };
}

interface ReportSpec {
  projects?: readonly Project[];
  caches?: readonly CacheEntry[];
  categories?: ReadonlySet<Category>;
}

async function report(spec: ReportSpec): Promise<string> {
  return await renderScreenedReport({
    projects: spec.projects ?? [],
    caches: spec.caches ?? [],
    categories: spec.categories ?? RECOMMENDED,
    preset: 'recommended',
    roots: [fx.path('scan')],
  });
}

function lineFor(out: string, label: string): string {
  return out.split('\n').find((line) => line.includes(`] ${label}`)) ?? '';
}

/** The `blocked:` lines, so "explained exactly once" is a countable claim. */
function blockedLines(out: string): string[] {
  return out
    .split('\n')
    .filter((line) => line.trim().startsWith('blocked:'))
    .map((line) => line.trim());
}

/** Every path under `root` with its type and size — the proof that a screen wrote nothing. */
async function snapshot(root: string): Promise<string[]> {
  const seen: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = `${rel}/${entry.name}`;
      const stats = await lstat(absolute);
      const kind = stats.isSymbolicLink()
        ? 'link'
        : stats.isDirectory()
          ? 'dir'
          : `file:${stats.size}`;
      seen.push(`${relative} ${kind}`);
      if (stats.isDirectory()) await walk(absolute, relative);
    }
  };
  await walk(root, '');
  return seen;
}

beforeAll(async () => {
  fx = await fixture({
    // Ordinary, deliverable: nothing objects to any of it.
    'scan/tinysync/target/build.bin': file('x', { size: 4096 }),
    'scan/bump/dist/app.js': 'console.log(1)\n',

    // `git worktree add build feature` — real source with a name the artifact table claims.
    'scan/worktree-app/build': worktree(DANGLING_GITDIR),

    // `git clone -b gh-pages <repo> dist` — the candidate is itself a repository.
    'scan/deploy-clone/dist/.git/HEAD': 'ref: refs/heads/gh-pages\n',

    // A repository *inside* the candidate: only a walk of the contents can see it.
    'scan/nested-dormant/dist/site/.git/HEAD': 'ref: refs/heads/main\n',
    'scan/nested-active/dist/site/.git/HEAD': 'ref: refs/heads/main\n',

    // An artifact that is a symlink, and an artifact behind a symlinked ancestor.
    'scan/linked/real-dist/app.js': 'x\n',
    'scan/moved/real/dist/app.js': 'x\n',

    // An artifact that is not under its project root, and one the table does not claim.
    'scan/escapee/dist/app.js': 'x\n',
    'scan/sources/src/index.ts': 'export {}\n',

    // The package store, and a project whose node_modules hardlinks into it.
    'scan/pnpm-app/node_modules/.pnpm/left-pad/index.js': 'module.exports = 1\n',
    'caches/pnpm/store/files/aa/1111': 'payload\n',
    'caches/npm/_cacache/index': 'x\n',

    // ~/.gradle moved to an external disk and symlinked back — hole (a), verbatim.
    'ssd/gradle/caches/modules-2/files/x': 'jar\n',
  });

  // Created after the fixture exists, so every link target can be an absolute real path.
  // `scan/linked/dist` is an artifact that IS a link; `scan/moved/link` is a link on the way
  // to one, which is the case an `lstat` of the final component cannot see.
  await symlink(fx.path('scan/linked/real-dist'), fx.path('scan/linked/dist'));
  await symlink(fx.path('scan/moved/real'), fx.path('scan/moved/link'));
  await symlink(fx.path('ssd/gradle'), fx.path('home-gradle'));
});

afterAll(async () => {
  await fx.cleanup();
});

describe('the promised total is what the boundary would actually deliver', () => {
  it('excludes a project whose artifact is a linked git worktree, and says why', async () => {
    const out = await report({
      projects: [
        project({ root: fx.path('scan/bump'), artifacts: [{ relPath: 'dist', bytes: GB }] }),
        project({
          root: fx.path('scan/worktree-app'),
          artifacts: [{ relPath: 'build', bytes: 2 * GB }],
        }),
      ],
    });

    // Before the fix this row was `[x]` and the total read 3.0G — of which `clean` would
    // have delivered 1.0G and refused the rest at the last moment.
    expect(lineFor(out, 'worktree-app')).toContain('[-]');
    expect(lineFor(out, 'worktree-app')).not.toContain('[x]');
    expect(lineFor(out, 'bump')).toContain('[x]');
    expect(out).toContain('worktree-root');
    expect(out).toMatch(/blocked: worktree-root: .*linked git worktree/);
    expect(out).toContain('Selected by default: 1 item · 1.0G');
    expect(out).toMatch(/Blocked \(not safe\):\s+1 item · 2\.0G/);
    expect(out).toContain('excluded from the total above');
  });

  it('still lists the blocked row and still counts it on the disk', async () => {
    // Protection is a default, not a lock, and the disk really does hold those bytes:
    // hiding the row would be a different lie from promising it.
    const out = await report({
      projects: [
        project({
          root: fx.path('scan/worktree-app'),
          artifacts: [{ relPath: 'build', bytes: 2 * GB }],
        }),
      ],
    });

    expect(out).toContain('worktree-app');
    expect(out).toContain('PROJECTS  ·  1 item  ·  2.0G');
    expect(out).toContain('Selected by default: 0 items · 0B');
  });

  it('keeps the promised total equal to the sum of the rows it marked', async () => {
    const out = await report({
      projects: [
        project({ root: fx.path('scan/bump'), artifacts: [{ relPath: 'dist', bytes: GB }] }),
        project({
          root: fx.path('scan/tinysync'),
          artifacts: [{ relPath: 'target', bytes: 4 * GB }],
        }),
        project({
          root: fx.path('scan/deploy-clone'),
          artifacts: [{ relPath: 'dist', bytes: 8 * GB }],
        }),
      ],
      caches: [cache({ id: 'npm', path: fx.path('caches/npm/_cacache'), bytes: 2 * GB })],
    });

    const marked = out.split('\n').filter((line) => line.includes('[x]'));
    expect(marked).toHaveLength(3);
    expect(out).toContain('Selected by default: 3 items · 7.0G');
    expect(out).toMatch(/Blocked \(not safe\):\s+1 item · 8\.0G/);
  });

  it('says nothing about blocked rows when every row is deliverable', async () => {
    // The other direction, and the one a screen that refused everything would fail: a report
    // that blocks the whole disk is exactly as useless as one that blocks nothing.
    const out = await report({
      projects: [
        project({ root: fx.path('scan/bump'), artifacts: [{ relPath: 'dist', bytes: GB }] }),
        project({
          root: fx.path('scan/tinysync'),
          artifacts: [{ relPath: 'target', bytes: 4 * GB }],
        }),
      ],
      caches: [cache({ id: 'npm', path: fx.path('caches/npm/_cacache'), bytes: 2 * GB })],
    });

    expect(out).not.toContain('[-]');
    expect(out).not.toContain('Blocked');
    expect(out).not.toContain('blocked:');
    expect(out).toContain('Selected by default: 3 items · 7.0G');
  });
});

describe('the promise and the delivery, measured against each other', () => {
  it('promises exactly the bytes a clean of that same default selection then delivers', async () => {
    // The defect, stated as one equality. Everything else in this file is a symptom of it:
    // the report's total and `clean`'s trashed total are computed by different code, and the
    // only way to know they agree is to run both over one arrangement and subtract.
    const projects = [
      project({ root: fx.path('scan/bump'), artifacts: [{ relPath: 'dist', bytes: GB }] }),
      project({ root: fx.path('scan/tinysync'), artifacts: [{ relPath: 'target', bytes: 8 * GB }] }),
      project({
        root: fx.path('scan/worktree-app'),
        artifacts: [{ relPath: 'build', bytes: 2 * GB }],
      }),
      project({
        root: fx.path('scan/nested-dormant'),
        artifacts: [{ relPath: 'dist', bytes: 4 * GB }],
      }),
      project({ root: fx.path('scan/linked'), artifacts: [{ relPath: 'dist', bytes: 3 * GB }] }),
      project({
        root: fx.path('scan/pnpm-app'),
        artifacts: [{ relPath: 'node_modules', bytes: 5 * GB, category: 'deps' }],
      }),
    ];
    const caches = [
      cache({ id: 'npm', path: fx.path('caches/npm/_cacache'), bytes: 2 * GB }),
      cache({ id: 'pnpm-store', label: 'pnpm store', path: fx.path('caches/pnpm/store'), bytes: 7 * GB }),
    ];
    const roots = [fx.path('scan')];
    const input = { projects, caches, categories: RECOMMENDED, roots };

    const out = await renderScreenedReport({ ...input, preset: 'recommended' });
    const rows = buildRows(input);
    const selection = defaultSelection(rows, await screenReport(input));
    const promised = selectedBytes(rows, selection);
    const targets = toTargets({ rows, selection, categories: RECOMMENDED });

    // The same run the report described, against the same tree — with a `TrashFn` that
    // records instead of deleting, so the arrangement survives to be asserted about.
    const trashedPaths: string[] = [];
    const outcomes = await clean(targets, {
      trash: async (paths) => void trashedPaths.push(...paths),
      roots,
      allowedCachePaths: caches.map((entry) => entry.path),
      unselectedNodeModules: [fx.path('scan/pnpm-app/node_modules')],
    });
    const delivered = outcomes
      .filter((outcome) => outcome.outcome === 'trashed')
      .reduce((sum, outcome) => sum + outcome.bytes, 0);

    expect(delivered).toBe(promised);
    expect(out).toContain(`Selected by default: 3 items · ${formatBytes(promised)}`);
    // Not vacuous in either direction: something really was promised, and the rows the report
    // marked `[-]` are exactly the ones `clean` would have refused had they been selected.
    expect(promised).toBe(11 * GB);
    expect(outcomes.every((outcome) => outcome.outcome === 'trashed')).toBe(true);
    expect(trashedPaths).toHaveLength(3);
  });
});

describe('every refusal the boundary can produce reaches a project row', () => {
  const cases: Array<{ name: string; refusal: string; make: () => Project }> = [
    {
      name: 'a linked worktree wearing an artifact name',
      refusal: 'worktree-root',
      make: () =>
        project({
          root: fx.path('scan/worktree-app'),
          artifacts: [{ relPath: 'build', bytes: 2 * GB }],
        }),
    },
    {
      name: 'a gh-pages deploy clone, which is itself a repository',
      refusal: 'contains-repository',
      make: () =>
        project({
          root: fx.path('scan/deploy-clone'),
          artifacts: [{ relPath: 'dist', bytes: 2 * GB }],
        }),
    },
    {
      name: 'an artifact that is a symlink',
      refusal: 'symlink',
      make: () =>
        project({ root: fx.path('scan/linked'), artifacts: [{ relPath: 'dist', bytes: 2 * GB }] }),
    },
    {
      name: 'an artifact behind a symlinked ancestor',
      refusal: 'symlink',
      make: () =>
        project({
          root: fx.path('scan/moved/link'),
          name: 'moved',
          artifacts: [{ relPath: 'dist', bytes: 2 * GB }],
        }),
    },
    {
      name: 'an artifact outside the project root',
      refusal: 'outside-project-root',
      make: () =>
        project({
          root: fx.path('scan/escapee'),
          artifacts: [{ relPath: 'dist', bytes: 2 * GB, path: fx.path('scan/tinysync/target') }],
        }),
    },
    {
      name: 'a directory the artifact table does not claim',
      refusal: 'not-in-artifact-table',
      make: () =>
        project({
          root: fx.path('scan/sources'),
          artifacts: [{ relPath: 'src', bytes: 2 * GB }],
        }),
    },
    {
      name: 'a project rooted where nothing may be deleted',
      refusal: 'guarded-path',
      make: () => project({ root: '/', name: 'filesystem', artifacts: [{ relPath: 'build', bytes: 2 * GB }] }),
    },
  ];

  for (const { name, refusal, make } of cases) {
    it(`marks and explains ${name} (${refusal})`, async () => {
      const subject = make();
      const out = await report({
        projects: [
          subject,
          project({ root: fx.path('scan/bump'), artifacts: [{ relPath: 'dist', bytes: GB }] }),
        ],
      });

      expect(lineFor(out, subject.name)).toContain('[-]');
      expect(out).toContain(`blocked: ${refusal}:`);
      // The deliverable row is untouched, so this is a verdict about one row and not a mood.
      expect(lineFor(out, 'bump')).toContain('[x]');
      expect(out).toContain('Selected by default: 1 item · 1.0G');
    });
  }
});

describe('the two tiers, and what each of them costs', () => {
  /**
   * The cost bound, in both directions, from one fixture shape.
   *
   * `dist/site/.git` can only be found by reading the candidate's contents — seconds on a
   * 67 GB `target/`. Running that over every row of a 133 GB scan is what the cheap tier
   * exists to avoid, and the rule that makes skipping it honest is that an unselected row's
   * bytes are in nobody's total.
   */
  const dormant = (): Project =>
    project({
      root: fx.path('scan/nested-dormant'),
      artifacts: [{ relPath: 'dist', bytes: 2 * GB }],
    });
  const active = (): Project =>
    project({
      root: fx.path('scan/nested-active'),
      activity: ACTIVE,
      artifacts: [{ relPath: 'dist', bytes: 3 * GB }],
    });

  it('walks the contents of a row the report promises, and refuses it', async () => {
    const out = await report({ projects: [dormant()] });

    expect(lineFor(out, 'nested-dormant')).toContain('[-]');
    expect(out).toMatch(/blocked: contains-repository: .*contains a git repository/);
    expect(out).toContain('Selected by default: 0 items · 0B');
  });

  it('does not walk the contents of a row it does not promise', async () => {
    // Same tree, same reason available — the only difference is that an active project is
    // not preselected, so its bytes are not promised and the expensive tier is not spent.
    const out = await report({ projects: [active()] });

    expect(lineFor(out, 'nested-active')).toContain('[ ]');
    expect(out).not.toContain('[-]');
    expect(out).not.toContain('contains-repository');
    expect(out).toMatch(/Protected \(active\):\s+1 item · 3\.0G/);
  });

  it('still runs the cheap guards on a row it does not promise', async () => {
    // The unselected row is not exempt from screening — only from the walk. A symlinked
    // artifact costs one `lstat` to catch, so it is caught, listed and explained.
    const out = await report({
      projects: [
        project({
          root: fx.path('scan/linked'),
          activity: ACTIVE,
          artifacts: [{ relPath: 'dist', bytes: 3 * GB }],
        }),
      ],
    });

    expect(lineFor(out, 'linked')).toContain('[-]');
    expect(out).toContain('blocked: symlink:');
  });

  it('counts a blocked active row once, under Blocked rather than twice', async () => {
    // Both lines describe bytes missing from the total; a row appearing in both would let a
    // user add them up and find more missing than there is.
    const out = await report({
      projects: [
        project({
          root: fx.path('scan/linked'),
          activity: ACTIVE,
          artifacts: [{ relPath: 'dist', bytes: 3 * GB }],
        }),
        project({
          root: fx.path('scan/nested-active'),
          activity: ACTIVE,
          artifacts: [{ relPath: 'dist', bytes: 5 * GB }],
        }),
      ],
    });

    expect(out).toMatch(/Blocked \(not safe\):\s+1 item · 3\.0G/);
    expect(out).toMatch(/Protected \(active\):\s+1 item · 5\.0G/);
  });
});

describe('caches beyond the one that was screened by hand', () => {
  it('refuses a cache whose ancestor is a symlink — the moved ~/.gradle', async () => {
    // `listCaches` decides presence with an `lstat` of the FINAL component, which succeeds
    // here: `<home>/.gradle/caches` really is a directory, reached through a link. Only the
    // boundary's whole-chain check sees it, and before this the report promised those bytes.
    const out = await report({
      caches: [
        cache({ id: 'gradle', path: fx.path('home-gradle/caches'), bytes: 6 * GB }),
        cache({ id: 'npm', path: fx.path('caches/npm/_cacache'), bytes: 2 * GB }),
      ],
    });

    expect(lineFor(out, 'gradle')).toContain('[-]');
    expect(out).toContain('blocked: symlink:');
    expect(lineFor(out, 'npm')).toContain('[x]');
    expect(out).toContain('Selected by default: 1 item · 2.0G');
    expect(out).toMatch(/Blocked \(not safe\):\s+1 item · 6\.0G/);
  });

  it('refuses a store prune the preset cannot make safe, and permits the one it can', async () => {
    const store = cache({
      id: 'pnpm-store',
      label: 'pnpm store',
      path: fx.path('caches/pnpm/store'),
      bytes: 7 * GB,
    });
    const app = project({
      root: fx.path('scan/pnpm-app'),
      artifacts: [{ relPath: 'node_modules', bytes: 2 * GB, category: 'deps' }],
    });

    // `recommended` does not clean `node_modules`, so every hardlink source stays on disk —
    // and the project row is not even listed, which is exactly how this got missed.
    const recommended = await report({ projects: [app], caches: [store] });
    expect(recommended).not.toContain('PROJECTS');
    expect(lineFor(recommended, 'pnpm store')).toContain('[-]');
    expect(recommended).toContain('blocked: store-prune-unsafe:');
    expect(recommended).toContain('Selected by default: 0 items · 0B');

    // `aggressive` cleans them, so the prune becomes deliverable and is promised.
    const aggressive = await report({
      projects: [app],
      caches: [store],
      categories: AGGRESSIVE,
    });
    expect(lineFor(aggressive, 'pnpm store')).toContain('[x]');
    expect(aggressive).not.toContain('store-prune-unsafe');
    expect(aggressive).toContain('Selected by default: 2 items · 9.0G');
  });

  it('reports a cache both screens object to exactly once, in the words of the earlier one', async () => {
    // `caches.ts` answers a question the boundary cannot even ask — whether anything
    // elsewhere on the machine hardlinks into the store — so its reason is the one shown.
    // What must never happen is the row being marked twice, explained twice, or subtracted
    // twice from a total it was only ever in once.
    const store = cache({
      id: 'pnpm-store',
      label: 'pnpm store',
      path: fx.path('caches/pnpm/store'),
      bytes: 7 * GB,
      blocked: { reason: 'node_modules elsewhere on this machine still hardlink into it' },
    });
    const app = project({
      root: fx.path('scan/pnpm-app'),
      artifacts: [{ relPath: 'node_modules', bytes: 2 * GB, category: 'deps' }],
    });

    const out = await report({ projects: [app], caches: [store] });

    expect(out.match(/\[-\]/g)).toHaveLength(1);
    expect(blockedLines(out)).toEqual([
      'blocked: node_modules elsewhere on this machine still hardlink into it',
    ]);
    expect(out).not.toContain('store-prune-unsafe');
    expect(out).toMatch(/Blocked \(not safe\):\s+1 item · 7\.0G/);
  });
});

describe('screenReport itself', () => {
  it('blocks by row id, so the interface can screen the same rows the report did', async () => {
    const worktreeApp = project({
      root: fx.path('scan/worktree-app'),
      artifacts: [{ relPath: 'build', bytes: 2 * GB }],
    });
    const bump = project({ root: fx.path('scan/bump'), artifacts: [{ relPath: 'dist', bytes: GB }] });
    const input = {
      projects: [worktreeApp, bump],
      caches: [],
      categories: RECOMMENDED,
      roots: [fx.path('scan')],
    };

    const blocks = await screenReport(input);
    const rows = buildRows(input);
    const blockedRow = rows.find((row) => row.label === 'worktree-app') as Row;
    const cleanRow = rows.find((row) => row.label === 'bump') as Row;

    expect(blocks.get(blockedRow.id)?.reason).toMatch(/^worktree-root: /);
    expect(blocks.get(cleanRow.id)).toBeUndefined();
  });

  it('leaves a blocked row selectable by hand — a default, not a lock', async () => {
    const worktreeApp = project({
      root: fx.path('scan/worktree-app'),
      artifacts: [{ relPath: 'build', bytes: 2 * GB }],
    });
    const input = {
      projects: [worktreeApp],
      caches: [],
      categories: RECOMMENDED,
      roots: [fx.path('scan')],
    };

    const blocks = await screenReport(input);
    const rows = buildRows(input);
    const row = rows.find((candidate) => candidate.label === 'worktree-app') as Row;
    const selection = defaultSelection(rows, blocks);

    expect(isSelected(selection, row)).toBe(false);
    expect(selectedBytes(rows, selection)).toBe(0);

    // …and the boundary refusal in `clean.ts` is what makes leaving it reachable safe.
    const chosen = toggleRow(selection, row);
    expect(isSelected(chosen, row)).toBe(true);
    expect(toTargets({ rows, selection: chosen, categories: RECOMMENDED })).toHaveLength(1);
  });

  it('touches nothing on disk to reach its verdicts', async () => {
    const before = await snapshot(fx.root);

    await report({
      projects: [
        project({ root: fx.path('scan/bump'), artifacts: [{ relPath: 'dist', bytes: GB }] }),
        project({
          root: fx.path('scan/worktree-app'),
          artifacts: [{ relPath: 'build', bytes: 2 * GB }],
        }),
        project({
          root: fx.path('scan/nested-dormant'),
          artifacts: [{ relPath: 'dist', bytes: 2 * GB }],
        }),
        project({ root: fx.path('scan/linked'), artifacts: [{ relPath: 'dist', bytes: GB }] }),
      ],
      caches: [
        cache({ id: 'npm', path: fx.path('caches/npm/_cacache'), bytes: 2 * GB }),
        cache({ id: 'gradle', path: fx.path('home-gradle/caches'), bytes: 6 * GB }),
      ],
    });

    expect(await snapshot(fx.root)).toEqual(before);
  });
});
