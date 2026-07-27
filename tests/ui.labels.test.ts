/**
 * Row labels: the chips that say why a project is held back and what clearing it would cost.
 *
 * Two things are being defended here, and only one of them is "the function returns the right
 * strings".
 *
 * The first is **agreement**. The recency chip and the detail pane's reason line are two
 * renderings of one fact that lives in `activity.ts`. So the recency tests do not hand
 * `labelsFor` a hand-written `ActivityScore`; they run the real `scoreActivity` over real
 * signals and assert that whatever it decided is what the chip says. A test that invented its
 * own reason string could not catch the only failure that matters — the two drifting apart.
 *
 * The second is **restraint**. Several tests assert that a chip is *absent*: no `uncommitted`
 * without a repository, no recency chip when a lockfile decided the score, no `slow` on a 6 GB
 * `.next`. Those are the tests that keep the label row worth reading, and they are the ones a
 * well-meaning future change is most likely to break.
 */

import { describe, expect, it } from 'vitest';

import { scoreActivity, type ActivitySignals } from '../src/activity.js';
import {
  LABEL_HELP,
  LABEL_ORDER,
  LABEL_SEPARATOR,
  joinLabels,
  labelsFor,
  type Label,
  type LabelKind,
} from '../src/ui/labels.js';
import type { Artifact, Category, GitInfo, Project, ProjectType } from '../src/types.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const DAY = 86_400_000;

/** A fixed clock. Scoring is injected-time by design; the chips inherit that determinism. */
const NOW = Date.UTC(2026, 6, 25);

const RECOMMENDED = new Set<Category>(['build', 'cache']);
const AGGRESSIVE = new Set<Category>(['build', 'deps', 'cache']);

function artifact(relPath: string, category: Category, bytes: number): Artifact {
  return { path: `/p/${relPath}`, relPath, category, bytes };
}

function git(overrides: Partial<GitInfo> = {}): GitInfo {
  return {
    branch: 'main',
    lastCommitMs: NOW - 3 * DAY,
    hasUncommittedChanges: false,
    isWorktree: false,
    ...overrides,
  };
}

interface ProjectOptions {
  types?: ProjectType[];
  artifacts?: Artifact[];
  git?: GitInfo | undefined;
  signals?: Partial<ActivitySignals>;
}

/**
 * A project whose activity is scored by the real scorer.
 *
 * `signals` defaults to a plainly active tree — edited three days ago, clean — so a test that
 * cares about the network chip does not have to think about dates, and a test that cares about
 * dates says only what it is changing.
 *
 * `git` and `signals` are separate inputs on purpose: `labelsFor` reads `GitInfo` for the two
 * repository chips and `ActivityScore` for the recency chip, and never crosses between them.
 * The recency tests below pair the two so no fixture contradicts itself.
 */
function project(options: ProjectOptions = {}): Project {
  const artifacts = options.artifacts ?? [artifact('dist', 'build', 100 * MB)];
  const signals: ActivitySignals = {
    hasUncommittedChanges: options.git?.hasUncommittedChanges ?? false,
    newestSourceMs: NOW - 3 * DAY,
    newestArtifactMs: NOW - 1 * DAY,
    ...options.signals,
  };

  return {
    root: '/p',
    name: 'p',
    types: new Set<ProjectType>(options.types ?? ['node']),
    artifacts,
    bytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
    git: options.git,
    activity: scoreActivity(signals, NOW),
  };
}

const kinds = (labels: readonly Label[]): LabelKind[] => labels.map((label) => label.kind);

const find = (labels: readonly Label[], kind: LabelKind): Label | undefined =>
  labels.find((label) => label.kind === kind);

/** Is `values` a subsequence of `order`? The property "deterministic order" reduces to this. */
function isSubsequenceOf(values: readonly LabelKind[], order: readonly LabelKind[]): boolean {
  let at = 0;
  for (const value of values) {
    const found = order.indexOf(value, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

describe('order', () => {
  it('emits chips in LABEL_ORDER, whatever combination is present', () => {
    const everything = project({
      types: ['rust'],
      artifacts: [artifact('target', 'build', 2 * GB), artifact('node_modules', 'deps', 400 * MB)],
      git: git({ hasUncommittedChanges: true, isWorktree: true }),
    });

    expect(kinds(labelsFor(everything))).toEqual([
      'uncommitted',
      'recency',
      'worktree',
      'slow',
      'network',
    ]);
  });

  it('is a subsequence of LABEL_ORDER for every combination of signals', () => {
    const combinations: Project[] = [];
    for (const dirty of [false, true]) {
      for (const worktree of [false, true]) {
        for (const hasGit of [false, true]) {
          for (const type of ['node', 'rust'] as ProjectType[]) {
            for (const category of ['build', 'deps'] as Category[]) {
              combinations.push(
                project({
                  types: [type],
                  artifacts: [artifact('x', category, MB)],
                  git: hasGit
                    ? git({ hasUncommittedChanges: dirty, isWorktree: worktree })
                    : undefined,
                }),
              );
            }
          }
        }
      }
    }

    expect(combinations).toHaveLength(32);
    for (const candidate of combinations) {
      const order = kinds(labelsFor(candidate));
      expect(isSubsequenceOf(order, LABEL_ORDER)).toBe(true);
    }
  });

  it('puts the connectivity answer last on every row, so it can be read as a position', () => {
    const rows = [
      project({ types: ['rust'], git: git({ hasUncommittedChanges: true, isWorktree: true }) }),
      project({ artifacts: [artifact('node_modules', 'deps', GB)] }),
      project({ git: undefined }),
    ];

    for (const row of rows) {
      const order = kinds(labelsFor(row));
      expect(['network', 'offline']).toContain(order[order.length - 1]);
    }
  });
});

describe('connectivity', () => {
  it('says needs network when any artifact is a dependency directory', () => {
    for (const relPath of ['node_modules', 'Pods', '.venv', 'vendor/bundle']) {
      const labels = labelsFor(project({ artifacts: [artifact(relPath, 'deps', GB)] }));
      expect(kinds(labels)).toContain('network');
      expect(find(labels, 'network')?.text).toBe('needs network');
    }
  });

  it('says offline when nothing has to be downloaded', () => {
    const labels = labelsFor(project({ artifacts: [artifact('dist', 'build', GB)] }));
    expect(find(labels, 'offline')?.text).toBe('offline');
  });

  it('emits exactly one of network/offline, always', () => {
    const rows = [
      project({ artifacts: [] }),
      project({ artifacts: [artifact('dist', 'build', GB)] }),
      project({ artifacts: [artifact('node_modules', 'deps', GB)] }),
      project({
        artifacts: [artifact('dist', 'build', GB), artifact('node_modules', 'deps', GB)],
      }),
      project({ artifacts: [artifact('.cache', 'cache', KB)], git: undefined }),
    ];

    for (const row of rows) {
      const connectivity = kinds(labelsFor(row)).filter(
        (kind) => kind === 'network' || kind === 'offline',
      );
      expect(connectivity).toHaveLength(1);
    }
  });

  it('is answered under the preset that will actually run, not the widest one', () => {
    // `recommended` leaves `node_modules` alone, so nothing is downloaded to rebuild what it
    // does clear. Saying `needs network` here would be false.
    const node = project({
      artifacts: [artifact('dist', 'build', 200 * MB), artifact('node_modules', 'deps', GB)],
    });

    expect(kinds(labelsFor(node, RECOMMENDED))).toContain('offline');
    expect(kinds(labelsFor(node, AGGRESSIVE))).toContain('network');
    expect(kinds(labelsFor(node))).toContain('network');
  });
});

describe('git chips', () => {
  it('marks a dirty tree', () => {
    const labels = labelsFor(project({ git: git({ hasUncommittedChanges: true }) }));
    const chip = find(labels, 'uncommitted');
    expect(chip?.text).toBe('uncommitted');
    expect(chip?.long).toBe('uncommitted changes');
    expect(chip?.tone).toBe('warn');
  });

  it('marks a linked worktree', () => {
    const labels = labelsFor(project({ git: git({ isWorktree: true }) }));
    expect(find(labels, 'worktree')?.text).toBe('worktree');
    expect(find(labels, 'worktree')?.tone).toBe('info');
  });

  it('never invents a git answer for a project with no repository', () => {
    const labels = labelsFor(
      project({ git: undefined, artifacts: [artifact('target', 'build', GB)], types: ['rust'] }),
    );

    expect(kinds(labels)).not.toContain('uncommitted');
    expect(kinds(labels)).not.toContain('worktree');
    // The chips that do not depend on a repository are still there.
    expect(kinds(labels)).toEqual(['recency', 'slow', 'offline']);
  });

  it('omits both chips on a clean main checkout rather than asserting the negative', () => {
    const labels = labelsFor(project({ git: git() }));
    expect(kinds(labels)).not.toContain('uncommitted');
    expect(kinds(labels)).not.toContain('worktree');
  });
});

describe('recency agrees with the reason activity.ts produced', () => {
  interface Case {
    name: string;
    signals: Partial<ActivitySignals>;
    verb: 'edited' | 'committed';
    text: string;
  }

  const cases: Case[] = [
    {
      name: 'a source edit decided it',
      signals: { newestSourceMs: NOW - 8 * DAY },
      verb: 'edited',
      text: 'edited 8d',
    },
    {
      name: 'a commit decided it',
      signals: { lastCommitMs: NOW - 40 * DAY, newestSourceMs: NOW - 200 * DAY },
      verb: 'committed',
      text: 'committed 1mo',
    },
    {
      name: 'a dirty tree is still active',
      signals: { hasUncommittedChanges: true, newestSourceMs: NOW - 8 * DAY },
      verb: 'edited',
      text: 'edited 8d',
    },
    {
      name: 'a dirty tree has fallen past the grace period',
      signals: { hasUncommittedChanges: true, newestSourceMs: NOW - 100 * DAY },
      verb: 'edited',
      text: 'edited 3mo',
    },
    {
      name: 'a very old commit decided it',
      signals: { lastCommitMs: NOW - 800 * DAY, newestSourceMs: NOW - 900 * DAY },
      verb: 'committed',
      text: 'committed 2y',
    },
  ];

  /** A `GitInfo` that tells the same story the signals do, so no fixture contradicts itself. */
  const gitFor = (signals: Partial<ActivitySignals>): GitInfo =>
    git({
      hasUncommittedChanges: signals.hasUncommittedChanges === true,
      lastCommitMs: signals.lastCommitMs ?? 0,
    });

  for (const testCase of cases) {
    it(`matches the reason when ${testCase.name}`, () => {
      const row = project({ signals: testCase.signals, git: gitFor(testCase.signals) });
      const chip = find(labelsFor(row), 'recency');

      expect(chip).toBeDefined();
      expect(chip?.text).toBe(testCase.text);
      // The strongest form of "these two agree": the long chip is a verbatim slice of the
      // prose the detail pane renders.
      const long = chip?.long ?? '<no recency chip>';
      expect(row.activity.reason).toContain(long);
      // And it names the same signal the reason names.
      expect(long.startsWith(testCase.verb)).toBe(true);
      expect(chip?.text.startsWith(testCase.verb)).toBe(true);
    });
  }

  it('is silent when a lockfile decided the score, rather than guessing a verb', () => {
    // `dependencies changed 5 days ago` — real, and the one recency signal too weak to chip.
    const row = project({
      signals: {
        lockfileMs: NOW - 5 * DAY,
        newestSourceMs: NOW - 50 * DAY,
      },
      git: undefined,
    });

    expect(row.activity.reason).toContain('dependencies changed');
    expect(kinds(labelsFor(row))).not.toContain('recency');
  });

  it('is silent when there were no dates to score at all', () => {
    const row = project({
      signals: { newestSourceMs: 0, newestArtifactMs: 0 },
      git: undefined,
    });

    expect(row.activity.reason).toBe('no dates to score — protected');
    expect(kinds(labelsFor(row))).not.toContain('recency');
    // Cost is still knowable without a date, so the row is not chipless.
    expect(kinds(labelsFor(row))).toEqual(['offline']);
  });

  it('does not read "committed" out of the word "uncommitted"', () => {
    const row = project({
      signals: { hasUncommittedChanges: true, newestSourceMs: NOW - 100 * DAY },
      git: git({ hasUncommittedChanges: true, lastCommitMs: 0 }),
    });

    expect(row.activity.reason.startsWith('uncommitted')).toBe(true);
    const chip = find(labelsFor(row), 'recency');
    expect(chip?.text).toBe('edited 3mo');
    expect(chip?.long).toBe('edited 3mo ago');
  });
});

describe('slow is an ecosystem fact, not a size fact', () => {
  for (const type of ['rust', 'xcode', 'gradle'] as ProjectType[]) {
    it(`marks ${type} slow even when the directory is small`, () => {
      const labels = labelsFor(
        project({ types: [type], artifacts: [artifact('build', 'build', 4 * MB)] }),
      );
      expect(kinds(labels)).toContain('slow');
      expect(find(labels, 'slow')?.tone).toBe('cost');
    });
  }

  it('does not mark a 6G .next slow — it regenerates in seconds', () => {
    const labels = labelsFor(
      project({ types: ['node'], artifacts: [artifact('.next', 'build', 6 * GB)] }),
    );
    expect(kinds(labels)).not.toContain('slow');
  });

  it('marks a 2G rust target slow though it is a third the size', () => {
    const labels = labelsFor(
      project({ types: ['rust'], artifacts: [artifact('target', 'build', 2 * GB)] }),
    );
    expect(kinds(labels)).toContain('slow');
  });

  it('marks a monorepo slow when any of its types is slow', () => {
    const labels = labelsFor(project({ types: ['node', 'rust'] }));
    expect(kinds(labels)).toContain('slow');
  });

  it('leaves the fast ecosystems unmarked, so the chip stays worth reading', () => {
    for (const type of ['node', 'python', 'go', 'ruby', 'dotnet', 'cmake'] as ProjectType[]) {
      expect(kinds(labelsFor(project({ types: [type] })))).not.toContain('slow');
    }
  });

  it('still marks a rust project whose target was already cleared', () => {
    const labels = labelsFor(
      project({ types: ['rust'], artifacts: [artifact('.cache', 'cache', KB)] }),
    );
    expect(kinds(labels)).toContain('slow');
  });
});

describe('the label set is closed', () => {
  it('has exactly the six kinds, and no others can be emitted', () => {
    expect([...LABEL_ORDER].sort()).toEqual(
      ['network', 'offline', 'recency', 'slow', 'uncommitted', 'worktree'].sort(),
    );
    expect(new Set(LABEL_ORDER).size).toBe(LABEL_ORDER.length);
  });

  it('emits only kinds that LABEL_ORDER knows about', () => {
    const seen = new Set<LabelKind>();
    for (const dirty of [false, true]) {
      for (const worktree of [false, true]) {
        for (const type of ['node', 'rust'] as ProjectType[]) {
          for (const category of ['build', 'deps'] as Category[]) {
            for (const kind of kinds(
              labelsFor(
                project({
                  types: [type],
                  artifacts: [artifact('x', category, MB)],
                  git: git({ hasUncommittedChanges: dirty, isWorktree: worktree }),
                }),
              ),
            )) {
              seen.add(kind);
            }
          }
        }
      }
    }
    expect([...seen].every((kind) => LABEL_ORDER.includes(kind))).toBe(true);
    expect(seen.size).toBe(6);
  });
});

describe('LABEL_HELP', () => {
  it('covers every kind with a non-empty line', () => {
    for (const kind of LABEL_ORDER) {
      const help = LABEL_HELP[kind];
      expect(help.length).toBeGreaterThan(20);
      expect(help.trim()).toBe(help);
    }
  });

  it('explains slow as a cost in time, never as an ecosystem the row already shows', () => {
    const help = LABEL_HELP.slow.toLowerCase();
    expect(help).toContain('minutes');
    for (const noise of ['rust', 'xcode', 'gradle']) expect(help).not.toContain(noise);
  });

  it('tells the network chips what to do about connectivity', () => {
    expect(LABEL_HELP.network.toLowerCase()).toMatch(/plane|wifi|download/);
    expect(LABEL_HELP.offline.toLowerCase()).toMatch(/no connectivity|offline|already have/);
  });

  it('says of a dirty tree that cleaning cannot reach the work', () => {
    // The whole point of the chip row: state cost, never imply a danger that does not exist.
    expect(LABEL_HELP.uncommitted.toLowerCase()).toMatch(/cannot reach|cannot touch/);
  });
});

describe('rendering helpers', () => {
  it('joins chips with the separator the module owns', () => {
    const labels = labelsFor(
      project({
        types: ['rust'],
        artifacts: [artifact('target', 'build', GB), artifact('node_modules', 'deps', GB)],
        git: git({ hasUncommittedChanges: true }),
        signals: { hasUncommittedChanges: true, newestSourceMs: NOW - 8 * DAY },
      }),
    );

    expect(joinLabels(labels)).toBe(
      ['uncommitted', 'edited 8d', 'slow', 'needs network'].join(LABEL_SEPARATOR),
    );
    expect(joinLabels(labels, 'long')).toBe(
      [
        'uncommitted changes',
        // Verbatim from `activity.reason` — the long form is the reason's own wording.
        'edited 8 days ago',
        'slow rebuild',
        'needs network to rebuild',
      ].join(LABEL_SEPARATOR),
    );
  });

  it('gives every chip a short form no longer than its long form', () => {
    const labels = labelsFor(
      project({
        types: ['xcode'],
        artifacts: [artifact('Pods', 'deps', GB)],
        git: git({ hasUncommittedChanges: true, isWorktree: true }),
      }),
    );

    expect(labels).toHaveLength(5);
    for (const label of labels) {
      expect(label.text.length).toBeLessThanOrEqual(label.long.length);
      expect(label.text.length).toBeLessThanOrEqual(14);
      expect(label.text).not.toBe('');
    }
  });

  it('is deterministic: the same project yields the same chips every time', () => {
    const row = project({ types: ['gradle'], git: git({ hasUncommittedChanges: true }) });
    expect(labelsFor(row)).toEqual(labelsFor(row));
  });
});
