/**
 * Activity is two halves with very different standing.
 *
 * `gatherSignals` is a derivation — given a tree, a git summary and the artifact list, the
 * five signals are facts and can be pinned exactly. `scoreActivity` is a *judgement* the
 * spec assigns to the repository owner, so it ships as a documented stub and these tests
 * deliberately assert on the **signals**, never on a status. Asserting `status === 'active'`
 * here would encode the stub as the specification and turn the owner's first real
 * implementation into a test failure.
 *
 * The three cases the spec names under "Activity scoring" get one `describe` each:
 * uncommitted-but-stale, recently-built-never-committed, and no-git-at-all. Each one is the
 * case a plausible scoring rule gets wrong, so each one's signals must survive intact all
 * the way to `scoreActivity`.
 *
 * No git repository is created: `GitInfo` is a plain object here (the spec's "Activity is
 * tested with synthetic signal objects"), which keeps these tests independent of `git.ts`
 * and of whether `git` is even installed.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { gatherSignals, scoreActivity } from '../src/activity.js';
import type { Artifact, Category, GitInfo } from '../src/types.js';
import { dir, file, fixture, symlink, type Fixture } from './fixture.js';

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const DAY = 24 * 60 * 60 * 1000;
/** Real wall-clock, so a symlink's own (just-created) mtime is comparable to the fixture. */
const NOW = Date.now();
const ago = (days: number): number => NOW - days * DAY;

/**
 * Timestamps survive `utimes` -> `stat` intact to the millisecond on APFS and ext4, but the
 * round trip goes through nanoseconds and a float, and some filesystems (HFS+, FAT) quantise
 * to a second or two. A one-minute window is far tighter than any distinction these fixtures
 * draw — they are days apart — while surviving every filesystem the tests might run on.
 */
function expectMs(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs expected ${expected}`).toBeLessThan(
    60_000,
  );
}

function artifact(f: Fixture, relPath: string, category: Category = 'build'): Artifact {
  return { path: f.path(relPath), relPath, category, bytes: 0 };
}

function git(overrides: Partial<GitInfo> = {}): GitInfo {
  return {
    branch: 'main',
    lastCommitMs: ago(300),
    hasUncommittedChanges: false,
    isWorktree: false,
    ...overrides,
  };
}

describe('gatherSignals: uncommitted but stale', () => {
  /**
   * The shape that makes "has uncommitted changes" a dangerous proxy for "active": work was
   * abandoned mid-edit eight months ago. Both facts must reach the scorer separately —
   * collapsing them here (say, by reporting `newestSourceMs` as now because the tree is
   * dirty) is what removes the owner's ability to distinguish them.
   */
  async function staleTree(): Promise<Fixture> {
    return tree({
      'stale/Cargo.toml': file('[package]\nname = "stale"\n', { mtime: ago(220) }),
      'stale/Cargo.lock': file('# lockfile\n', { mtime: ago(240) }),
      'stale/src/main.rs': file('fn main() {}\n', { mtime: ago(220) }),
      // Newer than every source file: a build ran after the last edit.
      'stale/target': dir({ mtime: ago(215) }),
      'stale/target/debug.bin': file('x', { size: 4096, mtime: ago(215) }),
    });
  }

  it('reports the stale commit and the dirty tree as two independent signals', async () => {
    const f = await staleTree();
    const signals = await gatherSignals(
      f.path('stale'),
      [artifact(f, 'stale/target')],
      git({ lastCommitMs: ago(300), hasUncommittedChanges: true }),
    );

    expect(signals.hasUncommittedChanges).toBe(true);
    expect(signals.lastCommitMs).toBeDefined();
    expectMs(signals.lastCommitMs ?? 0, ago(300), 'lastCommitMs');
    // Stale is stale: the newest source edit is ~220 days old, dirty tree notwithstanding.
    expect(NOW - signals.newestSourceMs).toBeGreaterThan(200 * DAY);
  });

  it('excludes the artifact subtree from newestSourceMs', async () => {
    const f = await staleTree();
    const signals = await gatherSignals(
      f.path('stale'),
      [artifact(f, 'stale/target')],
      git({ hasUncommittedChanges: true }),
    );

    // `target/debug.bin` is 215 days old — newer than any source. Counting it would report
    // the last *build* as the last *edit*, and every built project would look freshly worked
    // on. The exclusion must prune the descent, not filter the result.
    expectMs(signals.newestSourceMs, ago(220), 'newestSourceMs');
  });

  it('reads newestArtifactMs from the artifact directory itself', async () => {
    const f = await staleTree();
    const signals = await gatherSignals(
      f.path('stale'),
      [artifact(f, 'stale/target')],
      git({ hasUncommittedChanges: true }),
    );

    expectMs(signals.newestArtifactMs, ago(215), 'newestArtifactMs');
  });

  it('reports the lockfile mtime when one is present', async () => {
    const f = await staleTree();
    const signals = await gatherSignals(
      f.path('stale'),
      [artifact(f, 'stale/target')],
      git({ hasUncommittedChanges: true }),
    );

    expect(signals.lockfileMs).toBeDefined();
    expectMs(signals.lockfileMs ?? 0, ago(240), 'lockfileMs');
  });
});

describe('gatherSignals: recently built, never committed', () => {
  /**
   * A dev server or a watch build touches artifacts continuously while the source sits
   * untouched for months. `newestArtifactMs` and `newestSourceMs` must therefore be reported
   * apart — a single "newest mtime anywhere" signal makes this project indistinguishable
   * from one edited this morning, and it is the exact case the spec calls out.
   */
  async function builtTree(): Promise<Fixture> {
    return tree({
      'built/package.json': file('{"name":"built"}\n', { mtime: ago(120) }),
      'built/src/index.ts': file('export {};\n', { mtime: ago(118) }),
      'built/node_modules': dir({ mtime: ago(1) }),
      'built/node_modules/left-pad/index.js': file('module.exports = 1;\n', { mtime: ago(1) }),
      'built/dist': dir({ mtime: ago(0.25) }),
      'built/dist/bundle.js': file('console.log(1);\n', { mtime: ago(0.25) }),
    });
  }

  const targets = (f: Fixture): Artifact[] => [
    artifact(f, 'built/node_modules', 'deps'),
    artifact(f, 'built/dist'),
  ];

  it('separates a fresh build from stale source', async () => {
    const f = await builtTree();
    const signals = await gatherSignals(f.path('built'), targets(f), undefined);

    expectMs(signals.newestSourceMs, ago(118), 'newestSourceMs');
    expectMs(signals.newestArtifactMs, ago(0.25), 'newestArtifactMs');
    expect(
      signals.newestArtifactMs,
      'the build is newer than any source file, and both survive',
    ).toBeGreaterThan(signals.newestSourceMs);
  });

  it('omits lastCommitMs entirely when there is no commit yet', async () => {
    const f = await builtTree();
    // A repository that exists but has no commits: `git.ts` reports lastCommitMs 0.
    const signals = await gatherSignals(
      f.path('built'),
      targets(f),
      git({ lastCommitMs: 0, hasUncommittedChanges: true }),
    );

    // 0 is not a timestamp — passing it through would present 1970 as the last commit and
    // score a brand-new project as maximally idle. Absent means "no such signal".
    expect('lastCommitMs' in signals, 'lastCommitMs must be absent, not 0').toBe(false);
    expect(signals.lastCommitMs).toBeUndefined();
    expect(signals.hasUncommittedChanges).toBe(true);
  });

  it('omits lockfileMs when the project has no lockfile', async () => {
    const f = await builtTree();
    const signals = await gatherSignals(f.path('built'), targets(f), undefined);

    expect('lockfileMs' in signals, 'no lockfile on disk, so no signal').toBe(false);
    expect(signals.lockfileMs).toBeUndefined();
  });

  it('never lets a file inside an artifact directory raise newestSourceMs', async () => {
    const f = await tree({
      'watch/package.json': file('{}\n', { mtime: ago(90) }),
      'watch/src/app.ts': file('export {};\n', { mtime: ago(90) }),
      'watch/node_modules/.vite/deps/chunk.js': file('//\n', { mtime: NOW }),
    });
    const signals = await gatherSignals(
      f.path('watch'),
      [artifact(f, 'watch/node_modules', 'deps')],
      undefined,
    );

    expectMs(signals.newestSourceMs, ago(90), 'newestSourceMs');
    expect(NOW - signals.newestSourceMs).toBeGreaterThan(80 * DAY);
  });
});

describe('gatherSignals: no git at all', () => {
  /**
   * A downloaded tarball, a scratch directory, a vendored SDK. Every git-derived signal is
   * simply absent — and absent must not be forged into a default that reads as a fact.
   */
  it('omits every git signal and still reports the filesystem ones', async () => {
    const f = await tree({
      'nogit/pyproject.toml': file('[project]\n', { mtime: ago(400) }),
      'nogit/main.py': file('print(1)\n', { mtime: ago(365) }),
      'nogit/__pycache__': dir({ mtime: ago(360) }),
      'nogit/__pycache__/main.pyc': file('\0\0', { mtime: ago(360) }),
    });
    const signals = await gatherSignals(
      f.path('nogit'),
      [artifact(f, 'nogit/__pycache__', 'cache')],
      undefined,
    );

    expect('lastCommitMs' in signals, 'no repository, so no commit signal').toBe(false);
    expect(signals.lastCommitMs).toBeUndefined();
    // False is the honest reading of "no repository": there is nothing uncommitted because
    // there is nothing to commit to. It must not be `true`, which would protect every
    // unversioned directory on the machine forever.
    expect(signals.hasUncommittedChanges).toBe(false);

    expectMs(signals.newestSourceMs, ago(365), 'newestSourceMs');
    expectMs(signals.newestArtifactMs, ago(360), 'newestArtifactMs');
  });
});

describe('gatherSignals: degenerate inputs', () => {
  it('reports newestArtifactMs 0 when the project has no artifacts', async () => {
    const f = await tree({
      'plain/go.mod': file('module plain\n', { mtime: ago(30) }),
      'plain/main.go': file('package main\n', { mtime: ago(30) }),
    });
    const signals = await gatherSignals(f.path('plain'), [], undefined);

    expect(signals.newestArtifactMs).toBe(0);
    expectMs(signals.newestSourceMs, ago(30), 'newestSourceMs');
  });

  it('does not follow a symlinked artifact path', async () => {
    // The link itself was created a moment ago, so an `lstat`-and-count implementation
    // reports ~now and a `stat`-through implementation reports the target's time. Either
    // way the number would be a fabrication: invariant 2 says a link is never traversed,
    // and a link is not a build directory.
    const f = await tree({
      'linked/package.json': file('{}\n', { mtime: ago(50) }),
      'linked/real-build': dir({ mtime: ago(10) }),
      'linked/dist': symlink('/'),
    });
    const signals = await gatherSignals(f.path('linked'), [artifact(f, 'linked/dist')], undefined);

    expect(signals.newestArtifactMs).toBe(0);
  });

  it('survives an artifact path that no longer exists', async () => {
    const f = await tree({
      'gone/package.json': file('{}\n', { mtime: ago(5) }),
    });
    const signals = await gatherSignals(
      f.path('gone'),
      [artifact(f, 'gone/node_modules', 'deps')],
      undefined,
    );

    expect(signals.newestArtifactMs).toBe(0);
    expectMs(signals.newestSourceMs, ago(5), 'newestSourceMs');
  });

  it('returns a complete signal set for a root that does not exist', async () => {
    const f = await tree({ 'anchor/keep': file('x') });
    // A project can vanish between the walk and the scoring. Signals still come back
    // well-formed, because `scan.ts` scores whatever it is handed.
    const signals = await gatherSignals(f.path('missing-entirely'), [], git());

    expect(signals.newestSourceMs).toBe(0);
    expect(signals.newestArtifactMs).toBe(0);
    expect(signals.hasUncommittedChanges).toBe(false);
    expectMs(signals.lastCommitMs ?? 0, ago(300), 'lastCommitMs');
  });
});

/**
 * Shape only. `scoreActivity`'s body belongs to the repository owner, so the one thing that
 * can be asserted without pre-empting that judgement is that whatever it returns is a
 * well-formed `ActivityScore` — which is what `scan.ts`, the report and the TUI consume.
 * A test pinning `status` would fail the moment the real scoring lands.
 */
describe('scoreActivity', () => {
  it('returns a well-formed ActivityScore', () => {
    const score = scoreActivity(
      {
        lastCommitMs: ago(300),
        hasUncommittedChanges: true,
        newestSourceMs: ago(220),
        newestArtifactMs: ago(215),
        lockfileMs: ago(240),
      },
      NOW,
    );

    expect(['active', 'dormant']).toContain(score.status);
    expect(Number.isFinite(score.idleMs)).toBe(true);
    expect(score.idleMs).toBeGreaterThanOrEqual(0);
    expect(score.reason.length).toBeGreaterThan(0);
  });

  it('returns a well-formed ActivityScore when every optional signal is absent', () => {
    const score = scoreActivity(
      { hasUncommittedChanges: false, newestSourceMs: 0, newestArtifactMs: 0 },
      NOW,
    );

    expect(['active', 'dormant']).toContain(score.status);
    expect(Number.isFinite(score.idleMs)).toBe(true);
    expect(score.idleMs).toBeGreaterThanOrEqual(0);
    expect(score.reason.length).toBeGreaterThan(0);
  });
});
