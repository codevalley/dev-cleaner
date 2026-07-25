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

const projectEvent = (project: Project): ScanEvent => ({ kind: 'project', project });
const cacheEvent = (cache: CacheEntry): ScanEvent => ({ kind: 'cache', cache });

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
  overrides: { preset?: Preset } = {},
): Harness {
  const cleaned: CleanTarget[][] = [];
  const exits: ExitSummary[] = [];

  const onClean = async (targets: readonly CleanTarget[]): Promise<CleanOutcome[]> => {
    cleaned.push([...targets]);
    return targets.map((target) => ({
      target,
      label: target.kind === 'project' ? target.artifact.relPath : target.cache.label,
      bytes: target.kind === 'project' ? target.artifact.bytes : target.cache.bytes,
      outcome: 'trashed' as const,
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

  it('q quits without cleaning anything', async () => {
    const ui = mount(stream());
    await ui.waitForText('bump');

    await ui.press('q');

    expect(ui.cleaned).toEqual([]);
    expect(ui.exits).toEqual([{ cleaned: false, outcomes: [], trashedBytes: 0 }]);
  });

  it('enter asks for a second confirmation before anything is trashed', async () => {
    const ui = mount(stream());
    await ui.waitForText('bump');

    await ui.press(ENTER);

    expect(ui.frame()).toContain('Move to Trash?');
    expect(ui.frame()).toContain('bump');
    expect(ui.frame()).toContain('npm cache');
    expect(ui.cleaned).toEqual([]);
  });

  it('escape returns from the confirmation without cleaning', async () => {
    const ui = mount(stream());
    await ui.waitForText('bump');

    await ui.press(ENTER);
    await ui.press(ESCAPE);

    expect(ui.frame()).not.toContain('Move to Trash?');
    expect(ui.frame()).toContain('space toggle');
    expect(ui.cleaned).toEqual([]);
  });

  it('the second enter cleans, passing the discriminated union through', async () => {
    const ui = mount(stream());
    await ui.waitForText('bump');

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

  it('refuses to open the confirmation with an empty selection', async () => {
    const ui = mount(stream());
    await ui.waitForText('bump');

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
