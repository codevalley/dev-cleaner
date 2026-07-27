/**
 * The chip column: what the list pane can afford to say, and what the detail pane says instead.
 *
 * `labels.ts` decides *which* chips a project has and `ui.labels.test.ts` pins that down. This
 * file is about the other half — a pane 52 columns wide holding a chip string 57 columns long —
 * and the two properties that make the difference between a scannable column and decoration.
 *
 * **A row is exactly one line.** `viewport.ts` counts rows as physical lines and the footer is
 * pinned on that count, so a row that wraps takes the keybindings off the screen. Every width
 * assertion below is really that assertion.
 *
 * **A missing chip means the row does not have it — never that there was no room.** This is
 * why the pane plans one chip set for every row it draws rather than fitting each row on its
 * own. A per-row fit is strictly more informative and strictly worse: a user scanning for
 * worktrees would read a crowded row's silence as "not a worktree" and be wrong, and would
 * read it confidently, because the chip is demonstrably drawn two rows below. Several tests
 * here assert an *absence* for exactly that reason.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { Detail } from '../src/ui/Detail.js';
import { List, chipBudget, chipPlan, chipsFor, renderRow } from '../src/ui/List.js';
import { LABEL_HELP, LABEL_SEPARATOR, joinLabels, labelsFor } from '../src/ui/labels.js';
import { EMPTY_SELECTION, type Row } from '../src/ui/model.js';
import type { Viewport } from '../src/ui/viewport.js';
import type { Artifact, Category, Project, ProjectType } from '../src/types.js';

const MB = 1024 * 1024;
const GB = MB * 1024;
const DAY = 86_400_000;

const NOW = Date.UTC(2026, 6, 25);

const RECOMMENDED = new Set<Category>(['build', 'cache']);
const AGGRESSIVE = new Set<Category>(['build', 'deps', 'cache']);

function artifact(relPath: string, category: Category, bytes: number): Artifact {
  return { path: `/dev/${relPath}`, relPath, category, bytes };
}

interface ProjectOptions {
  types?: ProjectType[];
  artifacts?: Artifact[];
  dirty?: boolean;
  worktree?: boolean;
  /** Written the way `scoreActivity` writes it — the chip is read back out of this. */
  reason?: string;
  idleMs?: number;
  git?: false;
}

/**
 * A project shaped for a chip, not for a scan.
 *
 * `reason` is a real `scoreActivity` sentence rather than a chip, because that is the coupling
 * `labels.ts` deliberately took on: the recency chip is parsed out of the same string the
 * detail pane prints. Handing it something else here would test a fiction.
 */
function project(name: string, options: ProjectOptions = {}): Project {
  const artifacts = (options.artifacts ?? [artifact('dist', 'build', 2 * GB)]).map((entry) => ({
    ...entry,
    path: `/dev/${name}/${entry.relPath}`,
  }));
  return {
    root: `/dev/${name}`,
    name,
    types: new Set<ProjectType>(options.types ?? ['node']),
    artifacts,
    bytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
    ...(options.git === false
      ? {}
      : {
          git: {
            branch: 'main',
            lastCommitMs: NOW - 3 * DAY,
            hasUncommittedChanges: options.dirty ?? false,
            isWorktree: options.worktree ?? false,
          },
        }),
    activity: {
      status: 'active',
      idleMs: options.idleMs ?? 3 * DAY,
      reason: options.reason ?? 'edited 3 days ago',
    },
  };
}

function projectRow(value: Project): Row {
  return {
    kind: 'project',
    id: value.root,
    section: 'active',
    label: value.name,
    bytes: value.bytes,
    project: value,
  };
}

function headerRow(label: string, count: number, bytes: number): Row {
  return { kind: 'header', id: `header:${label}`, section: 'active', label, bytes, count };
}

function cacheRow(id: string, bytes: number): Row {
  return {
    kind: 'cache',
    id,
    section: 'caches',
    label: id,
    bytes,
    cache: { id, label: id, path: `/caches/${id}`, bytes, note: 'refills on the next build' },
  };
}

/** Every chip a project has, drawn under a plan wide enough to have kept all of them. */
function everyChip(value: Project, categories: ReadonlySet<Category>): string {
  return joinLabels(labelsFor(value, categories));
}

/** The chips one row would draw at `width`, plan and all — the whole pipeline in one call. */
function chipsAt(
  rows: readonly Row[],
  target: Row,
  width: number,
  categories: ReadonlySet<Category>,
): string {
  return chipsFor(target, categories, chipPlan(rows, categories, chipBudget(width)));
}

/**
 * The project the width ladder is measured against: every chip a row can have at once.
 *
 * Rust so the rebuild is `slow`, a `deps` artifact so it `needs network`, dirty and a linked
 * worktree so both git chips fire, and a reason a person's edit decided. Its chip string is
 * 57 columns; the pane is at most 52.
 */
const CROWDED = project('crowded', {
  types: ['rust'],
  artifacts: [artifact('target', 'build', 9 * GB), artifact('vendor/bundle', 'deps', GB)],
  dirty: true,
  worktree: true,
});

const rendered: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

describe('the chip column', () => {
  it('draws every chip when the pane is wide enough for them', () => {
    const rows = [projectRow(CROWDED)];
    expect(everyChip(CROWDED, AGGRESSIVE)).toBe(
      'uncommitted · edited 3d · worktree · slow · needs network',
    );
    expect(chipsAt(rows, rows[0] as Row, 100, AGGRESSIVE)).toBe(everyChip(CROWDED, AGGRESSIVE));
  });

  /**
   * The ladder, and the argument for its order.
   *
   * `offline` goes first and costs nothing: with `network` still standing, a row with no
   * connectivity chip is a row that rebuilds offline. `recency` next — the section header and
   * the detail pane both already say it. Then the two cost chips, and `worktree` and
   * `uncommitted` survive longest because nothing else in this pane hints at either.
   */
  it.each([
    [100, 'uncommitted · edited 3d · worktree · slow · needs network'],
    [80, 'uncommitted · worktree · slow · needs network'],
    [60, 'uncommitted · worktree · slow'],
    [50, 'uncommitted · worktree'],
    [45, 'uncommitted'],
    [30, ''],
  ])('at %i columns draws %s', (width, expected) => {
    const rows = [projectRow(CROWDED)];
    expect(chipsAt(rows, rows[0] as Row, width, AGGRESSIVE)).toBe(expected);
  });

  it('draws nothing at all once the name would be squeezed', () => {
    // The budget goes negative before it goes to zero: below this the name takes everything,
    // which is the one thing on the row the user cannot do without.
    expect(chipBudget(26)).toBeLessThanOrEqual(0);
    const rows = [projectRow(CROWDED)];
    expect(chipPlan(rows, AGGRESSIVE, chipBudget(26))).toEqual({ kinds: new Set(), width: 0 });
    expect(chipsAt(rows, rows[0] as Row, 26, AGGRESSIVE)).toBe('');
    // …and the row is byte-for-byte the row this pane drew before chips existed: name padded
    // across the whole interior, size on the end.
    expect(renderRow(rows[0] as Row, 26, '', 0, false, false)).toBe(' ○ crowded           10.0G');
  });

  /**
   * The layout guarantee, stated as arithmetic rather than as a rendered frame.
   *
   * A row is *exactly* its declared width at every width the panes can take, whatever the chip
   * column costs — because the chip column is taken out of the name rather than added beside
   * it. One column over and Yoga wraps the row, and a wrapped row is a footer off the screen.
   */
  it('spends exactly its declared width, chips or no chips, at every width', () => {
    const rows = [
      headerRow('IN USE RECENTLY', 3, 12 * GB),
      projectRow(CROWDED),
      projectRow(project('a-really-quite-long-repository-name', { dirty: true })),
      projectRow(project('x')),
      cacheRow('npm', 3 * GB),
    ];

    for (let width = 18; width <= 120; width += 1) {
      const plan = chipPlan(rows, AGGRESSIVE, chipBudget(width));
      for (const row of rows) {
        const line = renderRow(row, width, chipsFor(row, AGGRESSIVE, plan), plan.width, true, true);
        expect(line, `width ${width}: ${JSON.stringify(line)}`).toHaveLength(width);
        expect(line).not.toContain('\n');
      }
    }
  });

  /**
   * Chips are given up whole. The alternative — clipping the string to the column — reads as
   * `uncommitted · edited 3d · workt` and is worse than saying nothing: it invents a word.
   */
  it('never draws half a chip, at any width', () => {
    const rows = [projectRow(CROWDED)];
    const words = new Set(labelsFor(CROWDED, AGGRESSIVE).map((label) => label.text));

    for (let width = 18; width <= 120; width += 1) {
      const chips = chipsAt(rows, rows[0] as Row, width, AGGRESSIVE);
      if (chips === '') continue;
      for (const part of chips.split(LABEL_SEPARATOR)) expect(words).toContain(part);
    }
  });

  /**
   * …and drops the row's chips whole if it is ever handed a column they do not fit.
   *
   * The plan makes that unreachable from the pane — it sizes the column to the widest row it
   * was given. It is reachable from anywhere else: a plan built over a different row set, or a
   * future change that windows the plan to the visible slice. The failure it guards against is
   * not a cosmetic overflow but a wrapped row, and a wrapped row unpins the footer.
   */
  it('draws nothing rather than overflow a column it was handed', () => {
    const row = projectRow(CROWDED);
    const tight = { kinds: new Set(labelsFor(CROWDED, AGGRESSIVE).map((l) => l.kind)), width: 20 };
    expect(chipsFor(row, AGGRESSIVE, tight)).toBe('');
  });

  /**
   * The column property, and the reason the plan is made once for the pane.
   *
   * At 50 columns the crowded row can afford `uncommitted · worktree` and nothing more, so
   * `recency` is given up — by *everybody*. The quiet worktree two rows down could have fitted
   * `edited 3d · worktree` on its own, and must not: a column where some rows answer a question
   * and others stay silent for reasons of width cannot be read down.
   */
  it('gives a chip up for the whole pane or for nobody', () => {
    const quiet = project('quiet-worktree', { worktree: true });
    const plain = project('plain', {});
    const rows = [projectRow(CROWDED), projectRow(quiet), projectRow(plain)];

    const drawn = (row: Row): string => chipsAt(rows, row, 50, AGGRESSIVE);

    // Kept: every row that is a worktree says so.
    expect(drawn(rows[0] as Row)).toContain('worktree');
    expect(drawn(rows[1] as Row)).toContain('worktree');
    // Given up: nobody says it, though `quiet` alone had room.
    expect(drawn(rows[0] as Row)).not.toContain('edited');
    expect(drawn(rows[1] as Row)).not.toContain('edited');
    expect(drawn(rows[1] as Row)).toBe('worktree');
    // …and a row that simply is not a worktree is silent, which now means only that.
    expect(drawn(rows[2] as Row)).toBe('');
  });

  it('does not reflow the column as the user scrolls', () => {
    // The plan is computed over every row, not the visible slice, so a crowded row below the
    // fold costs the same columns whether or not it is currently drawn.
    const rows = [projectRow(CROWDED), ...Array.from({ length: 8 }, (_, i) => projectRow(project(`p${i}`)))];
    const whole = chipPlan(rows, AGGRESSIVE, chipBudget(60));
    const firstScreen = chipPlan(rows.slice(0, 3), AGGRESSIVE, chipBudget(60));
    const lastScreen = chipPlan(rows.slice(-3), AGGRESSIVE, chipBudget(60));

    // The pane uses `whole` for both screens — that is the point. If it used the slice, the
    // column would be these two different widths as the user pressed `j`.
    expect(firstScreen.width).not.toBe(lastScreen.width);
    expect(whole.width).toBe(firstScreen.width);
  });

  it('draws no chips beside a header or a cache', () => {
    const rows = [headerRow('CACHES', 2, 4 * GB), cacheRow('npm', 3 * GB), projectRow(CROWDED)];
    const plan = chipPlan(rows, AGGRESSIVE, chipBudget(100));
    expect(chipsFor(rows[0] as Row, AGGRESSIVE, plan)).toBe('');
    expect(chipsFor(rows[1] as Row, AGGRESSIVE, plan)).toBe('');
    expect(chipsFor(rows[2] as Row, AGGRESSIVE, plan)).not.toBe('');
  });

  /**
   * The preset narrows the chips as well as the sizes.
   *
   * Under `recommended` a Node project's `node_modules` is not cleaned, so clearing it touches
   * `dist/` alone and needs no network — and saying `needs network` there would be a plain
   * falsehood about work the tool is not going to do.
   */
  it('reads the preset before claiming a row needs the network', () => {
    const node = project('web', {
      artifacts: [artifact('dist', 'build', GB), artifact('node_modules', 'deps', 4 * GB)],
    });
    const rows = [projectRow(node)];

    expect(chipsAt(rows, rows[0] as Row, 100, RECOMMENDED)).toContain('offline');
    expect(chipsAt(rows, rows[0] as Row, 100, RECOMMENDED)).not.toContain('needs network');
    expect(chipsAt(rows, rows[0] as Row, 100, AGGRESSIVE)).toContain('needs network');
  });

  /**
   * And stays quiet about it when it was not told the preset at all.
   *
   * `labelsFor` still answers in that case, over-warning on purpose — right for a report read
   * on its own, wrong for a pane with another pane beside it. The detail pane always has the
   * preset, so the two would be printing opposite answers on the same frame, and a user who
   * notices that stops believing either of them.
   */
  it('says nothing about connectivity rather than contradict the detail pane', () => {
    // The contradiction being avoided, stated outright: the same project, two answers.
    expect(joinLabels(labelsFor(CROWDED))).toContain('needs network');
    expect(joinLabels(labelsFor(CROWDED, RECOMMENDED))).toContain('offline');

    const rows = [projectRow(CROWDED)];
    const plan = chipPlan(rows, undefined, chipBudget(100));
    expect(chipsFor(rows[0] as Row, undefined, plan)).toBe(
      'uncommitted · edited 3d · worktree · slow',
    );
  });

  it('costs the name columns rather than the size column', () => {
    const long = project('an-extremely-long-repository-name-indeed', { dirty: true });
    const rows = [projectRow(long)];
    const plan = chipPlan(rows, AGGRESSIVE, chipBudget(56));
    const line = renderRow(rows[0] as Row, 56, chipsFor(rows[0] as Row, AGGRESSIVE, plan), plan.width, false, false);

    expect(line).toContain('uncommitted');
    // The size is still where it always was: last, right-aligned, six columns.
    expect(line.slice(-6)).toBe('  2.0G');
    // …and the name gave up the room, visibly.
    expect(line).toContain('…');
  });
});

describe('a row is one line', () => {
  const view = (count: number): Viewport => ({ start: 0, end: count, cursor: 0 });

  const mount = (width: number): ReturnType<typeof render> => {
    const rows = [
      headerRow('IN USE RECENTLY', 3, 12 * GB),
      projectRow(CROWDED),
      projectRow(project('quiet', { worktree: true })),
      projectRow(project('plain')),
    ];
    const instance = render(
      <List
        rows={rows}
        cursorId={CROWDED.root}
        selection={EMPTY_SELECTION}
        width={width}
        view={view(rows.length)}
        categories={AGGRESSIVE}
      />,
    );
    rendered.push(instance);
    return instance;
  };

  it.each([26, 40, 56, 72, 90])('draws four rows and a hint line at %i columns', (width) => {
    const frame = mount(width).lastFrame() ?? '';
    // Four rows plus the always-drawn scroll hint. One more means a row wrapped.
    expect(frame.split('\n')).toHaveLength(5);
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(width);
  });

  it('puts the chips on the row at a comfortable width', () => {
    expect(mount(90).lastFrame() ?? '').toContain('uncommitted · edited 3d · worktree');
  });

  it('puts none on the row at a narrow one', () => {
    const frame = mount(26).lastFrame() ?? '';
    expect(frame).toContain('crowded');
    expect(frame).not.toContain('uncommitted');
    expect(frame).not.toContain('worktree');
  });
});

/**
 * The pane the list defers to.
 *
 * The list gives chips up; this is where they are unconditionally kept, and where the sentence
 * behind each one lives. Rendered directly rather than through `App` so the height is a
 * parameter of the test — the point of the block below is what the pane says when it *has*
 * room, and separately that it still cannot outgrow the room it is given.
 */
describe('the detail pane carries every chip', () => {
  const flat = (frame: string): string => frame.replace(/\s+/g, ' ').trim();

  const mount = (value: Project, width: number, height: number): string => {
    const instance = render(
      <Detail row={projectRow(value)} categories={AGGRESSIVE} width={width} height={height} />,
    );
    rendered.push(instance);
    return flat(instance.lastFrame() ?? '');
  };

  it('names every chip the row has, in long form, under the project name', () => {
    const frame = mount(CROWDED, 44, 80);
    expect(frame).toContain(
      'uncommitted changes · edited 3 days ago · linked worktree · slow rebuild · needs network to rebuild',
    );
  });

  it('explains every chip it names', () => {
    const frame = mount(CROWDED, 44, 80);
    for (const label of labelsFor(CROWDED, AGGRESSIVE)) {
      expect(frame, `no help for ${label.kind}`).toContain(flat(LABEL_HELP[label.kind]));
    }
  });

  it('explains the chips the list pane could not afford', () => {
    // At 50 columns the row itself says `uncommitted · worktree` and nothing else.
    expect(chipsAt([projectRow(CROWDED)], projectRow(CROWDED), 50, AGGRESSIVE)).toBe(
      'uncommitted · worktree',
    );
    const frame = mount(CROWDED, 44, 80);
    expect(frame).toContain(flat(LABEL_HELP.network));
    expect(frame).toContain(flat(LABEL_HELP.slow));
  });

  it('says nothing about connectivity in a language the preset contradicts', () => {
    const node = project('web', {
      artifacts: [artifact('dist', 'build', GB), artifact('node_modules', 'deps', 4 * GB)],
    });
    const instance = render(
      <Detail row={projectRow(node)} categories={RECOMMENDED} width={44} height={80} />,
    );
    rendered.push(instance);
    const frame = flat(instance.lastFrame() ?? '');
    expect(frame).toContain('rebuilds offline');
    expect(frame).not.toContain('needs network to rebuild');
  });

  /**
   * The chips do not get to break the pane either. Both panes are flex siblings of a frame
   * whose height is the terminal's, so a detail pane one line too tall scrolls the footer off
   * exactly as an over-long list would.
   */
  it.each([1, 4, 10, 16])('still fits in %i lines', (height) => {
    const instance = render(
      <Detail row={projectRow(CROWDED)} categories={AGGRESSIVE} width={44} height={height} />,
    );
    rendered.push(instance);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(height);
  });

  it('keeps the sizes above the explanations, because the sizes are why anyone is here', () => {
    const instance = render(
      <Detail row={projectRow(CROWDED)} categories={AGGRESSIVE} width={44} height={80} />,
    );
    rendered.push(instance);
    const lines = (instance.lastFrame() ?? '').split('\n');
    const total = lines.findIndex((line) => line.includes('total'));
    const help = lines.findIndex((line) => line.includes('Rebuilding this takes minutes'));
    expect(total).toBeGreaterThan(-1);
    expect(help).toBeGreaterThan(total);
  });
});

/**
 * Two defects found by adversarial review of the finished chip work. Both are the same shape
 * as bugs this codebase has hit before, which is why each gets a test rather than just a fix.
 *
 * The first is "implemented but not connected": `categories` was computed in App, passed to
 * `<Detail>`, and omitted from `<List>` — so `chipsOf` dropped the network/offline pair and
 * two of the six chip kinds could never appear in the pane they were designed for. Every
 * unit test passed, because they all called `chipsOf` directly.
 *
 * The second is the fixed-height budget: one unpadded, untruncated line is enough to wrap the
 * pane and push the pinned footer off the screen.
 */
describe('the chip column is actually reachable from the app', () => {
  it('passes a category set through to the list, so connectivity chips can appear', () => {
    const deps = new Set<Category>(['build', 'deps', 'cache']);
    const withDeps = projectRow(
      project('app', {
        artifacts: [artifact('node_modules', 'deps', GB), artifact('dist', 'build', GB)],
      }),
    );

    const plan = chipPlan([withDeps], deps, chipBudget(100));
    expect(chipsFor(withDeps, deps, plan)).toContain('needs network');

    // ...and with no category set the pair is correctly WITHHELD rather than guessed:
    // "needs network" is false under a preset that does not clean node_modules, so a chip
    // that guesses is worse than no chip.
    const planless = chipPlan([withDeps], undefined, chipBudget(100));
    const guessed = chipsFor(withDeps, undefined, planless);
    expect(guessed).not.toContain('needs network');
    expect(guessed).not.toContain('offline');
  });
});
