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
