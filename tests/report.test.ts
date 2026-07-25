/**
 * The static report is the only view a non-TTY user gets, and `renderCleanSummary` is the
 * only place invariant 8 is discharged: Trash does not reclaim disk until it is emptied,
 * so a run that reports "freed 70G" without that sentence is actively misleading.
 *
 * Both functions are pure string builders over synthetic data — no filesystem, no scan.
 */

import { describe, expect, it } from 'vitest';

import { renderCleanSummary, renderReport } from '../src/report.js';
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

    expect(out).toContain('ACTIVE');
    // Dormant is marked, active is not: protection is the default (spec: activity scoring).
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
