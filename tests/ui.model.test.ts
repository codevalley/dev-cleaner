/**
 * The TUI's logic lives in `src/ui/model.ts` precisely so it can be tested here, without
 * rendering. Every rule the interface promises — dormant selected by default, active
 * protected but still reachable, sections ordered, sizes descending, targets emitted as
 * the discriminated union — is asserted against pure functions.
 */

import { describe, expect, it } from 'vitest';

import { formatBytes, formatDate, formatIdle, truncateLabel } from '../src/ui/format.js';
import {
  buildRows,
  cyclePreset,
  defaultSelection,
  firstSelectableId,
  isSelected,
  moveCursor,
  projectBytes,
  selectedBytes,
  selectedCount,
  selectedRows,
  toTargets,
  toggleRow,
  toggleSection,
  upsertProject,
  type Row,
  type Selection,
} from '../src/ui/model.js';
import type { Artifact, CacheEntry, Category, Project } from '../src/types.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RECOMMENDED: Set<Category> = new Set<Category>(['build', 'cache']);
const AGGRESSIVE: Set<Category> = new Set<Category>(['build', 'deps', 'cache']);

function artifact(relPath: string, category: Category, bytes: number): Artifact {
  return { path: `/dev/x/${relPath}`, relPath, category, bytes };
}

function makeProject(
  name: string,
  status: 'active' | 'dormant',
  artifacts: readonly Artifact[],
): Project {
  return {
    root: `/dev/${name}`,
    name,
    types: new Set(['node']),
    artifacts: artifacts.map((entry) => ({ ...entry, path: `/dev/${name}/${entry.relPath}` })),
    bytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
    activity: { status, idleMs: status === 'dormant' ? 240 * DAY : 2 * DAY, reason: 'test' },
  };
}

function makeCache(id: string, bytes: number): CacheEntry {
  return { id, label: id, path: `/caches/${id}`, bytes, note: 'safe' };
}

function rowsOf(
  projects: readonly Project[],
  caches: readonly CacheEntry[] = [],
  categories: ReadonlySet<Category> = AGGRESSIVE,
): Row[] {
  return buildRows({ projects, caches, categories });
}

function labels(rows: readonly Row[]): string[] {
  return rows.map((row) => row.label);
}

describe('formatBytes', () => {
  it('renders one decimal below 100 and none above, matching the spec mock', () => {
    expect(formatBytes(67 * GB)).toBe('67.0G');
    expect(formatBytes(133 * GB)).toBe('133G');
    expect(formatBytes(3.4 * GB)).toBe('3.4G');
    expect(formatBytes(512 * MB)).toBe('512M');
    expect(formatBytes(1.5 * MB)).toBe('1.5M');
    expect(formatBytes(2 * KB)).toBe('2.0K');
  });

  it('renders whole bytes and degenerate inputs without NaN', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(-1)).toBe('0B');
    expect(formatBytes(Number.NaN)).toBe('0B');
  });
});

describe('formatIdle', () => {
  it('renders a coarse, single-unit age', () => {
    expect(formatIdle(0)).toBe('now');
    expect(formatIdle(30 * MINUTE)).toBe('30m');
    expect(formatIdle(5 * HOUR)).toBe('5h');
    expect(formatIdle(3 * DAY)).toBe('3d');
    expect(formatIdle(240 * DAY)).toBe('8mo');
    expect(formatIdle(800 * DAY)).toBe('2y');
    expect(formatIdle(-5)).toBe('now');
  });
});

describe('truncateLabel', () => {
  it('keeps short labels and ellipsises long ones to exactly the width', () => {
    expect(truncateLabel('bump', 10)).toBe('bump');
    expect(truncateLabel('a-very-long-project-name', 10)).toHaveLength(10);
    expect(truncateLabel('a-very-long-project-name', 10).endsWith('…')).toBe(true);
  });
});

describe('formatDate', () => {
  it('renders an ISO day for the detail pane', () => {
    expect(formatDate(Date.UTC(2025, 10, 14, 12, 0, 0))).toBe('2025-11-14');
    expect(formatDate(0)).toBe('—');
  });
});

describe('projectBytes', () => {
  it('counts only artifacts in the enabled categories', () => {
    const project = makeProject('bump', 'dormant', [
      artifact('node_modules', 'deps', 3 * GB),
      artifact('dist', 'build', 1 * GB),
      artifact('.turbo', 'cache', 512 * MB),
    ]);

    expect(projectBytes(project, AGGRESSIVE)).toBe(3 * GB + 1 * GB + 512 * MB);
    expect(projectBytes(project, RECOMMENDED)).toBe(1 * GB + 512 * MB);
  });
});

describe('buildRows', () => {
  it('orders sections PROJECTS -> ACTIVE -> CACHES with sizes descending', () => {
    const rows = rowsOf(
      [
        makeProject('small-dormant', 'dormant', [artifact('dist', 'build', 1 * GB)]),
        makeProject('busy', 'active', [artifact('dist', 'build', 9 * GB)]),
        makeProject('big-dormant', 'dormant', [artifact('target', 'build', 67 * GB)]),
      ],
      [makeCache('npm', 2 * GB), makeCache('pnpm-store', 8 * GB)],
    );

    expect(rows.map((row) => `${row.kind}:${row.label}`)).toEqual([
      'header:PROJECTS',
      'project:big-dormant',
      'project:small-dormant',
      'header:ACTIVE (protected)',
      'project:busy',
      'header:CACHES',
      'cache:pnpm-store',
      'cache:npm',
    ]);
  });

  it('gives each header the section total and count', () => {
    const rows = rowsOf(
      [
        makeProject('a', 'dormant', [artifact('dist', 'build', 1 * GB)]),
        makeProject('b', 'dormant', [artifact('dist', 'build', 2 * GB)]),
      ],
      [makeCache('npm', 4 * GB)],
    );

    const projectsHeader = rows.find((row) => row.kind === 'header' && row.label === 'PROJECTS');
    expect(projectsHeader?.bytes).toBe(3 * GB);
    expect(projectsHeader?.kind === 'header' ? projectsHeader.count : 0).toBe(2);
  });

  it('omits sections that have no members', () => {
    const rows = rowsOf([makeProject('only', 'dormant', [artifact('dist', 'build', GB)])]);
    expect(labels(rows)).toEqual(['PROJECTS', 'only']);
  });

  it('drops projects with nothing to clean under the current categories', () => {
    const rows = rowsOf(
      [makeProject('deps-only', 'dormant', [artifact('node_modules', 'deps', 3 * GB)])],
      [],
      RECOMMENDED,
    );
    expect(rows).toEqual([]);
  });

  it('re-sorts as sizes change, which is what progressive rendering needs', () => {
    const early = makeProject('later-bigger', 'dormant', [artifact('target', 'build', 0)]);
    const other = makeProject('steady', 'dormant', [artifact('dist', 'build', 5 * GB)]);

    expect(labels(rowsOf([early, other]))).toEqual(['PROJECTS', 'steady', 'later-bigger']);

    const grown = makeProject('later-bigger', 'dormant', [artifact('target', 'build', 67 * GB)]);
    expect(labels(rowsOf(upsertProject([early, other], grown)))).toEqual([
      'PROJECTS',
      'later-bigger',
      'steady',
    ]);
  });
});

describe('defaultSelection', () => {
  const rows = rowsOf(
    [
      makeProject('dormant-one', 'dormant', [artifact('target', 'build', 4 * GB)]),
      makeProject('active-one', 'active', [artifact('dist', 'build', 2 * GB)]),
    ],
    [makeCache('npm', 1 * GB)],
  );
  const selection = defaultSelection(rows);

  it('selects dormant projects', () => {
    const dormant = rows.find((row) => row.label === 'dormant-one');
    expect(dormant && isSelected(selection, dormant)).toBe(true);
  });

  it('leaves active projects unselected — protection is a default', () => {
    const active = rows.find((row) => row.label === 'active-one');
    expect(active && isSelected(selection, active)).toBe(false);
  });

  it('still lets the user select an active project — a default, not a lock', () => {
    const active = rows.find((row) => row.label === 'active-one');
    expect(active).toBeDefined();
    const toggled = toggleRow(selection, active as Row);

    expect(isSelected(toggled, active as Row)).toBe(true);
    expect(selectedBytes(rows, toggled)).toBe(4 * GB + 1 * GB + 2 * GB);
  });

  it('never mutates the selection it is handed', () => {
    const active = rows.find((row) => row.label === 'active-one') as Row;
    const before: Selection = defaultSelection(rows);
    toggleRow(before, active);
    expect(isSelected(before, active)).toBe(false);
  });
});

/**
 * A cache the run has already established it would refuse.
 *
 * This is the selection half of the honesty fix. `clean.ts` refuses an unsafe store prune
 * and that refusal stays — but a refusal is only meaningful if it is rare. Preselecting
 * 7.5G the tool already knows it will refuse counts those bytes into the total the user
 * consents to, and then hands back a refusal for the largest line in the run. Do that once
 * and the user reads the next refusal as noise.
 */
describe('defaultSelection and a cache that cannot be cleaned', () => {
  function blockedCache(id: string, bytes: number, reason: string): CacheEntry {
    return { ...makeCache(id, bytes), blocked: { reason } };
  }

  const rows = rowsOf(
    [makeProject('dormant-one', 'dormant', [artifact('target', 'build', 4 * GB)])],
    [blockedCache('pnpm-store', 7 * GB, 'node_modules elsewhere still link into it'), makeCache('npm', 1 * GB)],
  );
  const selection = defaultSelection(rows);
  const store = rows.find((row) => row.label === 'pnpm-store') as Row;
  const npm = rows.find((row) => row.label === 'npm') as Row;

  it('does not preselect it', () => {
    expect(store).toBeDefined();
    expect(isSelected(selection, store)).toBe(false);
  });

  it('still preselects the caches that are actually clean', () => {
    expect(isSelected(selection, npm)).toBe(true);
  });

  it('still lists it — it exists and it occupies disk, and hiding it is its own lie', () => {
    expect(labels(rows)).toContain('pnpm-store');
    expect(store.bytes).toBe(7 * GB);
  });

  it('leaves its bytes out of what the run promises to reclaim', () => {
    // 4G of project + 1G of npm cache. The 7G store is listed but not promised; before the
    // fix this read 12G, and the run then delivered 5G.
    expect(selectedBytes(rows, selection)).toBe(5 * GB);
    expect(selectedCount(rows, selection)).toBe(2);
  });

  it('still lets the user select it by hand — a default, not a lock', () => {
    // Exactly as with a protected active project. The boundary refusal in `clean.ts` is
    // what makes leaving this reachable safe.
    const toggled = toggleRow(selection, store);
    expect(isSelected(toggled, store)).toBe(true);
    expect(selectedBytes(rows, toggled)).toBe(12 * GB);
  });

  it('is selected by a section toggle like any other row', () => {
    const all = toggleSection(selection, rows, 'caches');
    expect(isSelected(all, store)).toBe(true);
  });

  it('still becomes a clean target once chosen, so the boundary can do its job', () => {
    // If this row were filtered out of `toTargets`, `clean.ts`'s own invariant-5 check
    // would be unreachable from the only path a user can invoke — and defence in depth
    // would quietly become defence in one.
    const targets = toTargets({
      rows,
      selection: toggleRow(selection, store),
      categories: AGGRESSIVE,
    });
    expect(targets).toContainEqual({ kind: 'cache', cache: (store as { cache: CacheEntry }).cache });
  });
});

describe('toggleSection', () => {
  const rows = rowsOf([
    makeProject('a', 'dormant', [artifact('dist', 'build', 1 * GB)]),
    makeProject('b', 'dormant', [artifact('dist', 'build', 2 * GB)]),
    makeProject('c', 'active', [artifact('dist', 'build', 3 * GB)]),
  ]);

  it('clears a fully selected section', () => {
    const cleared = toggleSection(defaultSelection(rows), rows, 'projects');
    expect(selectedCount(rows, cleared)).toBe(0);
  });

  it('selects every row of a partly selected section, including the protected one', () => {
    const filled = toggleSection(defaultSelection(rows), rows, 'active');
    expect(selectedCount(rows, filled)).toBe(3);
  });
});

describe('cursor movement', () => {
  const rows = rowsOf(
    [
      makeProject('a', 'dormant', [artifact('dist', 'build', 2 * GB)]),
      makeProject('b', 'dormant', [artifact('dist', 'build', 1 * GB)]),
    ],
    [makeCache('npm', 1 * GB)],
  );

  it('starts on the first selectable row, never a header', () => {
    expect(firstSelectableId(rows)).toBe(rows[1]?.id);
  });

  it('skips headers and clamps at both ends', () => {
    const first = firstSelectableId(rows);
    const second = moveCursor(rows, first, 1);
    const third = moveCursor(rows, second, 1);

    expect(second).toBe(rows[2]?.id);
    expect(third).toBe(rows[4]?.id); // the cache row, header skipped
    expect(moveCursor(rows, third, 1)).toBe(third);
    expect(moveCursor(rows, first, -1)).toBe(first);
  });

  it('falls back to the first selectable row when the cursor row has disappeared', () => {
    expect(moveCursor(rows, 'gone', 1)).toBe(firstSelectableId(rows));
  });
});

describe('cyclePreset', () => {
  it('cycles between the two keyboard presets and rescues custom', () => {
    expect(cyclePreset('recommended')).toBe('aggressive');
    expect(cyclePreset('aggressive')).toBe('recommended');
    expect(cyclePreset('custom')).toBe('recommended');
  });

  it('changes which categories, and therefore which bytes, are in play', () => {
    const project = makeProject('bump', 'dormant', [
      artifact('node_modules', 'deps', 3 * GB),
      artifact('dist', 'build', 1 * GB),
    ]);

    const recommended = rowsOf([project], [], RECOMMENDED);
    const aggressive = rowsOf([project], [], AGGRESSIVE);

    expect(recommended[1]?.bytes).toBe(1 * GB);
    expect(aggressive[1]?.bytes).toBe(4 * GB);
  });
});

describe('toTargets', () => {
  const project = makeProject('bump', 'dormant', [
    artifact('node_modules', 'deps', 3 * GB),
    artifact('dist', 'build', 1 * GB),
  ]);
  const cache = makeCache('pnpm-store', 8 * GB);

  it('emits the discriminated union carrying the project and the artifact', () => {
    const rows = rowsOf([project], [cache], AGGRESSIVE);
    const targets = toTargets({ rows, selection: defaultSelection(rows), categories: AGGRESSIVE });

    const projectTargets = targets.filter((target) => target.kind === 'project');
    expect(projectTargets).toHaveLength(2);

    for (const target of projectTargets) {
      expect(target.kind).toBe('project');
      // The flattened {path, bytes} shape is what makes clean.ts's guards unreachable.
      expect(Object.keys(target).sort()).toEqual(['artifact', 'kind', 'project']);
      if (target.kind !== 'project') throw new Error('unreachable');
      expect(target.project).toBe(project);
      expect(project.artifacts).toContain(target.artifact);
      expect(target).not.toHaveProperty('path');
      expect(target).not.toHaveProperty('bytes');
    }

    const cacheTargets = targets.filter((target) => target.kind === 'cache');
    expect(cacheTargets).toEqual([{ kind: 'cache', cache }]);
  });

  it('emits only artifacts in the enabled categories', () => {
    const rows = rowsOf([project], [], RECOMMENDED);
    const targets = toTargets({
      rows,
      selection: defaultSelection(rows),
      categories: RECOMMENDED,
    });

    expect(targets).toHaveLength(1);
    const only = targets[0];
    if (only?.kind !== 'project') throw new Error('expected a project target');
    expect(only.artifact.relPath).toBe('dist');
  });

  it('emits nothing for unselected rows', () => {
    const rows = rowsOf([project], [cache], AGGRESSIVE);
    const empty: Selection = { projects: new Set(), caches: new Set() };
    expect(toTargets({ rows, selection: empty, categories: AGGRESSIVE })).toEqual([]);
  });

  it('lists the selected rows for the confirmation screen', () => {
    const rows = rowsOf([project], [cache], AGGRESSIVE);
    expect(labels(selectedRows(rows, defaultSelection(rows)))).toEqual(['bump', 'pnpm-store']);
  });
});
