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
 *
 * The second property, and the one the last describe block is entirely about: **the question
 * is screened before it is asked**. The list shows what is selected; `clean.ts` decides what
 * is deletable, and a confirmation built from the first while the run obeys the second
 * promises space it then refuses. `onScreen` is the seam the CLI binds to `screenTargets`,
 * and the tests drive it with a plan (`ScreenPlan`) that can refuse per target, per tier, and
 * can hold the expensive tier open — so "what does the interface do while a 67 GB directory
 * is being scanned" is an ordering the tests state rather than a timing they hope for.
 */

import { EventEmitter } from 'node:events';

import React from 'react';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, frameBudget, runApp, type ExitSummary } from '../src/ui/App.js';
import { LOGO_TEXT, WORDMARK, bigText } from '../src/ui/Banner.js';
import { KEY_HINTS } from '../src/ui/Footer.js';
import { ScanStatus, SPINNER_FRAMES } from '../src/ui/ScanStatus.js';
import { CURSOR, MARK_OFF, MARK_ON, formatBytes } from '../src/ui/format.js';
import { LABEL_HELP } from '../src/ui/labels.js';
import type { ScanEvent } from '../src/scan.js';
import type { Screening, ScreeningTier } from '../src/clean.js';
import type { DiskUsage } from '../src/ui/diskbar.js';
import type { EmptyTrashResult, TrashSummary } from '../src/trash.js';
import type {
  Artifact,
  CacheEntry,
  Category,
  CleanOutcome,
  CleanTarget,
  GitInfo,
  Preset,
  Project,
  Refusal,
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

/**
 * How long to wait for a frame.
 *
 * One second is generous on a developer's machine and marginal on a shared CI runner, where
 * the first Ink commit competes with three other Node processes in the matrix. Every one of
 * these waits is for a render that either happens or does not — a longer ceiling costs
 * nothing when the render arrives promptly, and it is the difference between a green suite
 * and a flake that only ever reproduces on someone else's hardware.
 */
const RENDER_TIMEOUT = process.env['CI'] === undefined ? 1_000 : 15_000;

/**
 * A note on `selected N` assertions, because there were 22 of them and they were the single
 * biggest source of CI-only failure in this file.
 *
 * A row is PAINTED one commit before the effect that preselects it runs. So an assertion
 * made straight after `waitForText('some-project')` sees the row and not its selection, and
 * fails describing a guard that is working perfectly. Locally the two commits land inside the
 * same tick often enough that it never shows; on a shared runner it shows on one job out of
 * four, differently each run.
 *
 * They are therefore all `vi.waitFor`, waiting on the count the footer reports — the same
 * signal a person uses to decide the interface is ready.
 */

/**
 * Ceiling for `press` to observe its own effect. Not a delay — it returns as soon as the
 * frame changes — so a key that repaints costs a few milliseconds and only a genuine no-op
 * pays the full amount.
 *
 * The same on CI as locally, deliberately. A 3s ceiling was tried and took the suite from
 * 15s to 243s: no-op presses are common enough that the ceiling, not the commit, dominated.
 * 400ms is twenty times the flat 20ms delay this replaced, which is the margin that was
 * missing, without paying for it on every key that legitimately changes nothing.
 */

/**
 * Wait for the frame on screen and the handler that will act on it to be the same generation.
 *
 * A frame is painted at commit; `useInput` re-subscribes in a *passive* effect, which React
 * runs after. So there is a window — one macrotask wide — in which `lastFrame()` already shows
 * a row and its selection, while a keystroke written to stdin is still dispatched to the
 * previous render's closure, which had neither. A test that asserts on the frame and then
 * presses a key inside that window freezes a snapshot the screen never showed, and fails with
 * a total one row short.
 *
 * This is a property of the harness, not of the app: freezing whatever the last render knew is
 * exactly what "consent is a snapshot" means. What the tests need is to press the key *after*
 * the app has finished absorbing the scan, and this is how they wait for that.
 */
const settle = (): Promise<void> => delay(30);

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

/**
 * A stand-in for the CLI's bound `screenTargets`.
 *
 * `block` is asked per target *and per tier*, which is what makes the difference between
 * the two tiers expressible: a repository nested inside a candidate is invisible to
 * `'cheap'` (it walks no subtree) and found by `'full'`, so a plan that returns a refusal
 * only for `'full'` is the real shape of that case. `holdFull` stalls the expensive tier the
 * way a 67 GB `target/` does.
 */
interface ScreenPlan {
  block?: (target: CleanTarget, tier: ScreeningTier) => Refusal | undefined;
  holdFull?: Gate;
  fail?: string;
}

/** One call the app made to the screen, as tier plus the exact set it asked about. */
interface ScreenCall {
  tier: ScreeningTier;
  paths: string[];
}

type Instance = ReturnType<typeof render>;

interface Harness {
  instance: Instance;
  frame(): string;
  line(match: string): string;
  lineIndex(match: string): number;
  cleaned: CleanTarget[][];
  screened: ScreenCall[];
  exits: ExitSummary[];
  /** One entry per `emptyTrash` call. Length is the assertion that matters. */
  emptied: number[];
  lines(): string[];
  press(data: string): Promise<void>;
  waitForText(text: string, timeout?: number): Promise<void>;
}

const rendered: Instance[] = [];

/**
 * A terminal of a chosen size, for the assertions `ink-testing-library` cannot make.
 *
 * That harness hard-codes its stdout at 100 columns and reports no `rows` at all, so the
 * `width` prop tells the *component* how wide it is while Yoga still lays out against 100.
 * Anything about a line being too long for its terminal — which is the other half of "the frame
 * fits", since a wrapped line is a physical row Ink never counted — has to render through a
 * stdout that actually claims the width. `debug: true` makes Ink write whole frames with no
 * cursor escapes in them, exactly as `ink-testing-library` does.
 */
class FixedStdout extends EventEmitter {
  columns: number;
  rows: number;
  isTTY = true;
  frames: string[] = [];
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
  lastFrame = (): string => (this.frames.at(-1) ?? '').replace(/\n$/, '');
}

class FixedStdin extends EventEmitter {
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

const inkRendered: { unmount: () => void }[] = [];

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
    /** Absent means no `onScreen` prop at all — the unscreened app. */
    screen?: ScreenPlan;
    /** Terminal geometry. Small heights are how the scrolling tests get a short window. */
    width?: number;
    height?: number;
    /** Successive disk readings, one per call, so a refresh can observe a changed volume. */
    disk?: (DiskUsage | undefined)[];
    /** Successive Trash readings, likewise — before the empty, and after it. */
    trash?: TrashSummary[];
    emptyTrash?: () => Promise<EmptyTrashResult>;
  } = {},
): Harness {
  const cleaned: CleanTarget[][] = [];
  const screened: ScreenCall[] = [];
  const exits: ExitSummary[] = [];
  const emptied: number[] = [];

  const diskReadings = overrides.disk;
  let diskRead = 0;
  const readDisk =
    diskReadings === undefined
      ? undefined
      : async (): Promise<DiskUsage | undefined> => {
          const at = Math.min(diskRead, diskReadings.length - 1);
          diskRead += 1;
          return diskReadings[at];
        };

  const trashReadings = overrides.trash;
  let trashRead = 0;
  const readTrash =
    trashReadings === undefined
      ? undefined
      : async (): Promise<TrashSummary> => {
          const at = Math.min(trashRead, trashReadings.length - 1);
          trashRead += 1;
          return trashReadings[at] as TrashSummary;
        };

  const onEmptyTrash =
    trashReadings === undefined && overrides.emptyTrash === undefined
      ? undefined
      : async (): Promise<EmptyTrashResult> => {
          emptied.push(Date.now());
          return overrides.emptyTrash === undefined ? { ok: true } : overrides.emptyTrash();
        };

  const plan = overrides.screen;
  const onScreen =
    plan === undefined
      ? undefined
      : async (
          targets: readonly CleanTarget[],
          tier: ScreeningTier,
        ): Promise<readonly Screening[]> => {
          screened.push({ tier, paths: targetPaths(targets) });
          if (plan.fail !== undefined) throw new Error(plan.fail);
          if (tier === 'full' && plan.holdFull !== undefined) await plan.holdFull.promise;
          return targets.flatMap((target) => {
            const refusal = plan.block?.(target, tier);
            return refusal === undefined
              ? []
              : [{ target, refusal, detail: `${refusal}: refused by the boundary` }];
          });
        };

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
      {...(onScreen === undefined ? {} : { onScreen })}
      {...(overrides.preset === undefined ? {} : { preset: overrides.preset })}
      {...(overrides.width === undefined ? {} : { width: overrides.width })}
      {...(overrides.height === undefined ? {} : { height: overrides.height })}
      {...(readDisk === undefined ? {} : { readDisk })}
      {...(readTrash === undefined ? {} : { readTrash })}
      {...(onEmptyTrash === undefined ? {} : { onEmptyTrash })}
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
    screened,
    exits,
    emptied,
    /** Every physical line of the frame — what the terminal would actually have to fit. */
    lines(): string[] {
      return frame().split('\n');
    },
    async press(data: string): Promise<void> {
      instance.stdin.write(data);
      // A flat settle, deliberately. Waiting for the frame to CHANGE was tried and is the
      // wrong trade: keys that legitimately repaint nothing — `q`, anything ignored by a
      // phase guard — then pay the full ceiling, and the suite went from 15s to 243s.
      //
      // 20ms was too tight and produced CI-only flakes; 60ms is the margin without the cost.
      // Where a test genuinely depends on a commit having landed, it says so explicitly with
      // `waitForText` rather than trusting this number — which is the honest way to express
      // "wait until the interface actually shows X" in any case.
      await delay(60);
    },
    async waitForText(text: string, timeout = RENDER_TIMEOUT): Promise<void> {
      await vi.waitFor(() => expect(frame()).toContain(text), { timeout, interval: 10 });
    },
  };
}

afterEach(() => {
  for (const held of gates.splice(0)) held.open();
  for (const source of feeds.splice(0)) source.done();
  for (const instance of rendered.splice(0)) instance.unmount();
  for (const instance of inkRendered.splice(0)) instance.unmount();
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
      timeout: RENDER_TIMEOUT,
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
    await ui.waitForText('IN USE RECENTLY');

    expect(ui.line('big-dormant')).toContain(MARK_ON);
    expect(ui.line('small-dormant')).toContain(MARK_ON);
    expect(ui.line('busy')).toContain(MARK_OFF);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 2'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
  });

  it('space toggles the row under the cursor', async () => {
    const ui = mount(stream());
    await ui.waitForText('big-dormant');
    expect(ui.line('big-dormant')).toContain(CURSOR);

    await ui.press(SPACE);
    expect(ui.line('big-dormant')).toContain(MARK_OFF);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    await ui.press(SPACE);
    expect(ui.line('big-dormant')).toContain(MARK_ON);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 2'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
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
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 3'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
  });

  it('a toggles every row in the section under the cursor', async () => {
    const ui = mount(stream());
    await ui.waitForText('big-dormant');

    await ui.press('a');
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 0'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    expect(ui.line('big-dormant')).toContain(MARK_OFF);

    await ui.press('a');
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 2'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
  });

  it('p cycles the preset, which changes what is counted', async () => {
    const ui = mount(stream());
    await ui.waitForText('big-dormant');

    expect(ui.frame()).toContain('preset recommended');
    expect(ui.line('big-dormant')).toContain('6.0G');

    await ui.press('p');
    await ui.waitForText('preset aggressive');
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
    // Wait for the deselection to be reflected in the footer before letting the next row
    // land. `press` returns once the key is written, not once React has committed the state,
    // so on a slow runner the arrival below could re-run the default against a selection that
    // still held 'dropped' — failing an assertion that is about the guard, not about timing.
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    // The scan is still running. One more project lands, which re-runs the default.
    await source.push(projectEvent(makeProject('newcomer', 'dormant', [artifact('out', 'build', GB)])));
    // Wait for the ROW'S OWN MARK, not the count.
    //
    // `selected 2` is true both before and after this arrival — it was 2 with dropped+kept,
    // became 1 when dropped was cleared, and returns to 2 when newcomer is preselected. So a
    // wait on the count can match a frame in which newcomer exists but has not been selected
    // yet, and the snapshot taken next holds one directory where the test expects two. That
    // is the failure that survived three earlier fixes, each of which moved it rather than
    // removing it. The row's mark is unambiguous in a way the aggregate is not.
    await vi.waitFor(() => expect(ui.line('newcomer')).toContain(MARK_ON), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    // The user's choice is not overwritten.
    expect(ui.line('newcomer')).toContain(MARK_ON);
    expect(ui.line('kept')).toContain(MARK_ON);
    expect(ui.line('dropped')).toContain(MARK_OFF);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 2'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    // And the deselection reaches the thing that matters: the work list.
    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    expect(ui.frame()).not.toContain('dropped');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
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
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 2'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    }); // dormant project + cache

    await ui.press(SPACE); // clear `dropped`
    await ui.press('j'); // onto `busy`, protected and unselected
    await ui.press(SPACE); // opt it in
    await ui.press('j'); // onto the cache
    await ui.press(SPACE); // clear it
    // Five presses in a row, each one a state commit. Asserting straight after the last is
    // asserting against whichever frame happened to be current, which is why this failed on
    // one runner and passed on three.
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    // Three more arrivals, each one another chance to overwrite the three choices above.
    for (const size of [1, 2, 3]) {
      await source.push(
        projectEvent(makeProject(`extra${size}`, 'dormant', [artifact('out', 'build', size * GB)])),
      );
      // The row, then the selection it gains one commit later.
      await ui.waitForText(`extra${size}`);
      await settle();
    }

    expect(ui.line('dropped')).toContain(MARK_OFF);
    expect(ui.line('busy')).toContain(MARK_ON);
    // The cleared cache is asserted through the count and the work list below rather than
    // its glyph: the detail pane prints `/caches/npm cache`, which shares a physical line
    // with an unrelated list row, so the glyph on that line belongs to someone else.
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 4'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    }); // busy + the three arrivals

    await ui.press(ENTER);
    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
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
   * Ready means the app has absorbed the *whole* scan — every row painted **and** every
   * default applied — and neither half is implied by the other.
   *
   * A row is painted one commit before the effect that preselects it runs, so a test that
   * pressed enter the instant `npm cache` appeared could freeze a snapshot that had the row
   * but not the selection, and then assert a 5 G total against a 3 G work list. That is a
   * real race and it does fire; it is the difference between one scheduling slice and the
   * next.
   *
   * So the wait is on the two signals the *user* is given for the same question: the settled
   * scan indicator, which is what tells a person it is safe to press enter, and the selection
   * count in the footer. Waiting on what the interface promises is also a test of the promise.
   */
  const ready = async (ui: Harness): Promise<void> => {
    await ui.waitForText('scan complete');
    await ui.waitForText('selected 2');
    await settle();
  };

  it('q quits without cleaning anything', async () => {
    const ui = mount(stream());
    await ready(ui);

    await ui.press('q');

    expect(ui.cleaned).toEqual([]);
    expect(ui.exits).toEqual([
      { cleaned: false, outcomes: [], trashedBytes: 0, rounds: 0, trashEmptied: false },
    ]);
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

    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });

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

    // The round reports itself *inside* the frame, and the app is still running.
    await ui.waitForText('Moved 5.0G to the Trash.');
    expect(ui.exits).toEqual([]);

    // Only `q` ends the session, and the figure it carries is the one the round trashed.
    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(ui.exits[0]?.cleaned).toBe(true);
    expect(ui.exits[0]?.trashedBytes).toBe(5 * GB);
    expect(ui.exits[0]?.outcomes).toHaveLength(2);
    expect(ui.exits[0]?.rounds).toBe(1);
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
    await ui.waitForText('Move to Trash?');

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
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
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
    await ui.waitForText('Move to Trash?');

    // Deliberately not `press`: no await between them, so React cannot re-render in
    // between and both handlers see phase.kind === 'confirm'.
    ui.instance.stdin.write(ENTER);
    ui.instance.stdin.write(ENTER);

    await ui.waitForText('Moved 5.0G to the Trash.');
    await delay(100);

    // One call to `onClean`, and one round in the session — not two of either.
    expect(ui.cleaned).toHaveLength(1);

    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(ui.exits[0]?.trashedBytes).toBe(5 * GB);
    expect(ui.exits[0]?.rounds).toBe(1);
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
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);

    await ui.waitForText('Moved 5.0G to the Trash.');
    expect(ui.cleaned).toHaveLength(2);

    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
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
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
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

    // The clean finishes and the round reports itself; the mid-flight `q` is simply gone,
    // rather than having been queued up to tear the app down after the fact.
    await ui.waitForText('Moved 5.0G to the Trash.');
    expect(ui.exits).toEqual([]);

    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
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

    // Wait for the SELECTION, not merely for the row to be painted. A row appears one
    // commit before the effect that preselects it runs, so waiting on the text can freeze a
    // snapshot that has the row but not the selection — the frame then reads "1 more found
    // while confirming" and the totals are short by that row. The file's `ready` helper
    // exists for this; this test predated it.
    await ui.waitForText('scan complete');
    await ui.waitForText('13.0G');
    await settle();
    await ui.press(ENTER);
    await ui.waitForText('13.0G across 3 directories');

    await ui.press(ENTER);
    // The in-frame round summary is held to the same rule as the exit summary.
    await ui.waitForText('Moved 2.0G to the Trash.');
    expect(ui.frame()).not.toContain('13.0G to the Trash');

    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });

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
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 0'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

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
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    expect(ui.frame()).toContain('shown');

    // Arrives from the still-running scan, after the question was already on screen.
    await source.push(projectEvent(latecomer()));
    await delay(50);

    expect(ui.frame()).toContain('Move to Trash?');
    expect(ui.frame()).not.toContain('latecomer');
    expect(ui.frame()).toContain('across 1 directory');
    expect(ui.frame()).not.toContain('43.0G');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });

    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/dev/shown/dist']);

    await ui.waitForText('Moved 3.0G to the Trash.');
    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(ui.exits[0]?.trashedBytes).toBe(3 * GB);
  });

  it('holds the frozen total even when a cache lands mid-question', async () => {
    const source = feed();
    const ui = mount(source.stream);

    await source.push(projectEvent(shown()));
    await ui.waitForText('shown');
    await ui.press(ENTER);
    // Wait for the confirmation to actually be on screen. `press` returns once the key has
    // been written, not once React has committed the phase change — so on a slow runner the
    // cache below could arrive while the app was still showing the list, and be rendered
    // there perfectly correctly, failing an assertion that was really about the snapshot.
    await ui.waitForText('Move to Trash?');

    await source.push(cacheEvent(makeCache('gradle', 7 * GB)));
    await delay(50);

    expect(ui.frame()).not.toContain('gradle');
    expect(ui.frame()).toContain('3.0G across 1 directory');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
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
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 2'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    expect(ui.frame()).toContain('latecomer');
    expect(ui.frame()).toContain('across 2 directories');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual([
      '/dev/latecomer/target',
      '/dev/shown/dist',
    ]);
  });
});

/**
 * The question is screened before it is asked.
 *
 * The list is built from what is *selected*; `clean.ts` decides what is *deletable*. While
 * those two are computed by different code the tool promises space it then refuses — a user
 * reads "80.0G across 4 directories", answers yes, and receives 5.0G with three refusals
 * scrolling past afterwards. The second time that happens they have learned that refusals
 * are noise, which is the failure `clean.ts` names from the other side.
 *
 * Freezing the snapshot is what makes the fix possible: at that instant the set is fixed,
 * bounded and about to be consented to, so it is exactly the moment to ask the boundary's
 * own guards about it. These tests pin all three halves of that — that the screen is run
 * (both tiers, over exactly the frozen targets), that its verdicts reach the screen the user
 * answers *and* the work list `clean` receives, and that the wait for it is neither a freeze
 * nor a window in which a keystroke can do something unintended.
 */
describe('the confirmation is screened before it is asked', () => {
  /** 80.0G selected across four directories, and every one of them a different verdict. */
  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(
        makeProject('tinysync', 'dormant', [
          artifact('target', 'build', 67 * GB),
          artifact('dist', 'build', 3 * GB),
        ]),
      ),
      cacheEvent(makeCache('pnpm store', 8 * GB)),
      cacheEvent(makeCache('npm cache', 2 * GB)),
    ]);

  /** Settled scan plus the full selection: see the note on the other `ready`. */
  const ready = async (ui: Harness): Promise<void> => {
    await ui.waitForText('scan complete');
    await ui.waitForText('selected 3');
    await settle();
  };

  const ALL_SELECTED = [
    '/caches/npm cache',
    '/caches/pnpm store',
    '/dev/tinysync/dist',
    '/dev/tinysync/target',
  ];

  it('runs both tiers over exactly the frozen targets before showing the question', async () => {
    const held = gate();
    const ui = mount(stream(), { screen: { holdFull: held } });
    await ready(ui);

    await ui.press(ENTER);

    // The expensive tier is still running: the question is not up yet, and the interface
    // says what it is doing rather than sitting frozen on the list.
    expect(ui.frame()).toContain('Checking what can be trashed…');
    expect(ui.frame()).not.toContain('Move to Trash?');
    expect(ui.cleaned).toEqual([]);

    // Cheap first — it costs a few `lstat`s and can answer at once — then full, which is the
    // only tier that looks inside a candidate. Both are asked about the frozen set itself.
    expect(ui.screened.map((call) => call.tier)).toEqual(['cheap', 'full']);
    expect(ui.screened[0]?.paths).toEqual(ALL_SELECTED);
    expect(ui.screened[1]?.paths).toEqual(ALL_SELECTED);

    held.open();
    await ui.waitForText('Move to Trash?');
    expect(ui.screened.map((call) => call.tier)).toEqual(['cheap', 'full']);
  });

  /**
   * The defect itself, stated as a number: what the headline says and what the Trash
   * receives are the same 5.0G, and the 75.0G that will be refused is named on screen rather
   * than folded into the total or quietly dropped from it.
   */
  it('shows blocked rows with their reason, excludes them from the total, and from the run', async () => {
    const ui = mount(stream(), {
      screen: {
        block: (target) => {
          if (target.kind === 'cache') {
            return target.cache.id === 'pnpm store' ? 'store-prune-unsafe' : undefined;
          }
          return target.artifact.relPath === 'target' ? 'contains-repository' : undefined;
        },
      },
    });
    await ready(ui);

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');

    // The headline counts the two survivors and nothing else.
    expect(ui.frame()).toContain('5.0G across 2 directories');
    expect(ui.frame()).not.toContain('80.0G across');
    expect(ui.frame()).not.toContain('4 directories');

    // The 75.0G is stated, itemised, and given a reason — not silently missing.
    expect(ui.frame()).toContain('Blocked · 2 items · 75.0G');
    expect(ui.frame()).toContain('tinysync/target');
    expect(ui.frame()).toContain('holds a git repository');
    expect(ui.frame()).toContain('pnpm store');
    expect(ui.frame()).toContain('a node_modules still links into it');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });

    // And the promise is kept: the work list is the two directories the headline described.
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/caches/npm cache', '/dev/tinysync/dist']);

    await ui.waitForText('Moved 5.0G to the Trash.');
    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(ui.exits[0]?.trashedBytes).toBe(5 * GB);
  });

  /**
   * Both tiers earn their place. The cheap one answers immediately and its verdicts are put
   * on the waiting screen; the expensive one is the only thing that can see a repository
   * *inside* a 67 GB directory, and the question is built from its answer, not the fast one.
   */
  it('shows the cheap verdicts while the expensive tier is still looking inside', async () => {
    const held = gate();
    const ui = mount(stream(), {
      screen: {
        holdFull: held,
        block: (target, tier) => {
          // Known without walking anything: a store whose hardlink sources stay on disk.
          if (target.kind === 'cache' && target.cache.id === 'pnpm store') {
            return 'store-prune-unsafe';
          }
          // Only a walk of the candidate's contents can find this one.
          return tier === 'full' && target.kind === 'project' && target.artifact.relPath === 'target'
            ? 'contains-repository'
            : undefined;
        },
      },
    });
    await ready(ui);

    await ui.press(ENTER);
    await ui.waitForText('Checking what can be trashed…');
    expect(ui.frame()).toContain('1 blocked so far');

    held.open();
    await ui.waitForText('Move to Trash?');

    // The expensive tier's extra refusal is in the answer, so the total is the smaller one.
    expect(ui.frame()).toContain('Blocked · 2 items · 75.0G');
    expect(ui.frame()).toContain('5.0G across 2 directories');
  });

  /**
   * The wait is not a window. Every key that means something on the list — and `enter`,
   * which is the one that spends consent — must do nothing at all while the check is
   * running, or a held key repeat confirms a question that has not been rendered yet and a
   * stray `p` re-presets the selection out from under the set being screened.
   */
  it('ignores every keystroke while the check runs, and screens the set only once', async () => {
    const held = gate();
    const ui = mount(stream(), { screen: { holdFull: held } });
    await ready(ui);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 3'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    await ui.press(ENTER);

    for (const key of ['j', SPACE, 'k', 'a', 'p', ARROW_DOWN, ARROW_UP, 'x', ENTER]) {
      await ui.press(key);
      await ui.waitForText('Checking what can be trashed…');
      expect(ui.frame()).not.toContain('Move to Trash?');
      expect(ui.cleaned).toEqual([]);
      expect(ui.exits).toEqual([]);
    }

    // A stray `enter` that reached the list handler would have started a second screening
    // run; a stray `space`, `a` or `p` would have edited the selection underneath it.
    expect(ui.screened.map((call) => call.tier)).toEqual(['cheap', 'full']);

    held.open();
    await ui.waitForText('Move to Trash?');
    expect(ui.frame()).toContain('80.0G across 4 directories');

    await ui.press(ESCAPE);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 3'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    expect(ui.frame()).toContain('preset recommended');
  });

  /**
   * Leaving is always allowed — nothing has been touched yet, so `esc` and `q` tell the
   * truth here in a way they could not mid-clean. What must not happen is the abandoned
   * check coming back: a verdict that arrives after the user has left would open a
   * confirmation for a selection they are no longer looking at, which is the freeze defeating
   * itself.
   */
  it('lets esc abandon the check, and drops the verdict that arrives afterwards', async () => {
    const held = gate();
    const ui = mount(stream(), { screen: { holdFull: held } });
    await ready(ui);

    await ui.press(ENTER);
    await ui.waitForText('Checking what can be trashed…');

    await ui.press(ESCAPE);
    expect(ui.frame()).not.toContain('Checking what can be trashed…');
    expect(ui.frame()).toContain('space toggle');

    held.open();
    await delay(100);

    expect(ui.frame()).not.toContain('Move to Trash?');
    expect(ui.frame()).toContain('space toggle');
    expect(ui.cleaned).toEqual([]);
    expect(ui.exits).toEqual([]);
  });

  it('lets q quit mid-check, reporting the truth: nothing was cleaned', async () => {
    const held = gate();
    const ui = mount(stream(), { screen: { holdFull: held } });
    await ready(ui);

    await ui.press(ENTER);
    await ui.press('q');

    expect(ui.exits).toEqual([
      { cleaned: false, outcomes: [], trashedBytes: 0, rounds: 0, trashEmptied: false },
    ]);
    expect(ui.cleaned).toEqual([]);

    held.open();
    await delay(100);
    expect(ui.exits).toHaveLength(1);
    expect(ui.cleaned).toEqual([]);
  });

  /**
   * A check that cannot run is not permission to skip it. Rendering the question anyway
   * would put an unverified total in front of the user, which is the exact thing being
   * fixed — `clean` would still refuse at the boundary, but the promise would already have
   * been made.
   */
  it('returns to the list, with the error, when the check itself fails', async () => {
    const ui = mount(stream(), { screen: { fail: 'EMFILE: too many open files' } });
    await ready(ui);

    await ui.press(ENTER);
    await ui.waitForText('check failed: EMFILE: too many open files');

    expect(ui.frame()).not.toContain('Move to Trash?');
    expect(ui.frame()).not.toContain('Checking what can be trashed…');
    expect(ui.frame()).toContain('space toggle');
    expect(ui.cleaned).toEqual([]);
  });

  /**
   * When the screen refuses everything there is nothing left to consent to. The reasons are
   * still shown — the user has to be able to see why 80 G went nowhere — but `enter` is not
   * an answer to anything, and a clean of zero targets would exit the app reporting "nothing
   * was selected" to someone who selected all of it.
   */
  it('offers no confirmation when the screen refuses everything', async () => {
    const ui = mount(stream(), { screen: { block: () => 'worktree-root' } });
    await ready(ui);

    await ui.press(ENTER);
    await ui.waitForText('Nothing here can be moved to the Trash.');

    expect(ui.frame()).toContain('0B across 0 directories');
    expect(ui.frame()).toContain('Blocked · 4 items · 80.0G');
    expect(ui.frame()).toContain('a linked git worktree');
    expect(ui.frame()).not.toContain('enter confirm');

    await ui.press(ENTER);
    await delay(50);
    expect(ui.cleaned).toEqual([]);
    expect(ui.exits).toEqual([]);

    await ui.press(ESCAPE);
    await ui.waitForText('space toggle');
  });

  /**
   * The screen is of the frozen set, for the same reason the question is: a project that
   * arrives while the check is running has not been vetted, is not in the work list, and must
   * not appear in the answer. It is counted and disclosed, exactly as before.
   */
  it('screens the frozen set, not the one the scan has grown since', async () => {
    const source = feed();
    const held = gate();
    const ui = mount(source.stream, { screen: { holdFull: held } });

    await source.push(projectEvent(makeProject('shown', 'dormant', [artifact('dist', 'build', 3 * GB)])));
    await ui.waitForText('shown');

    await ui.press(ENTER);
    await source.push(
      projectEvent(makeProject('latecomer', 'dormant', [artifact('target', 'build', 40 * GB)])),
    );
    await delay(50);

    expect(ui.screened.map((call) => call.paths)).toEqual([['/dev/shown/dist'], ['/dev/shown/dist']]);

    held.open();
    await ui.waitForText('Move to Trash?');

    expect(ui.frame()).not.toContain('latecomer');
    expect(ui.frame()).toContain('3.0G across 1 directory');
    expect(ui.frame()).toContain('1 more found while confirming');

    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/dev/shown/dist']);
  });
});


/**
 * The scan says what it is doing, and — the half that was missing — says when it has stopped.
 *
 * Rendering is progressive, so a half-scanned list is pixel-identical to a finished one. The
 * old footer printed `scanning…` and then printed nothing, which makes *finished* and *the
 * word got dropped in a re-layout* the same frame. Absence is not a state an eye can read, and
 * "have I seen everything yet" is exactly the question a user must answer correctly before
 * pressing enter.
 *
 * The animation needs its own clock, because Ink re-renders on state change and a scan can
 * spend thirty seconds inside one `dirSize` without producing an event — the frozen spinner
 * would be on screen for precisely the wait it exists to explain. A clock in a CLI is a
 * liability, so the two properties that make it safe are pinned here as well as the copy.
 */
describe('the scan indicator', () => {
  it('animates while the scan runs, then settles into something unambiguous', async () => {
    const held = gate();
    const ui = mount(
      slowStream(
        [
          projectEvent(makeProject('tinysync', 'dormant', [artifact('target', 'build', 67 * GB)])),
          projectEvent(makeProject('bump', 'dormant', [artifact('dist', 'build', 3 * GB)])),
        ],
        held,
      ),
    );

    // The running count is the other half of "wait": it says how much has arrived so far.
    await ui.waitForText('1 project');
    expect(ui.frame()).toContain('scanning…');
    expect(ui.frame()).toContain('67.0G');
    expect(ui.frame()).not.toContain('scan complete');

    // A spinner that does not spin is a frozen interface. Sample it over several ticks and
    // require the glyph to actually change — the assertion a re-render-driven spinner fails.
    const seenFrames = new Set<string>();
    for (let sample = 0; sample < 12; sample += 1) {
      const line = ui.frame().split('\n')[0] ?? '';
      for (const glyph of SPINNER_FRAMES) if (line.includes(glyph)) seenFrames.add(glyph);
      await delay(40);
    }
    expect(seenFrames.size).toBeGreaterThan(1);

    held.open();

    // Settled: a word, not merely the absence of one, and the final count beside it.
    await ui.waitForText('scan complete');
    expect(ui.frame()).toContain('2 projects');
    expect(ui.frame()).toContain('70.0G');
    expect(ui.frame()).not.toContain('scanning…');
  });

  /**
   * The timer must not outlive the interface, in either sense.
   *
   * `clearInterval` on unmount is the ordinary half. `unref` is the half that bites: Node's
   * event loop stays alive while a referenced interval exists, so a CLI whose last act is
   * `exit()` would print its closing line and then simply hang, with no interface left to
   * explain why. It reads as a crash, and it is caused by an animation.
   *
   * Asserted against the real `setInterval` — wrapped, not faked — so this is a claim about
   * the handle the component actually created.
   */
  it('unrefs its interval and clears it when the scan settles', async () => {
    const handles: { unreffed: boolean; handle: NodeJS.Timeout }[] = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const cleared: unknown[] = [];

    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: () => void,
      ms: number,
    ) => {
      const handle = realSetInterval(callback, ms);
      const record = { unreffed: false, handle };
      const realUnref = handle.unref.bind(handle);
      handle.unref = () => {
        record.unreffed = true;
        return realUnref();
      };
      handles.push(record);
      return handle;
    }) as never);
    const clearSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(((handle: NodeJS.Timeout) => {
        cleared.push(handle);
        realClearInterval(handle);
      }) as never);

    try {
      const instance = render(<ScanStatus scanning projects={2} caches={0} bytes={GB} />);
      rendered.push(instance);
      await delay(30);

      expect(handles.length).toBeGreaterThan(0);
      expect(handles.every((record) => record.unreffed)).toBe(true);

      // Settling is a state change, not an unmount, and it must stop the clock all the same.
      instance.rerender(<ScanStatus scanning={false} projects={2} caches={0} bytes={GB} />);
      await delay(30);
      expect(cleared).toContain(handles[0]?.handle);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

/**
 * The list scrolls inside its pane; the terminal does not scroll at all.
 *
 * The defect being fixed: the pane used to render every row it was handed. On a list longer
 * than the window that does not scroll the list — Ink prints an over-tall frame, the emulator
 * pushes the top off the screen, and the footer goes with it. The footer is the only place the
 * keybindings are written down, so the user is left holding an interface they cannot operate
 * and cannot get back, because the next repaint is over-tall too.
 *
 * So the assertions are about the *frame*, not about the list: how many physical lines it
 * occupies, and whether the pinned chrome is among them. A test that only checked "the cursor
 * row is visible" would pass on the broken version.
 */
describe('the list scrolls inside its pane', () => {
  const TERMINAL_ROWS = 18;

  const many = (count: number): AsyncIterable<ScanEvent> =>
    fastStream(
      Array.from({ length: count }, (_, index) =>
        projectEvent(
          makeProject(`proj-${String(index).padStart(2, '0')}`, 'dormant', [
            artifact('dist', 'build', (count - index) * GB),
          ]),
        ),
      ),
    );

  const tall = (): ReturnType<typeof mount> =>
    mount(many(24), { width: 100, height: TERMINAL_ROWS });

  it('never draws a frame taller than the terminal, however long the list', async () => {
    const ui = tall();
    await ui.waitForText('scan complete');

    expect(ui.lines().length).toBeLessThanOrEqual(TERMINAL_ROWS);

    // Every row rendered would be 25 lines of list alone. Only a window is drawn.
    const rowLines = ui.lines().filter((line) => line.includes('proj-'));
    expect(rowLines.length).toBeLessThan(24);
    expect(rowLines.length).toBeGreaterThan(0);
  });

  it('keeps the header and the footer on screen while the cursor walks the whole list', async () => {
    const ui = tall();
    await ui.waitForText('scan complete');
    await settle();

    for (let step = 0; step < 23; step += 1) {
      await ui.press('j');
      // The pinned chrome, top and bottom, on every single frame.
      expect(ui.frame()).toContain('dev-cleaner');
      expect(ui.frame()).toContain('space toggle');
      expect(ui.frame()).toContain('preset recommended');
      expect(ui.lines().length).toBeLessThanOrEqual(TERMINAL_ROWS);
    }

    // …and the cursor is on a row that is actually drawn, not on one scrolled past.
    const cursorLine = ui.lines().find((line) => line.includes(CURSOR));
    expect(cursorLine).toBeDefined();
    expect(cursorLine).toContain('proj-23');
  });

  it('says how much is hidden, on each side, and nothing when nothing is', async () => {
    const ui = tall();
    await ui.waitForText('scan complete');
    await settle();

    // At the top: nothing above, plenty below.
    expect(ui.frame()).toContain('more below');
    expect(ui.frame()).not.toContain('more above');

    for (let step = 0; step < 22; step += 1) await ui.press('j');

    // At the bottom: the mirror image.
    expect(ui.frame()).toContain('more above');
    expect(ui.frame()).not.toContain('more below');

    // A list that fits says neither, or the indicator would mean nothing.
    const short = mount(many(3), { width: 100, height: TERMINAL_ROWS });
    await short.waitForText('scan complete');
    expect(short.frame()).not.toContain('more below');
    expect(short.frame()).not.toContain('more above');
  });
});

/**
 * The chips, in the running interface.
 *
 * `ui.list.test.tsx` proves the budget arithmetic against `renderRow` directly. What is left
 * to establish here is that the arithmetic is wired to a real terminal: that the chips reach
 * the rows, that the detail pane holds the ones the rows could not afford, and — the property
 * every other test in this file has been defending — that none of it costs the frame a line.
 *
 * The list pane is capped at 52 columns however wide the terminal is (`MAX_LIST_WIDTH`), so
 * the budget in the real app is about twenty columns and the row is genuinely terse. That is
 * the arrangement, not a shortfall: the row carries the one fact the pane could afford and the
 * detail pane carries the rest with a sentence each.
 */
describe('the chips reach the screen', () => {
  const dirty = (base: Project, git: Partial<GitInfo>): Project => ({
    ...base,
    git: { ...(base.git as GitInfo), ...git },
  });

  const flat = (value: string): string => value.replace(/\s+/g, ' ').trim();

  /**
   * The two panes share every physical line of the frame, so `│ …list… ││ …detail… │` is one
   * string and a naive `toContain` on a row would happily match a word from the other pane.
   * These two split it at the seam — which is also the only way to assert that a chip is
   * *absent* from a row, and the absences are the assertions that matter here.
   */
  const rowText = (line: string): string => line.split('││')[0] ?? line;
  const detailText = (frame: string): string =>
    flat(
      frame
        .split('\n')
        .map((line) => (line.split('││')[1] ?? '').replace(/│\s*$/, ''))
        .join(' '),
    );

  it('labels every row with the recency that decided its score', async () => {
    const ui = mount(
      fastStream([
        projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 9 * GB)])),
        projectEvent(makeProject('beta', 'dormant', [artifact('dist', 'build', 5 * GB)])),
      ]),
      { width: 100, height: 24 },
    );
    await ui.waitForText('scan complete');

    // The same phrase the detail pane's reason line uses, in the row, on every row.
    expect(rowText(ui.line('alpha'))).toContain('committed 8mo');
    expect(rowText(ui.line('beta'))).toContain('committed 8mo');
  });

  /**
   * One crowded row spends the column, and the quiet rows go quiet with it.
   *
   * That is the intended trade and the reason the plan is made for the pane rather than per
   * row: `committed 8mo` on `beta` beside a blank space on `gamma` would say that nobody knows
   * when `gamma` was last touched, which is false. A blank column on every row says only that
   * this pane is talking about uncommitted work today, and the detail pane still has the dates.
   */
  it('spends the column on the row that has something urgent to say', async () => {
    const held = dirty(makeProject('held', 'dormant', [artifact('dist', 'build', 9 * GB)]), {
      hasUncommittedChanges: true,
      isWorktree: true,
    });
    const ui = mount(
      fastStream([
        projectEvent(held),
        projectEvent(makeProject('quiet', 'dormant', [artifact('dist', 'build', 5 * GB)])),
      ]),
      { width: 100, height: 24 },
    );
    await ui.waitForText('scan complete');

    expect(rowText(ui.line('held'))).toContain('uncommitted');
    expect(rowText(ui.line('quiet'))).not.toContain('uncommitted');
    expect(rowText(ui.line('quiet'))).not.toContain('committed 8mo');
  });

  it('explains, in the detail pane, the chips the row could not afford', async () => {
    const held = dirty(makeProject('held', 'dormant', [artifact('dist', 'build', 9 * GB)]), {
      hasUncommittedChanges: true,
      isWorktree: true,
    });
    // A tall terminal: the pane's height cut is a separate guarantee, tested on its own below.
    const ui = mount(fastStream([projectEvent(held)]), { width: 100, height: 56 });
    await ui.waitForText('scan complete');
    await settle();

    // The row said `uncommitted` and nothing else…
    expect(rowText(ui.line('held')).trim()).toMatch(/uncommitted\s+9\.0G$/);

    // …the pane says all four, each with its sentence.
    const detail = detailText(ui.frame());
    for (const phrase of [
      'uncommitted changes',
      'committed 8mo ago',
      'linked worktree',
      'rebuilds offline',
    ]) {
      expect(detail, phrase).toContain(phrase);
    }
    expect(detail).toContain(flat(LABEL_HELP.worktree));
    expect(detail).toContain(flat(LABEL_HELP.offline));
  });

  it('costs the frame no line at any width, however many chips a row has', async () => {
    const held = dirty(makeProject('held-worktree-with-a-long-name', 'dormant', [
      artifact('target', 'build', 34 * GB),
    ]), { hasUncommittedChanges: true, isWorktree: true });

    for (const columns of [40, 56, 80, 100]) {
      const ui = mount(
        fastStream([
          projectEvent(held),
          ...Array.from({ length: 10 }, (_, index) =>
            projectEvent(
              makeProject(`p-${index}`, index % 2 === 0 ? 'dormant' : 'active', [
                artifact('dist', 'build', (11 - index) * GB),
              ]),
            ),
          ),
        ]),
        { width: columns, height: 18 },
      );
      await ui.waitForText('scan complete');
      await settle();

      expect(ui.lines().length, `at ${columns} columns`).toBeLessThanOrEqual(18);
      // The pinned chrome, top and bottom, is still on the frame.
      expect(ui.frame()).toContain('dev-cleaner');
      expect(ui.frame()).toContain('space toggle');
    }
  });
});

/**
 * A session: many rounds, one interface.
 *
 * The old flow ended at the first clean — unmount, print, exit — so a second round meant
 * re-running the program and re-scanning a tree that takes minutes. Everything in this block
 * is about the interface still being there afterwards, and being *correct* afterwards: the
 * rows that were trashed are gone, the totals reflect it, the running figure accrues, and the
 * next round is a genuinely new decision rather than a replay of the last one.
 */
describe('the session survives a clean', () => {
  const three = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 9 * GB)])),
      projectEvent(makeProject('beta', 'dormant', [artifact('dist', 'build', 5 * GB)])),
      projectEvent(makeProject('gamma', 'dormant', [artifact('dist', 'build', 2 * GB)])),
    ]);

  const ready = async (ui: Harness): Promise<void> => {
    await ui.waitForText('scan complete');
    await ui.waitForText('selected 3');
    await settle();
  };

  it('returns to the list with the cleaned rows gone and the totals updated', async () => {
    const ui = mount(three(), { screen: {} });
    await ready(ui);
    expect(ui.frame()).toContain('16.0G');

    // Clear the section, then take just `alpha`.
    await ui.press('a');
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 0'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    await ui.press(SPACE);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    await settle();

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);

    // The round reports itself in the frame. The app has not exited.
    await ui.waitForText('Moved 9.0G to the Trash.');
    expect(ui.exits).toEqual([]);

    await ui.press(ESCAPE);

    // Home again — and `alpha` is not offered a second time.
    expect(ui.frame()).toContain('space toggle');
    expect(ui.frame()).not.toContain('alpha');
    expect(ui.frame()).toContain('beta');
    expect(ui.frame()).toContain('gamma');
    // The section header total lost exactly the 9 G that moved.
    expect(ui.frame()).toContain('7.0G');
    expect(ui.frame()).not.toContain('16.0G');
    // And the running figure is on screen, in the footer, where the selection totals are.
    expect(ui.frame()).toContain('9.0G trashed this session');
  });

  it('accrues across rounds, and screens each one from a fresh snapshot', async () => {
    const ui = mount(three(), { screen: {} });
    await ready(ui);

    await ui.press('a');
    await ui.press(SPACE); // alpha, 9.0G
    await settle();
    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);
    await ui.waitForText('Moved 9.0G to the Trash.');
    await ui.press(ESCAPE);
    await settle();

    // Round one screened exactly alpha.
    expect(ui.screened.map((call) => call.paths)).toEqual([
      ['/dev/alpha/dist'],
      ['/dev/alpha/dist'],
    ]);

    // Round two: a different selection, taken now, over the list as it stands.
    await ui.press(SPACE); // beta, 5.0G — the cursor fell to the first surviving row
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    await settle();
    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    expect(ui.frame()).toContain('5.0G across 1 directory');
    await ui.press(ENTER);
    await ui.waitForText('Moved 5.0G to the Trash.');

    // The second round was screened afresh — and never over the paths the first one took.
    expect(ui.screened).toHaveLength(4);
    expect(ui.screened[2]?.paths).toEqual(['/dev/beta/dist']);
    expect(ui.screened[3]?.paths).toEqual(['/dev/beta/dist']);
    expect(ui.screened.some((call) => call.paths.includes('/dev/alpha/dist') && call !== ui.screened[0] && call !== ui.screened[1])).toBe(false);

    // Two calls to `onClean`, each with only its own round's work.
    expect(ui.cleaned).toHaveLength(2);
    expect(targetPaths(ui.cleaned[0] ?? [])).toEqual(['/dev/alpha/dist']);
    expect(targetPaths(ui.cleaned[1] ?? [])).toEqual(['/dev/beta/dist']);

    // The running total is the sum, and the round count says how it got there.
    expect(ui.frame()).toContain('14.0G trashed this session');
    expect(ui.frame()).toContain('2 rounds');

    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(ui.exits[0]?.trashedBytes).toBe(14 * GB);
    expect(ui.exits[0]?.rounds).toBe(2);
    expect(ui.exits[0]?.outcomes).toHaveLength(2);
  });

  /**
   * A row that was refused is still on the disk, so it stays in the list — and it stays
   * *unchecked*, because leaving it armed would re-promise it next round and refuse it again.
   * That loop is how a user learns to stop reading refusals.
   */
  it('keeps a refused row in the list, unchecked, at its full size', async () => {
    const ui = mount(three(), {
      screen: {},
      outcomeFor: (target) =>
        target.kind === 'project' && target.project.name === 'beta' ? 'refused' : 'trashed',
    });
    await ready(ui);

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);

    await ui.waitForText('Moved 11.0G to the Trash.');
    expect(ui.frame()).toContain('2 directories trashed · 1 refused');
    expect(ui.frame()).not.toContain('directorys');
    // Named, with its size, and outside the total.
    expect(ui.frame()).toContain('Left in place');
    expect(ui.frame()).toContain('5.0G');

    await ui.press(ESCAPE);
    expect(ui.frame()).not.toContain('alpha');
    expect(ui.line('beta')).toContain('5.0G');
    expect(ui.line('beta')).toContain(MARK_OFF);
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 0'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    expect(ui.frame()).toContain('11.0G trashed this session');
  });

  /**
   * The new pinned guard, and it belongs to the same family as "only enter starts a clean".
   *
   * `enter` is this application's commit key. A user holding it — and the confirmation dialog
   * is exactly where people hold keys — would otherwise chain *dismiss the summary → list →
   * enter → screening → confirm → enter* and run a second round they never chose. So the one
   * screen that sits between two rounds refuses the key that starts them.
   */
  it('ignores enter on the round summary, so a held key cannot chain a second round', async () => {
    const ui = mount(three(), { screen: {} });
    await ready(ui);

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);
    await ui.waitForText('Moved 16.0G to the Trash.');

    for (const key of [ENTER, ENTER, ENTER, 'j', 'a', 'p']) {
      await ui.press(key);
      // Still the summary: no key here has advanced anywhere, least of all into a new round.
      expect(ui.frame()).toContain('Moved 16.0G to the Trash.');
      expect(ui.frame()).not.toContain('Move to Trash?');
      expect(ui.cleaned).toHaveLength(1);
    }
    await delay(50);
    expect(ui.cleaned).toHaveLength(1);
    expect(ui.exits).toEqual([]);

    // The key the screen actually offers does work.
    await ui.press(ESCAPE);
    await ui.waitForText('space toggle');
  });
});

/**
 * The gauge answers "what does checking this box do to my disk", which is the question the
 * user came to the tool with and which a column of sizes cannot answer.
 *
 * It is a *projection*, not a reading — dev-cleaner trashes rather than deletes, so free space
 * does not move until the Trash is emptied — and the caveat is asserted here because a gauge
 * that quietly implied otherwise would be the most convincing lie the interface could tell.
 */
describe('the disk gauge', () => {
  const HUNDRED = 100 * GB;
  const usage = (used: number): DiskUsage => ({
    total: HUNDRED,
    used,
    free: HUNDRED - used,
  });

  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 6 * GB)])),
      projectEvent(makeProject('beta', 'dormant', [artifact('dist', 'build', 4 * GB)])),
    ]);

  it('moves with the selection, and says the space is only a projection', async () => {
    const ui = mount(stream(), { width: 100, disk: [usage(80 * GB)] });
    await ui.waitForText('scan complete');
    await ui.waitForText('selected 2');

    // 20 G free now; the 10 G selected would make it 30 G — once the Trash is emptied.
    expect(ui.frame()).toContain('80.0G used of 100G');
    expect(ui.frame()).toContain('20.0G free');
    expect(ui.frame()).toContain('→ 30.0G free once emptied');
    expect(ui.frame()).toContain('Trashed files still occupy the disk');

    // Uncheck the 6 G row: the projection follows immediately.
    await settle();
    await ui.press(SPACE);
    await ui.waitForText('→ 24.0G free once emptied');

    // Nothing selected: no "after" figure at all, and the legend instead — because an
    // unchanged projection printed beside the current free space invites the reader to
    // believe the two differ for some other reason. (`a` on a partly-checked section checks
    // it; a second press is what clears it.)
    await ui.press('a');
    await ui.press('a');
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 0'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    expect(ui.frame()).not.toContain('once emptied');
    expect(ui.frame()).toContain('this selection');
  });

  /** Three glyphs, so the bar survives a terminal with no colour at all. */
  it('draws the bar in glyphs rather than in colour alone', async () => {
    const ui = mount(stream(), { width: 100, disk: [usage(80 * GB)] });
    await ui.waitForText('selected 2');

    const bar = ui.lines().find((line) => line.includes('█')) ?? '';
    expect(bar).toContain('█'); // in use and staying
    expect(bar).toContain('▓'); // this selection
    expect(bar).toContain('░'); // already free
  });

  /** A volume that cannot be measured draws no bar, rather than a full one. */
  it('degrades to a plain line when the volume cannot be read', async () => {
    const ui = mount(stream(), { width: 100, disk: [undefined] });
    await ui.waitForText('selected 2');

    expect(ui.frame()).toContain('disk usage unavailable');
    expect(ui.frame()).not.toContain('used of');
  });

  it('is re-read after a round, so the gauge is not left describing the old list', async () => {
    const ui = mount(stream(), {
      screen: {},
      width: 100,
      disk: [usage(80 * GB), usage(70 * GB)],
    });
    await ui.waitForText('selected 2');
    expect(ui.frame()).toContain('80.0G used of 100G');
    await settle();

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);
    await ui.waitForText('Moved 10.0G to the Trash.');
    await ui.press(ESCAPE);

    await vi.waitFor(() => expect(ui.frame()).toContain('70.0G used of 100G'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
  });
});

/**
 * Emptying the Trash — the one action in this tool with no undo.
 *
 * Two things have to be true and they pull in opposite directions from the rest of the
 * interface. The figure shown must be the **whole** Trash, never this run's contribution,
 * because emptying takes the user's holiday photos along with the `node_modules` and a prompt
 * captioned with the smaller number misrepresents the offer even though every figure on screen
 * is true. And the confirmation must not be `enter`, because `enter` is the key the user has
 * been pressing for the last four screens and a yes answered by momentum is not an answer.
 */
describe('emptying the Trash', () => {
  const summary = (bytes: number, items: number): TrashSummary => ({
    bytes,
    items,
    available: true,
  });

  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 3 * GB)]))]);

  const open = async (ui: Harness): Promise<void> => {
    await ui.waitForText('selected 1');
    await settle();
    await ui.press('t');
    await ui.waitForText('Empty the Trash?');
  };

  it('discloses the whole Trash, not this run, and needs the word typed out', async () => {
    const ui = mount(stream(), { width: 100, trash: [summary(120 * GB, 348), summary(0, 0)] });
    await open(ui);

    // The number that matters: everything emptying would destroy.
    expect(ui.frame()).toContain('120G · 348 items in the Trash');
    expect(ui.frame()).toContain('not only what dev-cleaner put there');
    expect(ui.frame()).toContain('cannot be undone');

    // `enter` alone is not an answer — and neither is a plausible-looking wrong word.
    await ui.press(ENTER);
    await delay(30);
    expect(ui.emptied).toEqual([]);
    expect(ui.frame()).toContain('Empty the Trash?');

    for (const letter of ['e', 'm', 'p', 't']) await ui.press(letter);
    await ui.press(ENTER);
    await delay(30);
    expect(ui.emptied).toEqual([]);
    expect(ui.frame()).toContain('Empty the Trash?');

    // The whole word, and only then.
    await ui.press('y');
    await ui.waitForText('enter empties the Trash');
    await ui.press(ENTER);

    await ui.waitForText('Trash emptied.');
    expect(ui.emptied).toHaveLength(1);
    // Read back from the Trash afterwards rather than assumed from the attempt's verdict.
    expect(ui.frame()).toContain('0B · 0 items in the Trash now');
  });

  /**
   * The same prompt, reached from the round summary, still shows the Trash's figures and not
   * the round's. This is the arrangement `trash.ts` names as the dangerous one: "18.1G moved
   * to the Trash" on the previous screen, an offer to empty on this one.
   */
  it('shows the Trash total after a clean, never the round total', async () => {
    const ui = mount(stream(), { screen: {}, trash: [summary(120 * GB, 348), summary(0, 0)] });
    await ui.waitForText('selected 1');
    await settle();

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);
    await ui.waitForText('Moved 3.0G to the Trash.');
    expect(ui.frame()).toContain('t empty the Trash');

    await ui.press('t');
    await ui.waitForText('Empty the Trash?');

    expect(ui.frame()).toContain('120G · 348 items in the Trash');
    expect(ui.frame()).not.toContain('3.0G');
  });

  it('backs out on escape, having done nothing', async () => {
    const ui = mount(stream(), { trash: [summary(120 * GB, 348)] });
    await open(ui);

    await ui.press('e');
    await ui.press(ESCAPE);
    await ui.waitForText('space toggle');
    expect(ui.emptied).toEqual([]);

    // And the typing does not survive the trip: the word must be spelled out again.
    await ui.press('t');
    await ui.waitForText('Empty the Trash?');
    await ui.press(ENTER);
    await delay(30);
    expect(ui.emptied).toEqual([]);
  });

  /**
   * `available: false` means the total is *unknown*, not zero. `trash.ts` is explicit that an
   * understated figure under a prompt that destroys everything is worse than no figure — so
   * there is no figure, and no offer.
   */
  it('offers no empty at all when the Trash cannot be measured', async () => {
    const ui = mount(stream(), { trash: [{ bytes: 0, items: 0, available: false }] });
    await open(ui);

    expect(ui.frame()).toContain('could not read the Trash');
    expect(ui.frame()).not.toContain('0B · 0 items');
    expect(ui.frame()).not.toContain('type empty');

    // Even typed out in full, the word unlocks nothing: there is no disclosed total to
    // consent against.
    for (const letter of ['e', 'm', 'p', 't', 'y']) await ui.press(letter);
    await ui.press(ENTER);
    await delay(30);
    expect(ui.emptied).toEqual([]);
  });

  it('empties exactly once when two enters land in the same tick', async () => {
    const ui = mount(stream(), { trash: [summary(120 * GB, 348), summary(0, 0)] });
    await open(ui);
    for (const letter of ['e', 'm', 'p', 't', 'y']) await ui.press(letter);

    // No await between them: both handlers see the armed confirmation.
    ui.instance.stdin.write(ENTER);
    ui.instance.stdin.write(ENTER);

    await ui.waitForText('Trash emptied.');
    await delay(100);
    expect(ui.emptied).toHaveLength(1);
  });

  it('reports the session emptied the Trash, so the closing line can say so', async () => {
    const ui = mount(stream(), { screen: {}, trash: [summary(120 * GB, 348), summary(0, 0)] });
    await ui.waitForText('selected 1');
    await settle();

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);
    await ui.waitForText('Moved 3.0G to the Trash.');
    await ui.press('t');
    await ui.waitForText('Empty the Trash?');
    for (const letter of ['e', 'm', 'p', 't', 'y']) await ui.press(letter);
    await ui.press(ENTER);
    await ui.waitForText('Trash emptied.');

    await ui.press(ESCAPE);
    await ui.press('q');
    await vi.waitFor(() => expect(ui.exits).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });
    expect(ui.exits[0]?.trashEmptied).toBe(true);
    expect(ui.exits[0]?.trashedBytes).toBe(3 * GB);
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

    // Deliberately NOT gated on rendered text. Ink detects CI and suppresses intermediate
    // frames, writing only on unmount, so `stdout.written` holds nothing but the hide-cursor
    // escape until the app exits — a readiness gate on 'bump' passes locally and can never
    // pass on a runner. The subject here is the RESOLVED SUMMARY, not the painting: give the
    // stream a moment to drain, quit, and assert what `runApp` resolves with.
    await vi.waitFor(() => expect(stdin.listenerCount('readable')).toBeGreaterThan(0), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    await settle();

    stdin.write('q');
    await expect(promise).resolves.toEqual({
      cleaned: false,
      outcomes: [],
      trashedBytes: 0,
      rounds: 0,
      trashEmptied: false,
    });
  });
});

/**
 * Defects found by adversarial review of the finished shell. Two share a root cause with the
 * double-`enter` race already pinned above: a guard keyed on React state, read by a handler
 * closure from the render *before* the state was scheduled. `phase` is not committed within
 * the tick that set it, so any second key delivered in the same read still sees `confirm`.
 *
 * The third is layout: two panes each clamped to a minimum independently can sum to more than
 * the terminal, and Yoga then wraps every row — which un-pins the footer that the whole
 * viewport mechanism exists to pin.
 */
describe('same-tick keys during a clean, and narrow terminals', () => {
  const oneProject = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(makeProject('bump', 'dormant', [artifact('dist', 'build', 5 * GB)])),
    ]);

  const atConfirm = async (held: Gate): Promise<Harness> => {
    const ui = mount(oneProject(), { holdClean: held });
    await ui.waitForText('scan complete');
    await ui.waitForText('selected 1');
    await settle();
    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    return ui;
  };

  it('ignores a q delivered in the same tick as the confirming enter', async () => {
    const held = gate();
    const ui = await atConfirm(held);

    // No await between them: both reach the pre-clean render's handler.
    ui.instance.stdin.write(ENTER);
    ui.instance.stdin.write('q');
    await settle();

    // The clean started and is still holding the user's directories. Quitting here would
    // report `cleaned: false, trashedBytes: 0` to the CLI while `onClean` is in flight, so
    // the invariant-8 Trash disclosure would never print and the user would never be told
    // what is in their Trash.
    expect(ui.cleaned).toHaveLength(1);
    expect(ui.exits).toHaveLength(0);

    held.open();
    await ui.waitForText('Moved 5.0G to the Trash.');
  });

  it('ignores an esc delivered in the same tick as the confirming enter', async () => {
    const held = gate();
    const ui = await atConfirm(held);

    ui.instance.stdin.write(ENTER);
    ui.instance.stdin.write(ESCAPE);
    await settle();

    // `setPhase({kind:'list'})` would batch *after* runClean's `setPhase({kind:'cleaning'})`,
    // rendering the full live list — every key active, footer offering `enter clean` — while
    // directories are still being moved.
    expect(ui.cleaned).toHaveLength(1);
    expect(ui.frame()).not.toContain('enter clean');

    held.open();
    await ui.waitForText('Moved 5.0G to the Trash.');
  });

  /**
   * What can and cannot be asserted here.
   *
   * `ink-testing-library` renders into a stream of its own fixed width, so the `width` prop
   * tells the *component* how wide it is while Yoga still lays out against the harness's
   * width. Passing 120 and asserting the frame is 120 wide therefore tests the harness, not
   * the app — an earlier version of this test did exactly that and failed for that reason.
   *
   * What IS controllable is any element given an explicit width: Ink truncates inside it
   * regardless of the terminal. The header is the line that mattered — it grows with the
   * project count and the bytes found, and untruncated it wrapped and cost the list a row.
   */
  it.each([40, 56, 80])('keeps the header inside %i declared columns', async (columns) => {
    const many = Array.from({ length: 40 }, (_, i) =>
      projectEvent(
        makeProject(`project-number-${i}`, 'dormant', [artifact('dist', 'build', GB)]),
      ),
    );
    const ui = mount(fastStream(many), { width: columns, height: 24 });
    await ui.waitForText('scan complete');
    await settle();

    const header = ui.lines()[0] ?? '';
    expect(header).toContain('dev-cleaner');
    expect(header.length).toBeLessThanOrEqual(columns);
  });
});

/**
 * The chip column, asserted through the App rather than through `chipsFor`.
 *
 * `categories` was computed in App, handed to `<Detail>`, and omitted from `<List>` — so
 * `chipsOf` withheld the network/offline pair and two of the six chip kinds could never
 * appear in the pane they were built for. Every chip unit test passed, because they all
 * called `chipsFor` directly with a category set in hand.
 *
 * A component test cannot see a missing prop. Only rendering the app can.
 */
describe('connectivity chips reach the list pane', () => {
  it('shows needs-network in the frame when the preset actually cleans node_modules', async () => {
    const ui = mount(
      fastStream([
        projectEvent(
          makeProject('app', 'dormant', [
            artifact('node_modules', 'deps', 9 * GB),
            artifact('dist', 'build', GB),
          ]),
        ),
      ]),
      { preset: 'aggressive', width: 120, height: 24 },
    );
    await ui.waitForText('scan complete');
    await settle();

    // On the ROW, not merely somewhere in the frame. `Detail` renders the same chips and
    // does receive `categories`, so a whole-frame assertion passes even when the list pane
    // is starved of them — which is exactly how the missing prop survived review.
    // `needs` rather than `needs network`: ink-testing-library lays out against its own
    // width, so the chip column is narrower than the declared 120 and the text is cut. The
    // prefix is unambiguous — no other chip begins with it — and what is being tested is
    // that the pane received a category set at all, not how wide the harness is.
    expect(ui.line('app')).toContain('needs');
  });
});

/**
 * The duplicated header, and why counting to `rows` was one too far.
 *
 * The user's report was "when scrolling, sometimes the header duplicates", and the screenshot
 * that came with it was taken after a clean. That is not a scrolling bug; it is the frame being
 * exactly as tall as the terminal.
 *
 * Ink redraws incrementally: it writes `frame + "\n"` and, next time, erases the number of
 * lines it wrote. A frame of exactly `rows` lines therefore occupies `rows + 1` terminal lines,
 * the emulator scrolls by one, and the erase can no longer reach the line that has gone. Ink
 * knows this and switches to a whole-screen clear at `outputHeight >= rows` — but that branch
 * never updates the incremental renderer's line count, so the next frame that happens to be
 * *shorter* (a confirmation, a round summary, the sparse first frames of a scan) erases too few
 * lines and leaves the previous frame's header sitting above the new one. Hence "after a
 * clean": the round summary is the short frame that follows a full-height list.
 *
 * The old chrome constants summed to exactly `rows`, so every single list frame took that
 * branch. The test that was supposed to catch it asserted `lines().length <= rows`, which is
 * true of the broken layout — the bug lives entirely in the difference between `<= rows` and
 * `< rows`.
 *
 * These tests assert the frame is at most `rows - 1`, at a spread of terminal sizes, before and
 * after a round. They are scoped to frames that carry the footer — the workspace, which is what
 * this file's layout owns — because the modal panes are separate components with their own
 * budgets.
 */
describe('the frame leaves the terminal a spare row', () => {
  const many = (count: number): AsyncIterable<ScanEvent> =>
    fastStream(
      Array.from({ length: count }, (_, index) =>
        projectEvent(
          makeProject(`proj-${String(index).padStart(2, '0')}`, index % 4 === 0 ? 'active' : 'dormant', [
            artifact('dist', 'build', (count - index) * GB),
          ]),
        ),
      ),
    );

  /** A frame drawn by the workspace, as opposed to one of the modal panes. */
  const isWorkspace = (frame: string): boolean => frame.includes('space toggle');

  it('budgets chrome plus list to less than the terminal, at every height', () => {
    for (let rows = 7; rows <= 60; rows += 1) {
      const { chrome, listHeight } = frameBudget(rows);
      expect(chrome + listHeight, `at ${rows} rows`).toBeLessThanOrEqual(rows - 1);
      expect(listHeight, `at ${rows} rows`).toBeGreaterThan(0);
    }
  });

  it.each([12, 14, 16, 18, 20, 24, 30, 40])(
    'draws at most %i-1 lines with a list far longer than the window',
    async (rows) => {
      const ui = mount(many(30), { width: 100, height: rows });
      await ui.waitForText('scan complete');
      await settle();

      expect(ui.lines().length, `at ${rows} rows`).toBeLessThanOrEqual(rows - 1);

      // And it stays that way while the cursor walks the list, which is when the user saw it.
      for (let step = 0; step < 12; step += 1) {
        await ui.press('j');
        expect(ui.lines().length, `at ${rows} rows, step ${step}`).toBeLessThanOrEqual(rows - 1);
      }
    },
  );

  /**
   * The post-clean frame is the one in the screenshot, and it is not the same frame: the
   * session ledger has appeared in the footer, rows have gone, and the totals have changed.
   * Every one of those is a chance for a line to grow.
   */
  it.each([14, 18, 24, 40])('still fits after a clean round, at %i rows', async (rows) => {
    const ui = mount(many(30), { screen: {}, width: 100, height: rows });
    await ui.waitForText('scan complete');
    await settle();

    const before = ui.instance.frames.length;

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);
    await ui.waitForText('to the Trash.');
    await ui.press(ESCAPE);
    await settle();

    // Back on the list, with the ledger now in the footer.
    expect(ui.frame()).toContain('trashed this session');
    expect(ui.lines().length, `at ${rows} rows`).toBeLessThanOrEqual(rows - 1);

    // …and every workspace frame drawn along the way, not merely the one that survived.
    const workspace = ui.instance.frames.slice(before).filter(isWorkspace);
    expect(workspace.length).toBeGreaterThan(0);
    for (const frame of workspace) {
      expect(frame.split('\n').length, `at ${rows} rows`).toBeLessThanOrEqual(rows - 1);
    }
  });

  /**
   * Height is only half of it. Ink measures the frame it *lays out*; a line longer than the
   * terminal is wrapped by the emulator afterwards, which adds a physical row Ink never counted
   * and reproduces the same defect from the other axis. `ink-testing-library` fixes its own
   * width at 100 columns, so this one renders through a stdout of its own.
   */
  it.each([40, 56, 60, 80, 100, 120])('keeps every line inside %i columns', async (columns) => {
    const stdout = new FixedStdout(columns, 24);
    const instance = inkRender(
      <App
        stream={many(30)}
        categoriesFor={categoriesFor}
        onClean={async () => []}
        nowMs={NOW}
        readDisk={async () => ({ total: 466 * GB, used: 391 * GB, free: 75 * GB })}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new FixedStdin() as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    inkRendered.push(instance);

    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('scan complete'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });

    const lines = stdout.lastFrame().split('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    for (const line of lines) {
      expect([...line].length, JSON.stringify(line)).toBeLessThanOrEqual(columns);
    }
    // The pinned chrome survived the narrowing, top and bottom.
    expect(stdout.lastFrame()).toContain('dev-cleaner');
    expect(stdout.lastFrame()).toContain('space toggle');
  });
});

/**
 * Less chrome, and the number given the room it bought.
 *
 * Six lines used to frame one table: a title, two lines of gauge, a section note truncated
 * mid-sentence, the key hints and a status line. The note restated — badly, in one clipped line
 * — what the detail pane says in full beside every row it applies to; the gauge's second line
 * carried a caveat about a projection that was printed on the line above it. Neither earned a
 * permanent row.
 *
 * What is left is four lines above the panes and one below, and two of those four are the
 * headline figure. The assertions are positional on purpose: "how many lines of chrome" is the
 * property, and it cannot be expressed as a substring.
 */
describe('the chrome is four lines above the panes and one below', () => {
  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 6 * GB)])),
      projectEvent(makeProject('beta', 'dormant', [artifact('dist', 'build', 5 * GB)])),
      projectEvent(makeProject('busy', 'active', [artifact('dist', 'build', 4 * GB)])),
    ]);

  const usage: DiskUsage = { total: 100 * GB, used: 80 * GB, free: 20 * GB };

  it('opens the panes on the fifth line and closes the frame one line later', async () => {
    const ui = mount(stream(), { width: 100, height: 24, disk: [usage] });
    await ui.waitForText('scan complete');
    await settle();

    const lines = ui.lines();
    const top = lines.findIndex((line) => line.includes('╭'));
    const bottom = lines.findIndex((line) => line.includes('╰'));

    // Wordmark, gauge, and the two rows of the headline figure. Nothing else.
    expect(top).toBe(4);
    // Exactly one line under the panes: the key hints. Not two, and not a section note.
    expect(lines.length - bottom - 1).toBe(1);
    expect(lines[lines.length - 1]).toContain('space toggle');
  });

  /**
   * The gauge is one line and states the volume; the consequences of the *selection* — the
   * projection, and the caveat that stops it being read as a reading — moved next to the
   * headline figure they describe. The caveat is still on screen, which is the part that
   * matters: `diskbar.ts` exports the sentence precisely so a re-layout cannot lose it.
   */
  it('draws the bar and the volume on one line, with the caveat beside the figure', async () => {
    const ui = mount(stream(), { width: 100, height: 24, disk: [usage] });
    await ui.waitForText('selected 2');
    await settle();

    const lines = ui.lines();
    const bar = lines.findIndex((line) => line.includes('█'));
    expect(bar).toBe(1);
    expect(lines[1]).toContain('80.0G used of 100G');
    expect(lines[1]).toContain('20.0G free');
    // The line after the bar is the headline figure, not a second line of gauge.
    expect(lines[2]).toContain(bigText(formatBytes(11 * GB))[0]);

    expect(ui.frame()).toContain('Trashed files still occupy the disk');
    expect(ui.frame()).toContain('→ 31.0G free once emptied');
  });
});

/**
 * The number the user came for.
 *
 * "The amount that will be 'freed' is not very prominent" — it was `selected 8 · 104G` in dim
 * cyan at the end of a status line, six characters at the bottom of a screen the user had
 * opened *specifically* to find out that number. It is now the headline: two rows of block
 * glyphs, the largest thing on the frame, redrawn on every keystroke that changes it.
 *
 * The assertions are against `bigText`, so they are about the figure actually being drawn at
 * size — a footer that merely printed `11.0G` somewhere would satisfy a substring check.
 */
describe('the selection total is the headline', () => {
  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([
      projectEvent(makeProject('big', 'dormant', [artifact('target', 'build', 6 * GB)])),
      projectEvent(makeProject('small', 'dormant', [artifact('dist', 'build', 5 * GB)])),
    ]);

  const drawnAt = (frame: string, bytes: number): number => {
    const [top, bottom] = bigText(formatBytes(bytes));
    const lines = frame.split('\n');
    const at = lines.findIndex((line) => line.includes(top));
    // Both rows, adjacent and in order, or it is not a figure — it is a coincidence.
    return at >= 0 && (lines[at + 1] ?? '').includes(bottom) ? at : -1;
  };

  it('draws the total at four times the size of anything else on the frame', async () => {
    const ui = mount(stream(), { width: 100, height: 24 });
    await ui.waitForText('selected 2');
    await settle();

    expect(drawnAt(ui.frame(), 11 * GB)).toBe(2);
  });

  it('redraws as the user checks and unchecks boxes', async () => {
    const ui = mount(stream(), { width: 100, height: 24 });
    await ui.waitForText('selected 2');
    await settle();
    expect(drawnAt(ui.frame(), 11 * GB)).toBeGreaterThanOrEqual(0);

    await ui.press(SPACE); // clear `big`, 6 G
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    expect(drawnAt(ui.frame(), 5 * GB)).toBeGreaterThanOrEqual(0);
    expect(drawnAt(ui.frame(), 11 * GB)).toBe(-1);

    await ui.press(SPACE);
    expect(drawnAt(ui.frame(), 11 * GB)).toBeGreaterThanOrEqual(0);
  });

  /**
   * Zero is drawn, not hidden. The figure's whole job is to move as boxes are checked, and a
   * number that appears out of nowhere on the first check reads as a new element arriving
   * rather than as the same one answering.
   */
  it('draws a figure of 0B when nothing is selected', async () => {
    const ui = mount(stream(), { width: 100, height: 24 });
    await ui.waitForText('selected 2');
    await settle();

    await ui.press('a');
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 0'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    expect(drawnAt(ui.frame(), 0)).toBeGreaterThanOrEqual(0);
  });

  it('says how much of the list the figure covers', async () => {
    const ui = mount(stream(), { width: 100, height: 24 });
    await ui.waitForText('selected 2');
    await settle();
    expect(ui.frame()).toContain('selected 2 of 2');
  });
});

/**
 * Branding, and the row budget it is not allowed to spend.
 *
 * The user asked for "ascii style titling or something maybe?". A tall banner in the workspace
 * would eat the rows the rest of this work just bought back, and would do it on every frame of
 * every session to say something the user already knows. So the workspace gets a one-line
 * wordmark, and the block face gets its full outing on the clean — the one screen with the
 * terminal to itself and a user who has nothing to do but watch.
 */
describe('the wordmark', () => {
  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 5 * GB)]))]);

  it('costs the workspace exactly one line', async () => {
    const ui = mount(stream(), { width: 100, height: 24 });
    await ui.waitForText('scan complete');
    await settle();

    const lines = ui.lines();
    expect(lines[0]).toContain(WORDMARK);
    // Not a banner: the second line is the gauge, not more letterforms.
    expect(lines[1]).not.toContain('dev-cleaner');
    expect(lines[1]).toContain('disk usage unavailable');
  });

  it('spells itself out in full on the clean, where nothing competes for the space', async () => {
    const held = gate();
    const ui = mount(stream(), { width: 100, height: 24, holdClean: held });
    await ui.waitForText('selected 1');
    await settle();

    await ui.press(ENTER);
    await ui.press(ENTER);
    await vi.waitFor(() => expect(ui.cleaned).toHaveLength(1), { timeout: RENDER_TIMEOUT, interval: 10 });

    const [top, bottom] = bigText(LOGO_TEXT);
    expect(ui.frame()).toContain(top);
    expect(ui.frame()).toContain(bottom);
    // And the figure is still the headline: what is moving, at size.
    expect(ui.frame()).toContain('to the Trash…');
    expect(ui.frame()).toContain(bigText(formatBytes(5 * GB))[0]);

    held.open();
    await ui.waitForText('to the Trash.');
  });

  /** A terminal too narrow for the letterforms gets the compact mark rather than a wrap. */
  it('degrades to the compact mark rather than wrapping on a narrow terminal', async () => {
    const held = gate();
    const stdout = new FixedStdout(40, 24);
    const stdin = new FixedStdin();
    let cleanedOnce = false;

    const instance = inkRender(
      <App
        stream={fastStream([
          projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 5 * GB)])),
        ])}
        categoriesFor={categoriesFor}
        onClean={async () => {
          cleanedOnce = true;
          await held.promise;
          return [];
        }}
        nowMs={NOW}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    inkRendered.push(instance);

    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('selected 1'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    await settle();
    stdin.write(ENTER);
    await delay(30);
    stdin.write(ENTER);
    await vi.waitFor(() => expect(cleanedOnce).toBe(true), { timeout: RENDER_TIMEOUT, interval: 10 });

    const frame = stdout.lastFrame();
    expect(frame).not.toContain(bigText(LOGO_TEXT)[0]);
    expect(frame).toContain('dev-cleaner');
    for (const line of frame.split('\n')) expect([...line].length).toBeLessThanOrEqual(40);

    held.open();
  });
});

/**
 * The command bar is one line, and it keeps the keys visible whatever else it has to say.
 *
 * It used to be two: hints, and a status line whose contents have all moved somewhere better —
 * the selection total to the headline, the preset to the title line. What is left is the
 * session ledger, and a message when there is one. Both share the line with the hints.
 *
 * The rule that matters is the one about messages: a user who has just seen `clean failed:` is
 * exactly the user who needs to know which key gets them out, so the right-hand column may
 * take at most half the bar and the keys keep the rest.
 */
describe('the command bar', () => {
  const stream = (): AsyncIterable<ScanEvent> =>
    fastStream([projectEvent(makeProject('alpha', 'dormant', [artifact('dist', 'build', 5 * GB)]))]);

  it('shows a message and the keybindings on the same single line', async () => {
    const ui = mount(stream(), { width: 100, height: 24 });
    await ui.waitForText('selected 1');
    await settle();

    const before = ui.lines().length;

    await ui.press('a'); // clear the section
    await vi.waitFor(() => expect(ui.frame()).toContain('selected 0'), {
      timeout: RENDER_TIMEOUT,
      interval: 10,
    });
    await ui.press(ENTER);

    const lines = ui.lines();
    expect(lines.length).toBe(before);

    const bar = lines[lines.length - 1] ?? '';
    expect(bar).toContain('Nothing selected');
    expect(bar).toContain('space toggle');
    expect(bar).toContain('q quit');
  });

  it('never lets a long message take more than half the bar from the keys', async () => {
    const ui = mount(stream(), {
      width: 100,
      height: 24,
      onAttempt: () => {
        throw new Error('EMFILE: too many open files while moving directories to the Trash');
      },
    });
    await ui.waitForText('selected 1');
    await settle();

    await ui.press(ENTER);
    await ui.press(ENTER);
    await ui.waitForText('clean failed: EMFILE');

    const bar = ui.lines()[ui.lines().length - 1] ?? '';
    expect([...bar].length).toBeLessThanOrEqual(100);
    // Half the bar is the message's ceiling, so the keys keep the rest — including the one
    // that gets the user out of the state the message is about.
    expect(bar).toContain('space toggle');
    expect(bar).toContain(KEY_HINTS.slice(0, 40));
  });

  it('carries the session ledger once a round has completed', async () => {
    const ui = mount(stream(), { screen: {}, width: 100, height: 24 });
    await ui.waitForText('selected 1');
    await settle();

    await ui.press(ENTER);
    await ui.waitForText('Move to Trash?');
    await ui.press(ENTER);
    await ui.waitForText('to the Trash.');
    await ui.press(ESCAPE);

    const bar = ui.lines()[ui.lines().length - 1] ?? '';
    expect(bar).toContain('5.0G trashed this session');
    expect(bar).toContain('space toggle');
  });
});
