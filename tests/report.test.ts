/**
 * The static report is the only view a non-TTY user gets, and `renderCleanSummary` is the
 * only place invariant 8 is discharged: Trash does not reclaim disk until it is emptied,
 * so a run that reports "freed 70G" without that sentence is actively misleading.
 *
 * Both functions are pure string builders over synthetic data — no filesystem, no scan.
 */

import { describe, expect, it } from 'vitest';

import { renderCleanSummary, renderReport } from '../src/report.js';
import { SECTION_LABELS } from '../src/ui/model.js';
import type {
  CacheEntry,
  Category,
  CleanOutcome,
  GitInfo,
  Project,
  ProjectType,
} from '../src/types.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 24 * 60 * 60 * 1000;

const RECOMMENDED = new Set<Category>(['build', 'cache']);
const AGGRESSIVE = new Set<Category>(['build', 'deps', 'cache']);

interface ArtifactSpec {
  relPath: string;
  category: Category;
  bytes: number;
}

interface ProjectSpec {
  name: string;
  status?: 'active' | 'dormant';
  idleMs?: number;
  reason?: string;
  types?: ProjectType[];
  artifacts?: ArtifactSpec[];
  /** Absent means "not a repository", which is a distinct state from "clean repository". */
  git?: Partial<GitInfo>;
}

function makeGit(overrides: Partial<GitInfo>): GitInfo {
  return {
    branch: 'main',
    lastCommitMs: 1_700_000_000_000,
    hasUncommittedChanges: false,
    isWorktree: false,
    ...overrides,
  };
}

function makeProject(spec: ProjectSpec): Project {
  const root = `/scan/${spec.name}`;
  const specs: ArtifactSpec[] = spec.artifacts ?? [
    { relPath: 'dist', category: 'build', bytes: GB },
  ];
  const artifacts = specs.map((artifact) => ({
    path: `${root}/${artifact.relPath}`,
    relPath: artifact.relPath,
    category: artifact.category,
    bytes: artifact.bytes,
  }));

  return {
    root,
    name: spec.name,
    types: new Set<ProjectType>(spec.types ?? ['node']),
    artifacts,
    bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    ...(spec.git === undefined ? {} : { git: makeGit(spec.git) }),
    activity: {
      status: spec.status ?? 'dormant',
      idleMs: spec.idleMs ?? 240 * DAY,
      reason: spec.reason ?? 'no commits',
    },
  };
}

function makeCache(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    id: 'pnpm-store',
    label: 'pnpm store',
    path: '/home/dev/Library/pnpm/store',
    bytes: 8 * GB,
    note: 'hardlink target for node_modules',
    ...overrides,
  };
}

function cacheOutcome(overrides: Partial<CleanOutcome> = {}): CleanOutcome {
  const cache = makeCache();
  return {
    target: { kind: 'cache', cache },
    label: cache.label,
    bytes: cache.bytes,
    outcome: 'trashed',
    ...overrides,
  };
}

describe('renderReport', () => {
  const dormant = makeProject({
    name: 'tinysync',
    types: ['rust'],
    idleMs: 240 * DAY,
    reason: 'last commit 8mo ago',
    artifacts: [{ relPath: 'target', category: 'build', bytes: 67 * GB }],
  });
  const active = makeProject({
    name: 'notchpad',
    status: 'active',
    idleMs: 3 * DAY,
    reason: 'committed 3d ago',
    artifacts: [{ relPath: '.next', category: 'build', bytes: 1536 * MB }],
  });

  it('lists dormant projects under PROJECTS with their sizes and artifact breakdown', () => {
    const out = renderReport({
      projects: [dormant],
      caches: [],
      categories: RECOMMENDED,
      preset: 'recommended',
      roots: ['/scan'],
    });

    expect(out).toContain('PROJECTS');
    expect(out).toContain('tinysync');
    expect(out).toContain('67.0G');
    // The per-artifact breakdown, so a piped report says *what* would be deleted.
    expect(out).toContain('target');
    expect(out).toContain('rust');
    expect(out).toContain('/scan');
  });

  it('separates active projects into a protected section and does not preselect them', () => {
    const out = renderReport({
      projects: [dormant, active],
      caches: [],
      categories: RECOMMENDED,
      preset: 'recommended',
    });

    // Assert against the exported constant, not a literal: this test hard-coded
    // 'ACTIVE (protected)' and so broke when the copy was corrected — a test that fails on
    // wording rather than on behaviour.
    expect(out).toContain(SECTION_LABELS.active);
    // Dormant is checked, in-use is not: not-preselected is the default (spec: activity scoring).
    expect(out).toMatch(/\[x\]\s+tinysync/);
    expect(out).toMatch(/\[ \]\s+notchpad/);
    expect(out).toContain('committed 3d ago');
  });

  it('lists caches when present and omits the section entirely when not', () => {
    const withCaches = renderReport({
      projects: [dormant],
      caches: [makeCache()],
      categories: RECOMMENDED,
    });
    expect(withCaches).toContain('CACHES');
    expect(withCaches).toContain('pnpm store');
    expect(withCaches).toContain('8.0G');
    expect(withCaches).toContain('hardlink target');

    const without = renderReport({
      projects: [dormant],
      caches: [],
      categories: RECOMMENDED,
    });
    expect(without).not.toContain('CACHES');
  });

  it('honours the preset categories rather than every discovered artifact', () => {
    const depsOnly = makeProject({
      name: 'bump',
      artifacts: [{ relPath: 'node_modules', category: 'deps', bytes: 3 * GB }],
    });

    const recommended = renderReport({
      projects: [depsOnly],
      caches: [],
      categories: RECOMMENDED,
    });
    expect(recommended).not.toContain('bump');

    const aggressive = renderReport({
      projects: [depsOnly],
      caches: [],
      categories: AGGRESSIVE,
      preset: 'aggressive',
    });
    expect(aggressive).toContain('bump');
    expect(aggressive).toContain('node_modules');
  });

  it('states the default-selection total and that nothing was deleted', () => {
    const out = renderReport({
      projects: [dormant, active],
      caches: [makeCache()],
      categories: RECOMMENDED,
    });

    // 67G + 8G selected by default; the active project's 1.5G is not.
    expect(out).toContain('75.0G');
    expect(out).toMatch(/nothing was deleted/i);
  });

  it('reports an empty scan without inventing sections', () => {
    const out = renderReport({ projects: [], caches: [], categories: RECOMMENDED });

    expect(out).not.toContain('PROJECTS');
    expect(out).not.toContain('CACHES');
    expect(out).toMatch(/no reclaimable artifacts/i);
    expect(out).toMatch(/nothing was deleted/i);
  });

  it('ends with exactly one trailing newline so it pipes cleanly', () => {
    const out = renderReport({ projects: [dormant], caches: [], categories: RECOMMENDED });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  /**
   * The report against the arrangement that produced the bug.
   *
   * The first real run printed:
   *
   *     CACHES · 7 items · 18.5G
   *       [x] pnpm store    7.5G
   *           hardlink target for project node_modules — those are trashed first
   *     Selected by default: 7 items · 18.5G
   *
   * and `clean.ts` then refused the 7.5G prune, correctly. Both printed lines were wrong:
   * the total promised bytes the run would not deliver, and the note described `aggressive`
   * while `recommended` was the preset running.
   */
  describe('a cache the run has already established it would refuse', () => {
    const blockedStore = makeCache({
      id: 'pnpm-store',
      label: 'pnpm store',
      bytes: 7.5 * GB,
      note: 'hardlink target for project node_modules — this preset does not trash node_modules, so the store stays',
      blocked: {
        reason:
          'node_modules elsewhere on this machine still hardlink into it, so pruning it ' +
          'would orphan those links',
      },
    });
    const cleanCache = makeCache({
      id: 'npm-cache',
      label: 'npm cache',
      path: '/home/dev/.npm/_cacache',
      bytes: 11 * GB,
      note: 'safe — packages are re-downloaded on demand',
    });

    const out = renderReport({
      projects: [],
      caches: [blockedStore, cleanCache],
      categories: RECOMMENDED,
      preset: 'recommended',
    });

    const lineFor = (label: string): string =>
      out.split('\n').find((line) => line.includes(label)) ?? '';

    it('marks it neither selected nor merely selectable', () => {
      // `[ ]` would say "you could select this and it would be cleaned", which is exactly
      // the claim the run cannot keep.
      expect(lineFor('pnpm store')).toContain('[-]');
      expect(lineFor('pnpm store')).not.toContain('[x]');
      expect(lineFor('pnpm store')).not.toContain('[ ]');
    });

    it('still marks the caches it can actually clean', () => {
      expect(lineFor('npm cache')).toContain('[x]');
    });

    it('prints the reason, not just the mark', () => {
      expect(out).toContain(
        'blocked: node_modules elsewhere on this machine still hardlink into it',
      );
    });

    it('excludes it from the total the run promises', () => {
      // 11G, not 18.5G. This single assertion is the bug: the reported total and what the
      // run would deliver are now the same number.
      expect(out).toContain('Selected by default: 1 item · 11.0G');
      expect(out).not.toContain('Selected by default: 2 items · 18.5G');
    });

    it('still reports what is on the disk in the section header', () => {
      // The header describes the disk, and the disk really does hold 18.5G of cache. What
      // changed is the claim about what *this run* would reclaim.
      expect(out).toContain('CACHES  ·  2 items  ·  18.5G');
    });

    it('names the shortfall instead of letting the two numbers silently disagree', () => {
      // A total that drops 7.5G with no explanation is a number the user cannot reconcile
      // with the header two lines above; that reads as an undercount, not as a guard.
      expect(out).toMatch(/Blocked \(not safe\):\s+1 item · 7\.5G/);
      expect(out).toContain('excluded from the total above');
    });

    it('says nothing about blocked items when there are none', () => {
      const clean = renderReport({
        projects: [dormant],
        caches: [cleanCache],
        categories: RECOMMENDED,
      });
      expect(clean).not.toContain('Blocked');
      expect(clean).not.toContain('[-]');
      expect(clean).toContain('Selected by default: 2 items · 78.0G');
    });

    it('keeps the promised total equal to the sum of the rows it marked', () => {
      // The general form of the same rule, so a future third mark cannot reintroduce the
      // gap: every `[x]` row's size, and nothing else, adds up to the stated total.
      const marked = out
        .split('\n')
        .filter((line) => line.includes('[x]'))
        .map((line) => line.trim().replace(/^\[x\]\s+/, ''));

      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain('11.0G');
    });
  });
});

/**
 * The row labels, in the one view that cannot delete anything.
 *
 * `dev-cleaner ~/develop | less` is the mode a cautious user reaches for first, and the mode a
 * CI log preserves. If it carries fewer labels than the interactive list, then the piped report
 * and the session disagree about a row — the divergence class this codebase keeps finding, and
 * the reason the report is built from the same `buildRows`, `defaultSelection` and now the same
 * `labelsFor` rather than from a second opinion computed here.
 *
 * What is asserted is the *report's* half of that: that the chips reach the text output, that
 * they are asked the preset (not the disk) about connectivity, that they stay plain and inside
 * the width a pager reads at, and — the part that is easy to get wrong — that decomposing the
 * activity reason into chips did not leave the row stating one fact three times.
 *
 * The chip vocabulary itself is `ui/labels.ts`'s to define and `ui.labels.test.ts`'s to pin.
 */
describe('row labels in the static report', () => {
  /** Every chip `labelsFor` can render, in its long form — the report's form. */
  const CHIPS = [
    'uncommitted changes',
    'linked worktree',
    'slow rebuild',
    'needs network to rebuild',
    'rebuilds offline',
  ];

  /** The indented lines that carry chips, which are the lines this feature added. */
  function chipLines(out: string): string[] {
    return out
      .split('\n')
      .filter((line) => /^ {6}\S/.test(line))
      .filter((line) => CHIPS.some((chip) => line.includes(chip)));
  }

  function occurrences(out: string, phrase: string): number {
    return out.split(phrase).length - 1;
  }

  const dirtyWorktree = makeProject({
    name: 'tinysync-wt',
    types: ['rust'],
    idleMs: 100 * DAY,
    reason: 'uncommitted but edited 100 days ago — past the 90-day grace',
    git: { hasUncommittedChanges: true, isWorktree: true },
    artifacts: [{ relPath: 'target', category: 'build', bytes: 34 * GB }],
  });

  it('says why a row is held back and what clearing it would cost', () => {
    const out = renderReport({
      projects: [dirtyWorktree],
      caches: [],
      categories: RECOMMENDED,
      preset: 'recommended',
    });

    // Uncommitted work is not at risk — the allowlist cannot name `src/` — but it is the
    // reason you may want to commit before you clear the row.
    expect(out).toContain('uncommitted changes');
    // The 34.6G worktree the user had forgotten they were keeping.
    expect(out).toContain('linked worktree');
    // The new information: what the rebuild costs, which the tool has never shown.
    expect(out).toContain('slow rebuild');
    expect(out).toContain('rebuilds offline');
  });

  it('labels the recently-used rows, which are the ones the request was about', () => {
    const out = renderReport({
      projects: [
        makeProject({
          name: 'notchpad',
          status: 'active',
          idleMs: 8 * DAY,
          reason: 'uncommitted changes, edited 8 days ago',
          git: { hasUncommittedChanges: true },
          artifacts: [{ relPath: '.next', category: 'build', bytes: 6 * GB }],
        }),
      ],
      caches: [],
      categories: RECOMMENDED,
    });

    const line = chipLines(out)[0] ?? '';
    expect(line).toContain('uncommitted changes');
    expect(line).toContain('edited 8 days ago');
    // The section header claims a convenience default, and this is the row saying what the
    // default would actually cost: a `.next` rebuild, no network, seconds.
    expect(line).toContain('rebuilds offline');
    expect(line).not.toContain('slow rebuild');
  });

  it('asks the preset, not the disk, whether the rebuild needs the network', () => {
    // The same project both ways. Under `recommended` its `node_modules` is not cleaned, so
    // clearing this row touches `dist/` alone and the rebuild needs no connectivity at all;
    // saying `needs network` there would be false, and false in the direction that costs a
    // user a rebuild they could have done on the plane.
    const projects = [
      makeProject({
        name: 'bump',
        artifacts: [
          { relPath: 'dist', category: 'build', bytes: GB },
          { relPath: 'node_modules', category: 'deps', bytes: 3 * GB },
        ],
      }),
    ];

    const recommended = renderReport({ projects, caches: [], categories: RECOMMENDED });
    expect(recommended).toContain('rebuilds offline');
    expect(recommended).not.toContain('needs network');

    const aggressive = renderReport({ projects, caches: [], categories: AGGRESSIVE });
    expect(aggressive).toContain('needs network to rebuild');
    expect(aggressive).not.toContain('rebuilds offline');
  });

  it('measures rebuild cost by ecosystem, not by size', () => {
    // The inversion is the whole content of the chip, and a size-sorted report invites
    // exactly the wrong rule: the 6G `.next` is back in seconds, the 200M `target/` is a
    // from-scratch compile of every dependency in the graph.
    const out = renderReport({
      projects: [
        makeProject({
          name: 'huge-node',
          types: ['node'],
          artifacts: [{ relPath: '.next', category: 'build', bytes: 6 * GB }],
        }),
        makeProject({
          name: 'tiny-rust',
          types: ['rust'],
          artifacts: [{ relPath: 'target', category: 'build', bytes: 200 * MB }],
        }),
      ],
      caches: [],
      categories: RECOMMENDED,
    });

    const slow = chipLines(out).filter((line) => line.includes('slow rebuild'));
    expect(slow).toHaveLength(1);
    // The report is size-ordered, so the only way to tell which row wears the chip is to
    // find it relative to the two names.
    expect(out.indexOf('slow rebuild')).toBeGreaterThan(out.indexOf('tiny-rust'));
    expect(out.indexOf('slow rebuild')).toBeGreaterThan(out.indexOf('huge-node'));
  });

  it('has no answer, rather than a reassuring one, where there is no repository', () => {
    const out = renderReport({
      projects: [makeProject({ name: 'no-repo', reason: 'edited 8mo ago' })],
      caches: [],
      categories: RECOMMENDED,
    });

    expect(out).not.toContain('uncommitted');
    expect(out).not.toContain('worktree');
    // The connectivity answer is always present, so "no chip" can never be confused with
    // "nobody worked out whether it needs the network".
    expect(out).toContain('rebuilds offline');
  });

  it('does not state one fact three times in three formats', () => {
    // `scoreActivity` writes `uncommitted changes, edited 8 days ago`, and `labelsFor` builds
    // two of its chips by copying that string apart. Printing both would put the same sentence
    // on two consecutive lines, one comma-separated and one dot-separated, which is how a
    // label row stops being read at all.
    const out = renderReport({
      projects: [
        makeProject({
          name: 'notchpad',
          status: 'active',
          idleMs: 8 * DAY,
          reason: 'uncommitted changes, edited 8 days ago',
          git: { hasUncommittedChanges: true },
        }),
      ],
      caches: [],
      categories: RECOMMENDED,
    });

    expect(out).toContain('uncommitted changes · edited 8 days ago');
    expect(occurrences(out, 'uncommitted changes')).toBe(1);
    expect(occurrences(out, 'edited 8 days ago')).toBe(1);
    // The prose form is gone entirely: the chips say every word it said.
    expect(out).not.toContain('uncommitted changes, edited 8 days ago');
  });

  it('keeps the part of the reason no chip carries', () => {
    const out = renderReport({
      projects: [dirtyWorktree],
      caches: [],
      categories: RECOMMENDED,
    });

    // Why is a project with uncommitted changes checked by default? Because the 90-day grace
    // ran out — and no chip says that, so dropping the reason wholesale would lose the answer
    // to the one question this row provokes.
    expect(out).toContain('past the 90-day grace');
    expect(out).toMatch(/\[x\]\s+tinysync-wt/);
    // ...without the word the chip already carries being stranded in front of it twice.
    expect(occurrences(out, 'uncommitted')).toBe(1);
    expect(occurrences(out, 'edited 100 days ago')).toBe(1);
    expect(out).not.toContain('uncommitted but');
    // Whole line, because lifting a clause out of the middle of a sentence leaves punctuation
    // and a conjunction behind, and `· but — past the 90-day grace` reads as a bug.
    expect(out).toContain('      rust · dormant 3mo · past the 90-day grace\n');
  });

  it('keeps a reason whole when no chip can carry it at all', () => {
    // There is deliberately no lockfile chip and no "I cannot tell" chip. These two reasons
    // are therefore the only place those signals are ever stated, and a rule that dropped the
    // reason line whenever chips were present would silently delete both.
    const out = renderReport({
      projects: [
        makeProject({ name: 'deps-only', reason: 'dependencies changed 5 days ago' }),
        makeProject({
          name: 'unscorable',
          status: 'active',
          idleMs: 0,
          reason: 'no dates to score — protected',
        }),
      ],
      caches: [],
      categories: RECOMMENDED,
    });

    expect(out).toContain('dependencies changed 5 days ago');
    expect(out).toContain('no dates to score — protected');
  });

  it('stays plain text, because this output is piped into files and pagers', () => {
    const out = renderReport({
      projects: [dirtyWorktree],
      caches: [makeCache()],
      categories: AGGRESSIVE,
    });

    // No colour, no cursor moves. An ANSI escape survives a redirect into a file and turns
    // up as `ESC[32m` in whatever reads it next; built from a char code so this assertion
    // cannot itself smuggle a control character into the source.
    expect(out).not.toContain(String.fromCharCode(0x1b));
    // Neither the list's selection glyphs nor any box drawing: a report is read through
    // `less` and committed to CI logs, where terminal furniture is noise.
    expect(out).not.toMatch(/[◉○▸─│┌┐└┘├┤┬┴┼]/u);
  });

  it('never lets a chip push a line past the width a pager reads at', () => {
    // The worst case the vocabulary can produce: every chip at once, all five in long form.
    const out = renderReport({
      projects: [
        makeProject({
          name: 'everything',
          types: ['rust'],
          idleMs: 100 * DAY,
          reason: 'uncommitted but edited 100 days ago — past the 90-day grace',
          git: { hasUncommittedChanges: true, isWorktree: true },
          artifacts: [
            { relPath: 'target', category: 'build', bytes: 34 * GB },
            { relPath: 'node_modules', category: 'deps', bytes: 3 * GB },
          ],
        }),
      ],
      caches: [],
      categories: AGGRESSIVE,
    });

    const lines = chipLines(out);
    // It really does take more than one line, so this is a wrap and not a coincidence.
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    // Wrapped, never truncated: half a fact is worse than the same fact on a second line.
    // (`rebuilds offline` is the other half of an exclusive pair, so it is not in this set.)
    for (const chip of [
      'uncommitted changes',
      'edited 100 days ago',
      'linked worktree',
      'slow rebuild',
      'needs network to rebuild',
    ]) {
      expect(out).toContain(chip);
    }
  });

  it('leaves the name and size columns exactly where they were', () => {
    const out = renderReport({
      projects: [dirtyWorktree],
      caches: [],
      categories: RECOMMENDED,
    });

    const row = out.split('\n').find((line) => line.includes('] tinysync-wt')) ?? '';
    // `  ` + `[x] ` + 34-wide name + 7-wide right-aligned size. A chip appended to this line
    // would have moved the size column and broken the one alignment the report has.
    expect(row).toBe(`  [x] ${'tinysync-wt'.padEnd(34)}${'34.0G'.padStart(7)}`);
    expect(row).toHaveLength(47);
  });

  it('does not label cache rows, which have no repository and no rebuild', () => {
    const out = renderReport({
      projects: [],
      caches: [makeCache()],
      categories: RECOMMENDED,
    });

    expect(out).toContain('pnpm store');
    for (const chip of CHIPS) expect(out).not.toContain(chip);
  });
});

describe('renderCleanSummary', () => {
  it('states the trashed total AND that the Trash must be emptied (invariant 8)', () => {
    const out = renderCleanSummary([
      cacheOutcome({ label: 'tinysync/target', bytes: 67 * GB }),
      cacheOutcome({ label: 'pnpm store', bytes: 8 * GB }),
    ]);

    expect(out).toContain('75.0G');
    expect(out).toMatch(/trash/i);
    // The disclosure itself: the space is not reclaimed until the Trash is emptied.
    expect(out).toMatch(/empty/i);
    expect(out).toMatch(/empt(y|ied)[^.]*reclaim|reclaim[^.]*empt(y|ied)/i);
  });

  it('counts only trashed bytes in the total', () => {
    const out = renderCleanSummary([
      cacheOutcome({ label: 'kept', bytes: 5 * GB, outcome: 'refused', refusal: 'symlink' }),
      cacheOutcome({ label: 'gone', bytes: 2 * GB, outcome: 'trashed' }),
    ]);

    expect(out).toContain('2.0G');
    expect(out).not.toContain('7.0G');
  });

  it('reports refusals and failures with their reason', () => {
    const out = renderCleanSummary([
      cacheOutcome({ label: 'gone', bytes: GB, outcome: 'trashed' }),
      cacheOutcome({
        label: 'bump/node_modules',
        bytes: 3 * GB,
        outcome: 'refused',
        refusal: 'symlink',
        detail: 'realpath differs from lexical path',
      }),
      cacheOutcome({
        label: 'notchpad/dist',
        bytes: 2 * GB,
        outcome: 'failed',
        detail: 'EPERM: operation not permitted',
      }),
    ]);

    expect(out).toContain('refused');
    expect(out).toContain('symlink');
    expect(out).toContain('bump/node_modules');
    expect(out).toContain('failed');
    expect(out).toContain('EPERM: operation not permitted');
  });

  it('does not claim anything is in the Trash when nothing was trashed', () => {
    const out = renderCleanSummary([
      cacheOutcome({ label: 'kept', bytes: 5 * GB, outcome: 'refused', refusal: 'guarded-path' }),
    ]);

    expect(out).toMatch(/nothing was moved to the trash/i);
    expect(out).not.toMatch(/empty it to reclaim/i);
  });

  it('handles an empty outcome list', () => {
    const out = renderCleanSummary([]);
    expect(out).toMatch(/nothing/i);
    expect(out.endsWith('\n')).toBe(true);
  });
});
