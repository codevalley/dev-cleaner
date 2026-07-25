/**
 * The Ink app, driven through a real render and a real (fake) stdin.
 *
 * The property worth defending here is **progressive rendering**. Sizing a 133 GB tree is
 * slow enough to be visible, so the interface must paint the first project the moment it
 * arrives and keep repainting as more do — never wait for the stream's `done`. The stream
 * used below is therefore deliberately slow: it yields one project immediately and then
 * stalls for three seconds before finishing. Every assertion about the first frame runs
 * inside a budget far shorter than that stall, so an implementation that collected the
 * whole scan before its first render would fail rather than merely feel slow.
 */

import { EventEmitter } from 'node:events';

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, runApp, type ExitSummary } from '../src/ui/App.js';
import { CURSOR, MARK_OFF, MARK_ON } from '../src/ui/format.js';
import type { ScanEvent } from '../src/scan.js';
import type {
  Artifact,
  CacheEntry,
  Category,
  CleanOutcome,
  CleanTarget,
  Preset,
  Project,
} from '../src/types.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const DAY = 24 * 60 * 60_000;

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

/** Terminal input, as escape sequences so no raw control byte hides in this source. */
const SPACE = ' ';
const ENTER = '\r';
const ESCAPE = '\u001B';
const ARROW_UP = '\u001B[A';
const ARROW_DOWN = '\u001B[B';

/** Mirrors `categoriesForPreset` from src/artifacts.ts, which the CLI injects for real. */
function categoriesFor(preset: Preset): Set<Category> {
  return preset === 'aggressive'
    ? new Set<Category>(['build', 'deps', 'cache'])
    : new Set<Category>(['build', 'cache']);
}

function artifact(relPath: string, category: Category, bytes: number): Artifact {
  return { path: `/dev/${relPath}`, relPath, category, bytes };
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
    git: {
      branch: 'main',
      lastCommitMs: NOW - 240 * DAY,
      hasUncommittedChanges: false,
      isWorktree: false,
    },
    activity: {
      status,
      idleMs: status === 'dormant' ? 240 * DAY : 2 * DAY,
      reason: status === 'dormant' ? 'committed 8mo ago' : 'committed 2d ago',
    },
  };
}

function makeCache(id: string, bytes: number): CacheEntry {
  return { id, label: id, path: `/caches/${id}`, bytes, note: 're-downloaded on next build' };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Gate {
  promise: Promise<void>;
  open(): void;
}

const gates: Gate[] = [];

function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  const created: Gate = { promise, open };
  gates.push(created);
  return created;
}

/**
 * One project out immediately, then a three-second stall before `done`. `held` lets the
 * test release the stall so the run does not actually pay the three seconds.
 */
async function* slowStream(events: readonly ScanEvent[], held: Gate): AsyncGenerator<ScanEvent> {
  for (const event of events) {
    yield event;
    await Promise.race([delay(3_000), held.promise]);
  }
  yield { kind: 'done' };
}

/** Everything at once — the shape most assertions want. */
async function* fastStream(events: readonly ScanEvent[]): AsyncGenerator<ScanEvent> {
  for (const event of events) {
    yield event;
    await Promise.resolve();
  }
  yield { kind: 'done' };
}

/**
 * A stream the test drives event by event, so "this arrived *after* the user pressed
 * enter" can be expressed as an ordering rather than as a hopeful sleep. `push` resolves
 * once the app's consumer has actually pulled the event off the queue.
 */
interface Feed {
  stream: AsyncIterable<ScanEvent>;
  push(event: ScanEvent): Promise<void>;
  done(): void;
}

const feeds: Feed[] = [];

function feed(): Feed {
  const queue: { event: ScanEvent; taken: () => void }[] = [];
  let wake: (() => void) | undefined;
  let finished = false;

  const wakeUp = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  async function* generate(): AsyncGenerator<ScanEvent> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        next.taken();
        yield next.event;
        continue;
      }
      if (finished) {
        yield { kind: 'done' };
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  const created: Feed = {
    stream: generate(),
    push(event: ScanEvent): Promise<void> {
      return new Promise<void>((resolve) => {
        queue.push({ event, taken: resolve });
        wakeUp();
      });
    },
    done(): void {
      finished = true;
      wakeUp();
    },
  };
  feeds.push(created);
  return created;
}

const projectEvent = (project: Project): ScanEvent => ({ kind: 'project', project });
const cacheEvent = (cache: CacheEntry): ScanEvent => ({ kind: 'cache', cache });

/** Where each target points, for asserting on the work list without matching on shape. */
function targetPaths(targets: readonly CleanTarget[]): string[] {
  return targets
    .map((target) => (target.kind === 'project' ? target.artifact.path : target.cache.path))
    .sort();
}

type Instance = ReturnType<typeof render>;

interface Harness {
  instance: Instance;
  frame(): string;
  line(match: string): string;
  lineIndex(match: string): number;
  cleaned: CleanTarget[][];
  exits: ExitSummary[];
  press(data: string): Promise<void>;
  waitForText(text: string, timeout?: number): Promise<void>;
}

const rendered: Instance[] = [];

function mount(
  stream: AsyncIterable<ScanEvent>,
  overrides: {
    preset?: Preset;
    /** Called after every attempt is recorded; throw to make that attempt fail. */
    onAttempt?: (attempt: number) => void;
    /**
     * Held: `onClean` records the call and then blocks on this gate. The window between
     * those two moments is a deletion that has started and not finished — the only state
     * in which the app is holding the user's data and cannot be torn down.
     */
    holdClean?: Gate;
    /** Per-target verdict, so a run can mix `trashed` with `refused` and `failed`. */
    outcomeFor?: (target: CleanTarget) => CleanOutcome['outcome'];
  } = {},
): Harness {
  const cleaned: CleanTarget[][] = [];
  const exits: ExitSummary[] = [];

  const onClean = async (targets: readonly CleanTarget[]): Promise<CleanOutcome[]> => {
    cleaned.push([...targets]);
    overrides.onAttempt?.(cleaned.length);
    if (overrides.holdClean !== undefined) await overrides.holdClean.promise;
    return targets.map((target) => ({
      target,
      label: target.kind === 'project' ? target.artifact.relPath : target.cache.label,
      bytes: target.kind === 'project' ? target.artifact.bytes : target.cache.bytes,
      outcome: overrides.outcomeFor?.(target) ?? ('trashed' as const),
    }));
  };

  const instance = render(
    <App
      stream={stream}
      categoriesFor={categoriesFor}
      onClean={onClean}
      onExit={(summary) => exits.push(summary)}
      nowMs={NOW}
      {...(overrides.preset === undefined ? {} : { preset: overrides.preset })}
    />,
  );
  rendered.push(instance);

  const frame = (): string => instance.lastFrame() ?? '';

  /**
   * The list row for `match`. Both panes share every physical line of the frame, so a name
   * can appear twice — once in the list, once in the detail pane. The row is the one
   * carrying a selection marker.
   */
  const rowLine = (match: string): string => {
    const candidates = frame()
      .split('\n')
      .filter((candidate) => candidate.includes(match));
    const row = candidates.find(
      (candidate) => candidate.includes(MARK_ON) || candidate.includes(MARK_OFF),
    );
    return row ?? candidates[0] ?? '';
  };

  return {
    instance,
    frame,
    line: rowLine,
    /** Which physical line the list row sits on — i.e. its position in the list. */
    lineIndex(match: string): number {
      return frame().split('\n').indexOf(rowLine(match));
    },
    cleaned,
    exits,
    async press(data: string): Promise<void> {
      instance.stdin.write(data);
      // Let Ink's reconciler flush the state update into a new frame.
      await delay(20);
    },
    async waitForText(text: string, timeout = 1_000): Promise<void> {
      await vi.waitFor(() => expect(frame()).toContain(text), { timeout, interval: 10 });
    },
  };
}

afterEach(() => {
  for (const held of gates.splice(0)) held.open();
  for (const source of feeds.splice(0)) source.done();
  for (const instance of rendered.splice(0)) instance.unmount();
});

describe('progressive rendering', () => {
  it('paints the first project long before the scan finishes', async () => {
    const held = gate();
    const ui = mount(
      slowStream([projectEvent(makeProject('tinysync', 'dormant', [artifact('target', 'build', 67 * GB)]))], held),
    );

    // The stream will not reach `done` for three seconds; one second is the budget.
    await ui.waitForText('tinysync', 1_000);
    expect(ui.frame()).toContain('67.0G');
    expect(ui.frame()).toContain('scanning');
  });

  it('stops announcing the scan once done arrives', async () => {
    const held = gate();
    const ui = mount(
      slowStream([projectEvent(makeProject('bump', 'dormant', [artifact('dist', 'build', GB)]))], held),
    );

    await ui.waitForText('bump');
    held.open();

    await vi.waitFor(() => expect(ui.frame()).not.toContain('scanning'), {
      timeout: 1_000,
      interval: 10,
    });
  });

  it('re-sorts rows as later, larger projects arrive', async () => {
    const held = gate();
    const ui = mount(
      slowStream(
        [
          projectEvent(makeProject('steady', 'dormant', [artifact('dist', 'build', 5 * GB)])),
          projectEvent(makeProject('later-bigger', 'dormant', [artifact('target', 'build', 67 * GB)])),
        ],
        held,
      ),
    );

    await ui.waitForText('steady');
    expect(ui.frame()).not.toContain('later-bigger');

    held.open();
    await ui.waitForText('later-bigger');

    expect(ui.lineIndex('later-bigger')).toBeLessThan(ui.lineIndex('steady'));
  });

  it('renders caches in their own section as they arrive', async () => {
    const ui = mount(
      fastStream([
        projectEvent(makeProject('bump', 'dormant', [artifact('dist', 'build', GB)])),
        cacheEvent(makeCache('pnpm store', 8 * GB)),
      ]),
    );

    await ui.waitForText('CACHES');
    expect(ui.frame()).toContain('pnpm store');
    expect(ui.frame()).toContain('8.0G');
  });
});

describe('selection', () => {
  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(
        makeProject('big-dormant', 'dormant', [
          artifact('target', 'build', 6 * GB),
          artifact('node_modules', 'deps', 3 * GB),
        ]),
      ),
      projectEvent(makeProject('small-dormant', 'dormant', [artifact('dist', 'build', 2 * GB)])),
      projectEvent(makeProject('busy', 'active', [artifact('dist', 'build', 4 * GB)])),
    ]);

  it('preselects dormant projects and leaves the active one protected', async () => {
    const ui = mount(stream());
    await ui.waitForText('ACTIVE (protected)');

    expect(ui.line('big-dormant')).toContain(MARK_ON);
    expect(ui.line('small-dormant')).toContain(MARK_ON);
    expect(ui.line('busy')).toContain(MARK_OFF);
    expect(ui.frame()).toContain('selected 2');
  });

  it('space toggles the row under the cursor', async () => {
    const ui = mount(stream());
    await ui.waitForText('big-dormant');
    expect(ui.line('big-dormant')).toContain(CURSOR);

    await ui.press(SPACE);
    expect(ui.line('big-dormant')).toContain(MARK_OFF);
    expect(ui.frame()).toContain('selected 1');

    await ui.press(SPACE);
    expect(ui.line('big-dormant')).toContain(MARK_ON);
    expect(ui.frame()).toContain('selected 2');
  });

  it('moves with j/k and the arrow keys, skipping headers', async () => {
    const ui = mount(stream());
    await ui.waitForText('small-dormant');

    await ui.press('j');
    expect(ui.line('small-dormant')).toContain(CURSOR);
    expect(ui.line('big-dormant')).not.toContain(CURSOR);

    await ui.press(ARROW_DOWN); // down arrow, onto the protected section
    expect(ui.line('busy')).toContain(CURSOR);

    await ui.press('k');
    expect(ui.line('small-dormant')).toContain(CURSOR);

    await ui.press(ARROW_UP); // up arrow
    expect(ui.line('big-dormant')).toContain(CURSOR);
  });

  it('lets the user select a protected project — a default, not a lock', async () => {
    const ui = mount(stream());
    await ui.waitForText('busy');

    await ui.press('j');
    await ui.press('j');
    expect(ui.line('busy')).toContain(CURSOR);

    await ui.press(SPACE);
    expect(ui.line('busy')).toContain(MARK_ON);
    expect(ui.frame()).toContain('selected 3');
  });

  it('a toggles every row in the section under the cursor', async () => {
    const ui = mount(stream());
    await ui.waitForText('big-dormant');

    await ui.press('a');
    expect(ui.frame()).toContain('selected 0');
    expect(ui.line('big-dormant')).toContain(MARK_OFF);

    await ui.press('a');
    expect(ui.frame()).toContain('selected 2');
  });

  it('p cycles the preset, which changes what is counted', async () => {
    const ui = mount(stream());
    await ui.waitForText('big-dormant');

    expect(ui.frame()).toContain('preset recommended');
    expect(ui.line('big-dormant')).toContain('6.0G');

    await ui.press('p');
    expect(ui.frame()).toContain('preset aggressive');
    expect(ui.line('big-dormant')).toContain('9.0G');
  });

  it('shows the highlighted project in the detail pane', async () => {
    const ui = mount(stream());
    await ui.waitForText('big-dormant');

    expect(ui.frame()).toContain('dormant');
    expect(ui.frame()).toContain('target');
    expect(ui.frame()).toContain('main');
    expect(ui.frame()).toContain('2025-11-27');
  });
});

/**
 * The default is applied once per row, and the "once" is the whole point.
 *
 * Rendering is progressive, so rows keep arriving for the entire length of the scan — on a
 * large tree, for minutes, while the user is already working through the list. The default
 * that preselects dormant projects has to run for each new arrival, which makes it very
 * easy to write as "re-apply the default to everything whenever the rows change". That
 * version silently re-selects the project the user just deselected, and does it again on
 * the next arrival, and the next: the user's `space` appears to work and then quietly
 * undoes itself. Nothing on screen says so, and the re-armed project is in the work list
 * handed to `clean`.
 *
 * `seen` is what makes the default a starting position rather than a standing instruction,
 * and these tests are what say it is still one.
 */
describe('the default selection is applied once per row', () => {
  it('leaves a deselected project deselected as the scan delivers more rows', async () => {
    const source = feed();
    const ui = mount(source.stream);

    await source.push(projectEvent(makeProject('dropped', 'dormant', [artifact('target', 'build', 9 * GB)])));
    await source.push(projectEvent(makeProject('kept', 'dormant', [artifact('dist', 'build', 5 * GB)])));
    await ui.waitForText('kept');

    expect(ui.line('dropped')).toContain(CURSOR);
    await ui.press(SPACE);
    expect(ui.line('dropped')).toContain(MARK_OFF);
    expect(ui.frame()).toContain('selected 1');

    // The scan is still running. One more project lands, which re-runs the default.
    await source.push(projectEvent(makeProject('newcomer', 'dormant', [artifact('out', 'build', GB)])));
    await ui.waitForText('newcomer');

    // The arrival is preselected, as it should be. The user's choice is not overwritten.
    expect(ui.line('newcomer')).toContain(MARK_ON);
    expect(ui.line('kept')).toContain(MARK_ON);
    expect(ui.line('dropped')).toContain(MARK_OFF);
    expect(ui.frame()).toContain('selected 2');

    // And the deselection reaches the thing that matters: the work list.
    await ui.press(ENTER);
    expect(ui.frame()).toContain('Move to Trash?');
    expect(ui.frame()).not.toContain('dropped');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/dev/kept/dist', '/dev/newcomer/out']);
  });

  /**
   * The same rule for the other half of the default: a cache the user cleared must not be
   * re-armed either, and neither must a *protected* project the user deliberately opted in
   * to — re-running `defaultSelection` over every row would strip that one back out.
   */
  it('survives repeated arrivals, in both directions', async () => {
    const source = feed();
    const ui = mount(source.stream);

    await source.push(projectEvent(makeProject('dropped', 'dormant', [artifact('target', 'build', 9 * GB)])));
    await source.push(projectEvent(makeProject('busy', 'active', [artifact('dist', 'build', 4 * GB)])));
    await source.push(cacheEvent(makeCache('npm cache', 2 * GB)));
    await ui.waitForText('npm cache');
    expect(ui.frame()).toContain('selected 2'); // dormant project + cache

    await ui.press(SPACE); // clear `dropped`
    await ui.press('j'); // onto `busy`, protected and unselected
    await ui.press(SPACE); // opt it in
    await ui.press('j'); // onto the cache
    await ui.press(SPACE); // clear it
    expect(ui.frame()).toContain('selected 1');

    // Three more arrivals, each one another chance to overwrite the three choices above.
    for (const size of [1, 2, 3]) {
      await source.push(
        projectEvent(makeProject(`extra${size}`, 'dormant', [artifact('out', 'build', size * GB)])),
      );
      await ui.waitForText(`extra${size}`);
    }

    expect(ui.line('dropped')).toContain(MARK_OFF);
    expect(ui.line('busy')).toContain(MARK_ON);
    // The cleared cache is asserted through the count and the work list below rather than
    // its glyph: the detail pane prints `/caches/npm cache`, which shares a physical line
    // with an unrelated list row, so the glyph on that line belongs to someone else.
    expect(ui.frame()).toContain('selected 4'); // busy + the three arrivals

    await ui.press(ENTER);
    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual([
      '/dev/busy/dist',
      '/dev/extra1/out',
      '/dev/extra2/out',
      '/dev/extra3/out',
    ]);
  });
});

describe('confirmation and exit', () => {
  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(
        makeProject('bump', 'dormant', [
          artifact('dist', 'build', 3 * GB),
          artifact('node_modules', 'deps', 9 * GB),
        ]),
      ),
      cacheEvent(makeCache('npm cache', 2 * GB)),
    ]);

  /**
   * Ready means *both* events have landed, and waiting for `bump` does not mean that.
   *
   * The project paints one event before the cache, so a test that pressed enter on the
   * first frame would freeze a snapshot holding only `dist` and then assert on a 5 G total
   * that includes the cache. That is a real race and it does fire: it is the difference
   * between a 20 ms scheduling slice and a 30 ms one. The cache is the last event in the
   * stream, so its row appearing is the honest "everything is on screen" signal.
   */
  const ready = (ui: Harness): Promise<void> => ui.waitForText('npm cache');

  it('q quits without cleaning anything', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press('q');

    expect(ui.cleaned).toEqual([]);
    expect(ui.exits).toEqual([{ cleaned: false, outcomes: [], trashedBytes: 0 }]);
  });

  it('enter asks for a second confirmation before anything is trashed', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press(ENTER);

    expect(ui.frame()).toContain('Move to Trash?');
    expect(ui.frame()).toContain('bump');
    expect(ui.frame()).toContain('npm cache');
    expect(ui.cleaned).toEqual([]);
  });

  it('escape returns from the confirmation without cleaning', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press(ENTER);
    await ui.press(ESCAPE);

    expect(ui.frame()).not.toContain('Move to Trash?');
    expect(ui.frame()).toContain('space toggle');
    expect(ui.cleaned).toEqual([]);
  });

  it('the second enter cleans, passing the discriminated union through', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press(ENTER);
    await ui.press(ENTER);

    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });

    const targets = ui.cleaned[0] ?? [];
    // Under `recommended`, `node_modules` (deps) is not in play.
    expect(targets).toHaveLength(2);

    const project = targets.find((target) => target.kind === 'project');
    expect(project).toBeDefined();
    if (project?.kind !== 'project') throw new Error('expected a project target');
    expect(Object.keys(project).sort()).toEqual(['artifact', 'kind', 'project']);
    expect(project.project.name).toBe('bump');
    expect(project.artifact.relPath).toBe('dist');
    expect(project).not.toHaveProperty('path');

    const cache = targets.find((target) => target.kind === 'cache');
    if (cache?.kind !== 'cache') throw new Error('expected a cache target');
    expect(cache.cache.id).toBe('npm cache');

    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(ui.exits[0]?.cleaned).toBe(true);
    expect(ui.exits[0]?.trashedBytes).toBe(5 * GB);
    expect(ui.exits[0]?.outcomes).toHaveLength(2);
  });

  /**
   * The last gate between the user and the deletion, stated as an equivalence rather than
   * an example: `enter` spends consent and *nothing else does*.
   *
   * The failure this pins is not exotic. A handler written as `if (escape) cancel(); else
   * clean();` reads like the same thing and is not: it makes every key on the keyboard a
   * confirmation. The keys below are the ones actually under a user's fingers a moment
   * earlier — `j`, `k` and the arrows from navigating, `space` from toggling, `a` and `p`
   * from the hints still printed at the bottom of the screen. Any of them landing on the
   * confirmation would move the whole selection to the Trash without an answer having been
   * given. So each key is followed by the same two assertions: nothing was cleaned, and the
   * question is still the thing on screen.
   */
  it('starts the clean on enter and on no other key', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press(ENTER);
    expect(ui.frame()).toContain('Move to Trash?');

    for (const key of ['j', SPACE, 'k', 'a', 'p', ARROW_DOWN, ARROW_UP, 'x']) {
      await ui.press(key);
      expect(ui.cleaned).toEqual([]);
      expect(ui.exits).toEqual([]);
      // Still asking. `Moving … to the Trash…` is the cleaning phase; it must not appear.
      expect(ui.frame()).toContain('Move to Trash?');
      expect(ui.frame()).not.toContain('to the Trash…');
    }

    // A clean started by a stray key would have called `onClean` by now even if the frame
    // had not yet repainted, so give it a moment before declaring nothing happened.
    await delay(50);
    expect(ui.cleaned).toEqual([]);
    expect(ui.exits).toEqual([]);

    // And the key that does mean yes, still means yes.
    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/caches/npm cache', '/dev/bump/dist']);
  });

  /**
   * A confirmation dialog is exactly where a user double-taps or holds the key. Both
   * keystrokes land in the same tick, before React has committed the `cleaning` phase, so
   * both reach the previous render's handler closure while it still reads `confirm`.
   * Nothing but a synchronously-latched guard can stop the second one: a state flag is set
   * asynchronously, which is the race itself. Trashing twice is mostly idempotent, but the
   * reported summary would describe the second run and a non-idempotent backend would
   * double-delete.
   */
  it('cleans exactly once when two enters land in the same tick', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press(ENTER);
    expect(ui.frame()).toContain('Move to Trash?');

    // Deliberately not `press`: no await between them, so React cannot re-render in
    // between and both handlers see phase.kind === 'confirm'.
    ui.instance.stdin.write(ENTER);
    ui.instance.stdin.write(ENTER);

    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: 1_000, interval: 10 });
    await delay(100);

    expect(ui.cleaned).toHaveLength(1);
    expect(ui.exits).toHaveLength(1);
    expect(ui.exits[0]?.trashedBytes).toBe(5 * GB);
  });

  /**
   * The latch spends the *run*, not the app. A clean that throws reports nothing and exits
   * nothing, so the user is back at the list with a decision still to make; a latch that
   * stayed set would leave every subsequent enter silently inert.
   */
  it('lets the user retry after a failed clean', async () => {
    const ui = mount(stream(), {
      onAttempt: (attempt) => {
        if (attempt === 1) throw new Error('trash unavailable');
      },
    });
    await ready(ui);

    await ui.press(ENTER);
    await ui.press(ENTER);
    await ui.waitForText('clean failed: trash unavailable');
    expect(ui.cleaned).toHaveLength(1);
    expect(ui.exits).toEqual([]);

    await ui.press(ENTER);
    expect(ui.frame()).toContain('Move to Trash?');
    await ui.press(ENTER);

    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(ui.cleaned).toHaveLength(2);
    expect(ui.exits[0]?.cleaned).toBe(true);
    expect(ui.exits[0]?.trashedBytes).toBe(5 * GB);
  });

  /**
   * While the deletion is running the keyboard is dead, and `q` is the key that proves it.
   *
   * `q` normally reports `{cleaned: false, trashedBytes: 0}` and tears the app down. Let it
   * through mid-clean and it does exactly that *while `onClean` is still moving directories
   * to the Trash*: the CLI receives "nothing was cleaned", skips the invariant-8 disclosure
   * entirely, and the user is never told what is now sitting in their Trash or that the
   * space is still spent. The bytes are gone and the only record of them is not printed.
   *
   * So the assertion is not "the app ignores the key" but the consequence: no summary is
   * reported while the clean is in flight, and the one that eventually arrives is the true
   * one.
   */
  it('reports nothing while the clean is in flight, whatever the user presses', async () => {
    const held = gate();
    const ui = mount(stream(), { holdClean: held });
    await ready(ui);

    await ui.press(ENTER);
    await ui.press(ENTER);

    // In flight: `onClean` has been called and is blocked on the gate.
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(ui.frame()).toContain('to the Trash…');
    expect(ui.exits).toEqual([]);

    await ui.press('q');
    await delay(50);

    // The quit summary — `cleaned: false, trashedBytes: 0` — is the lie invariant 8 would
    // be told. It must not have been reported.
    expect(ui.exits).toEqual([]);

    // Keys that would have moved, toggled or re-confirmed are equally inert.
    await ui.press(SPACE);
    await ui.press('j');
    await ui.press(ESCAPE);
    await ui.press(ENTER);
    await delay(50);
    expect(ui.exits).toEqual([]);
    expect(ui.cleaned).toHaveLength(1);

    held.open();

    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(ui.exits[0]?.cleaned).toBe(true);
    expect(ui.exits[0]?.trashedBytes).toBe(5 * GB);
  });

  /**
   * Invariant 8's number has to be the number the Trash actually holds.
   *
   * `clean` reports a verdict per target, and `refused` and `failed` mean the directory was
   * left exactly where it was. Summing bytes across every outcome would tell a user who
   * trashed 2 G and had an 8 G store prune refused that 10 G is waiting in the Trash — so
   * they empty it, expect 10 G back, and get 2 G. The disclosure has to count what was
   * moved, not what was attempted.
   */
  it('counts only trashed bytes in the summary, never refused or failed ones', async () => {
    const ui = mount(
      fastStream([
        projectEvent(
          makeProject('bump', 'dormant', [
            artifact('dist', 'build', 2 * GB),
            artifact('build', 'build', 3 * GB),
          ]),
        ),
        cacheEvent(makeCache('pnpm store', 8 * GB)),
      ]),
      {
        outcomeFor: (target) => {
          if (target.kind === 'cache') return 'refused'; // e.g. store-prune-unsafe
          return target.artifact.relPath === 'build' ? 'failed' : 'trashed';
        },
      },
    );

    await ui.waitForText('pnpm store');
    await ui.press(ENTER);
    expect(ui.frame()).toContain('13.0G across 3 directories');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: 1_000, interval: 10 });

    const summary = ui.exits[0];
    expect(summary?.cleaned).toBe(true);
    // All three verdicts are reported…
    expect(summary?.outcomes).toHaveLength(3);
    expect(summary?.outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
      'failed',
      'refused',
      'trashed',
    ]);
    // …but only the one that moved is in the Trash.
    expect(summary?.trashedBytes).toBe(2 * GB);
    expect(summary?.trashedBytes).not.toBe(13 * GB);
  });

  it('refuses to open the confirmation with an empty selection', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press('a'); // clear the project section
    await ui.press('j');
    await ui.press('a'); // clear the caches section
    expect(ui.frame()).toContain('selected 0');

    await ui.press(ENTER);
    expect(ui.frame()).not.toContain('Move to Trash?');
    expect(ui.frame()).toContain('Nothing selected');
    expect(ui.cleaned).toEqual([]);
  });
});

/**
 * Consent is given to a *screen*, not to a variable. The scan is still running while the
 * confirmation is up, and rows that arrive during it are auto-selected by the same default
 * that preselects dormant projects. If the confirmation reads live selection, the user
 * approves one list and `clean` receives a longer one — the work list grows between the
 * question and the answer, which is the one place in this tool where that is not allowed.
 */
describe('the confirmation is a snapshot', () => {
  const shown = (): Project =>
    makeProject('shown', 'dormant', [artifact('dist', 'build', 3 * GB)]);
  const latecomer = (): Project =>
    makeProject('latecomer', 'dormant', [artifact('target', 'build', 40 * GB)]);

  it('trashes only what was on screen when the user confirmed', async () => {
    const source = feed();
    const ui = mount(source.stream);

    await source.push(projectEvent(shown()));
    await ui.waitForText('shown');
    expect(ui.frame()).toContain('selected 1');

    await ui.press(ENTER);
    expect(ui.frame()).toContain('Move to Trash?');
    expect(ui.frame()).toContain('shown');

    // Arrives from the still-running scan, after the question was already on screen.
    await source.push(projectEvent(latecomer()));
    await delay(50);

    expect(ui.frame()).toContain('Move to Trash?');
    expect(ui.frame()).not.toContain('latecomer');
    expect(ui.frame()).toContain('across 1 directory');
    expect(ui.frame()).not.toContain('43.0G');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });

    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/dev/shown/dist']);

    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(ui.exits[0]?.trashedBytes).toBe(3 * GB);
  });

  it('holds the frozen total even when a cache lands mid-question', async () => {
    const source = feed();
    const ui = mount(source.stream);

    await source.push(projectEvent(shown()));
    await ui.waitForText('shown');
    await ui.press(ENTER);

    await source.push(cacheEvent(makeCache('gradle', 7 * GB)));
    await delay(50);

    expect(ui.frame()).not.toContain('gradle');
    expect(ui.frame()).toContain('3.0G across 1 directory');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/dev/shown/dist']);
  });

  it('discloses the arrivals rather than swallowing them', async () => {
    const source = feed();
    const ui = mount(source.stream);

    await source.push(projectEvent(shown()));
    await ui.waitForText('shown');
    await ui.press(ENTER);
    expect(ui.frame()).not.toContain('found while confirming');

    await source.push(projectEvent(latecomer()));
    await source.push(cacheEvent(makeCache('gradle', 7 * GB)));
    await delay(50);

    expect(ui.frame()).toContain('2 more found while confirming');
  });

  /**
   * The freeze is scoped to the run, not to the row: escaping back to the list must show
   * everything the scan has found, latecomers included, and a second confirmation must
   * offer them.
   */
  it('keeps latecomers in the background list and offers them on the next pass', async () => {
    const source = feed();
    const ui = mount(source.stream);

    await source.push(projectEvent(shown()));
    await ui.waitForText('shown');
    await ui.press(ENTER);

    await source.push(projectEvent(latecomer()));
    await delay(50);
    await ui.press(ESCAPE);

    expect(ui.frame()).toContain('latecomer');
    expect(ui.frame()).toContain('selected 2');

    await ui.press(ENTER);
    expect(ui.frame()).toContain('Move to Trash?');
    expect(ui.frame()).toContain('latecomer');
    expect(ui.frame()).toContain('across 2 directories');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: 1_000, interval: 10 });
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual([
      '/dev/latecomer/target',
      '/dev/shown/dist',
    ]);
  });
});

/**
 * `runApp` is the seam `cli.ts` uses, since a `.ts` entry point cannot write JSX. It is
 * small, but it owns one thing that is easy to get wrong: the summary has to be captured
 * from `onExit` *before* `waitUntilExit` resolves, or the CLI reports nothing.
 */
describe('runApp', () => {
  class FakeStdout extends EventEmitter {
    columns = 100;
    rows = 24;
    isTTY = true;
    written: string[] = [];
    write = (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    };
  }

  class FakeStdin extends EventEmitter {
    isTTY = true;
    private buffered: string | null = null;
    write = (data: string): void => {
      this.buffered = data;
      this.emit('readable');
    };
    read = (): string | null => {
      const data = this.buffered;
      this.buffered = null;
      return data;
    };
    setEncoding(): void {}
    setRawMode(): void {}
    resume(): void {}
    pause(): void {}
    ref(): void {}
    unref(): void {}
  }

  it('resolves with the summary once the user quits', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();

    const promise = runApp({
      stream: fastStream([
        projectEvent(makeProject('bump', 'dormant', [artifact('dist', 'build', 3 * GB)])),
      ]),
      categoriesFor,
      onClean: async () => [],
      nowMs: NOW,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    await vi.waitFor(() => expect(stdout.written.join('')).toContain('bump'), {
      timeout: 1_000,
      interval: 10,
    });

    stdin.write('q');
    await expect(promise).resolves.toEqual({ cleaned: false, outcomes: [], trashedBytes: 0 });
  });
});
