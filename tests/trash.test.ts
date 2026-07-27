/**
 * `src/trash.ts` — the disclosure that precedes an irreversible, total destruction, and the
 * prompt that carries it (`src/ui/Trash.tsx`).
 *
 * Nothing in this file empties a Trash, and nothing in it can. `node:child_process` is
 * mocked for the whole file, so no subprocess is ever created: the tests assert what
 * dev-cleaner *would* run, which is the only way to pin a command whose real execution is
 * unrecoverable. Every trash directory under test is a temporary fixture, and every Finder
 * reply is a string handed to an injected executor.
 *
 * A consequence worth stating, because it makes the byte figures real rather than stubbed:
 * with `execFile` mocked, `du` fails to spawn and `size.ts` falls back to its in-process
 * walker. The sizes measured here come from an actual filesystem.
 *
 * The properties these tests exist to hold down, in order of how much damage their loss
 * would do:
 *
 * 1. An unreadable trash directory never reports a zero total. `dirSize` is best-effort and
 *    answers 0 for a directory it cannot read; if that 0 reached the user it would appear
 *    under an "Empty Trash?" prompt as "nothing in there", and they would approve the
 *    destruction of a Trash whose contents were never shown to them. macOS makes this the
 *    *common* path — `~/.Trash` needs Full Disk Access — so it is tested against a genuinely
 *    unreadable directory, not a stub.
 * 2. No partial total, ever, from any source. A figure smaller than what emptying destroys is
 *    worse than no figure. This now has a second front: Finder answers `missing value` for
 *    the size of every folder, so a sum over the items it *could* size would understate by
 *    exactly the `node_modules` this tool put there.
 * 3. The summary covers the whole Trash: every item, whatever it is, and every per-volume
 *    `.Trashes` directory Finder would empty.
 * 4. Emptying goes through Finder and never through a recursive delete of our own.
 * 5. Reading never empties. The read path may now spawn `osascript` too, so this is asserted
 *    against the script text of every command the read path requests.
 * 6. "No figure" and "no offer" are different states, and the second is much narrower than the
 *    first. Refusing to offer whenever the Trash could not be measured is what made this
 *    feature dead on a stock Mac; the offer survives, the byte figure does not.
 */

import { chmod, readdir, symlink as fsSymlink } from 'node:fs/promises';

import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultTrashRoots,
  emptyTrash,
  mayOfferEmpty,
  readTrashSummary,
  type TrashExec,
  type TrashSummary,
} from '../src/trash.js';
import { TrashConfirm, TrashResult, trashConfirmArmed } from '../src/ui/Trash.js';
import { dir, file, fixture, type Fixture } from './fixture.js';

/**
 * Records every spawn request and creates no process. Hoisted so the `vi.mock` factory —
 * which vitest lifts above the imports — can close over it.
 *
 * `du` is always answered with a spawn failure so `size.ts` uses its walker; everything else
 * gets whatever `result` currently holds, which is how the `osascript` outcomes are driven.
 */
const spawns = vi.hoisted(() => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const result: { error: NodeJS.ErrnoException | null; stdout: string; stderr: string } = {
    error: null,
    stdout: '',
    stderr: '',
  };
  return { calls, result };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  type Callback = (
    error: NodeJS.ErrnoException | null,
    stdout: string,
    stderr: string,
  ) => void;
  const execFile = (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
    callback: Callback,
  ): unknown => {
    spawns.calls.push({ command, args: [...args], options });
    if (command === 'du') {
      const missing: NodeJS.ErrnoException = Object.assign(new Error('spawn du ENOENT'), {
        code: 'ENOENT',
      });
      queueMicrotask(() => callback(missing, '', ''));
      return {};
    }
    const { error, stdout, stderr } = spawns.result;
    queueMicrotask(() => callback(error, stdout, stderr));
    return {};
  };
  return { ...actual, execFile };
});

/** Names of the commands dev-cleaner asked to run, in order. */
function spawnedCommands(): string[] {
  return spawns.calls.map((call) => call.command);
}

interface Recorder {
  exec: TrashExec;
  calls: Array<{ command: string; args: readonly string[] }>;
  /** The AppleScript of each request, in order — what the assertions about safety look at. */
  scripts(): string[];
}

/** A `TrashExec` that records and never runs anything. */
function recordingExec(outcome: { ok: boolean; stdout?: string; stderr?: string }): Recorder {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const exec: TrashExec = async (command, args) => {
    calls.push({ command, args });
    return { ok: outcome.ok, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' };
  };
  return { exec, calls, scripts: () => calls.map((call) => call.args[1] ?? '') };
}

interface Reply {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * A stand-in Finder, answering by which question it was asked.
 *
 * Dispatching on the script's own words rather than on call order is deliberate: a test that
 * says "the sizes question was never asked" then means it literally, and cannot be satisfied by
 * an implementation that asked it first.
 */
function fakeFinder(replies: { count?: Reply; sizes?: Reply; empty?: Reply }): Recorder {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const exec: TrashExec = async (command, args) => {
    calls.push({ command, args });
    const script = args[1] ?? '';
    const reply = script.includes('empty')
      ? replies.empty
      : script.includes('physical size')
        ? replies.sizes
        : script.includes('count items')
          ? replies.count
          : undefined;
    if (reply === undefined) {
      return { ok: false, stdout: '', stderr: `unexpected script: ${script}` };
    }
    return { ok: reply.ok, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  };
  return { exec, calls, scripts: () => calls.map((call) => call.args[1] ?? '') };
}

/** Sizes stubbed per path, for tests whose point is the arithmetic rather than the walker. */
function fixedSize(byPath: Record<string, number>): (target: string) => Promise<number> {
  return async (target) => byPath[target] ?? 0;
}

let f: Fixture;
/** Directories made unreadable by a test, restored before cleanup can trip over them. */
let locked: string[] = [];

type Instance = ReturnType<typeof render>;
const rendered: Instance[] = [];

/** Render a pane and return its frame. JSX-free so this file can stay a `.ts`. */
function frameOf(element: React.ReactElement): string {
  const instance = render(element);
  rendered.push(instance);
  return instance.lastFrame() ?? '';
}

beforeEach(() => {
  spawns.calls.length = 0;
  spawns.result.error = null;
  spawns.result.stdout = '';
  spawns.result.stderr = '';
  locked = [];
});

afterEach(async () => {
  for (const instance of rendered.splice(0)) instance.unmount();
  for (const target of locked) await chmod(target, 0o700).catch(() => {});
  await f?.cleanup();
});

const RUNNING_AS_ROOT = process.getuid?.() === 0;

/**
 * A directory that exists and cannot be listed — `readdir` fails with something other than
 * ENOENT — without needing a particular uid to arrange it. A self-referential symlink answers
 * ELOOP, which `readTrashSummary` must treat exactly as it treats the EPERM that macOS returns
 * for `~/.Trash`; the EPERM case itself is exercised separately, against a real chmod.
 */
async function unlistableRoot(): Promise<string> {
  const target = f.path('unlistable');
  await fsSymlink(target, target);
  await expect(readdir(target)).rejects.toThrow();
  return target;
}

describe('readTrashSummary: the whole Trash, not this run', () => {
  it('counts every item in the Trash, whatever it is', async () => {
    // The hazard in one fixture: two build artifacts dev-cleaner put here, and two things
    // the user put here months ago. Emptying destroys all four, so all four must be in the
    // number shown next to the prompt. A summary that described only what this tool
    // recognises would understate the loss it is about to ask permission for.
    f = await fixture({
      'trash/node_modules': dir(),
      'trash/dist': dir(),
      'trash/holiday-photos': dir(),
      'trash/tax-return-2019.pdf': file('x', { size: 4096 }),
    });
    const root = f.path('trash');

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin' });

    expect(summary.available).toBe(true);
    expect(summary.items).toBe(4);
  });

  it('sums bytes across every trash directory Finder would empty', async () => {
    // A per-volume `.Trashes/<uid>` is not a footnote: Finder empties it too. Reporting only
    // the home Trash would under-disclose by exactly the external volume's contents.
    f = await fixture({ 'home/.Trash/a': dir(), 'volume/.Trashes/501/b': dir() });
    const home = f.path('home/.Trash');
    const volume = f.path('volume/.Trashes/501');

    const summary = await readTrashSummary({
      roots: [home, volume],
      platform: 'darwin',
      size: fixedSize({ [home]: 3_000, [volume]: 5_000 }),
    });

    expect(summary).toEqual({ bytes: 8_000, items: 2, available: true, source: 'filesystem' });
  });

  it('does not follow a symlink sitting in the Trash', async () => {
    f = await fixture({ 'big/payload.bin': file('x', { size: 2_000_000 }), 'trash': dir() });
    // The spec cannot reference the fixture root, so the link is made once it exists.
    await fsSymlink(f.path('big'), f.path('trash/link-to-big'));

    const summary = await readTrashSummary({ roots: [f.path('trash')], platform: 'darwin' });

    expect(summary.available).toBe(true);
    expect(summary.bytes).toBeLessThan(1_000_000);
  });

  it('ignores Finder’s own .DS_Store', async () => {
    f = await fixture({ 'trash/.DS_Store': file('x', { size: 6148 }) });

    const summary = await readTrashSummary({ roots: [f.path('trash')], platform: 'darwin' });

    expect(summary.items).toBe(0);
  });

  it('counts a user’s own dotfile as the item it is', async () => {
    f = await fixture({ 'trash/.env': file('SECRET=1') });

    const summary = await readTrashSummary({ roots: [f.path('trash')], platform: 'darwin' });

    expect(summary.items).toBe(1);
  });
});

describe('readTrashSummary: unreadable is not empty', () => {
  it.skipIf(RUNNING_AS_ROOT)(
    'never reports a zero for a trash directory it cannot read',
    async () => {
      // The exact macOS default: a terminal without Full Disk Access gets EPERM on ~/.Trash.
      // `dirSize` would answer 0 for this directory without complaint. Reporting that 0 would
      // put "Trash: 0 B" above a prompt that destroys everything in it. Finder is asked next
      // and refused here, so there is no figure from any source.
      f = await fixture({ 'trash/secret': dir() });
      const root = f.path('trash');
      await chmod(root, 0o000);
      locked.push(root);

      // Precondition: prove the directory really is unreadable, so this can never pass by
      // accident on a filesystem or user that ignores the mode.
      await expect(readdir(root)).rejects.toThrow();

      const { exec } = fakeFinder({ count: { ok: false, stderr: 'denied' } });
      const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec });

      expect(summary.available).toBe(false);
      expect(summary.bytes).toBe(0);
    },
  );

  it.skipIf(RUNNING_AS_ROOT)('reports no partial total when one directory is unreadable', async () => {
    // Fail closed. The readable half holds 9 GB and the unreadable half holds an unknown
    // amount; "9 GB" next to a prompt that empties both is the one number that must not
    // appear, because it is smaller than the truth and reads as complete.
    f = await fixture({ 'readable/a': dir(), 'locked/b': dir() });
    const readable = f.path('readable');
    const lockedRoot = f.path('locked');
    await chmod(lockedRoot, 0o000);
    locked.push(lockedRoot);
    await expect(readdir(lockedRoot)).rejects.toThrow();

    const { exec } = fakeFinder({ count: { ok: false, stderr: 'denied' } });
    const summary = await readTrashSummary({
      roots: [readable, lockedRoot],
      platform: 'darwin',
      exec,
      size: fixedSize({ [readable]: 9_000_000_000 }),
    });

    expect(summary.available).toBe(false);
    expect(summary.bytes).toBe(0);
    expect(summary.items).toBe(0);
  });

  it('treats a missing trash directory as empty, not as a failure', async () => {
    // ENOENT is an answer: there is no Trash here, so there is nothing in it. Conflating it
    // with "cannot read" would suppress a perfectly good total on any machine whose external
    // volume has never had anything trashed on it.
    f = await fixture({ 'home/.Trash/a': dir() });
    const home = f.path('home/.Trash');

    const summary = await readTrashSummary({
      roots: [home, f.path('volume/.Trashes/501')],
      platform: 'darwin',
      size: fixedSize({ [home]: 1_500 }),
    });

    expect(summary).toEqual({ bytes: 1_500, items: 1, available: true, source: 'filesystem' });
  });

  it('offers nothing at all where the platform has no known Trash layout', async () => {
    f = await fixture({ 'trash/a': dir() });

    const summary = await readTrashSummary({ platform: 'win32' });

    expect(summary.available).toBe(false);
    expect(summary.bytes).toBe(0);
    expect(summary.items).toBe(0);
    expect(summary.source).toBe('unsupported');
    // Nothing here can empty a Windows Recycle Bin, so there is no offer to make either.
    expect(mayOfferEmpty(summary)).toBe(false);
  });

  it('does not ask Finder on a platform that has no Finder', async () => {
    f = await fixture({});
    const root = await unlistableRoot();
    const { exec, calls } = fakeFinder({ count: { ok: true, stdout: '9' } });

    const summary = await readTrashSummary({ roots: [root], platform: 'linux', exec });

    expect(calls).toEqual([]);
    expect(summary.available).toBe(false);
    expect(summary.source).toBe('blind');
  });
});

/**
 * The fallback that makes the feature exist at all on a stock Mac.
 *
 * Reading `~/.Trash` needs Full Disk Access, which a terminal does not have. Finder already
 * holds the entitlement and will answer over Apple events — a *different* permission
 * (Automation), granted by a different prompt. Before this, the tool gave up at the first
 * `EPERM` and told the user to go to Finder, which on the machine it was written for meant
 * abandoning 107 GB one keystroke short of reclaiming it.
 */
describe('readTrashSummary: falling back to Finder', () => {
  it.skipIf(RUNNING_AS_ROOT)('asks Finder when macOS denies the direct read', async () => {
    f = await fixture({ 'trash/secret': dir() });
    const root = f.path('trash');
    await chmod(root, 0o000);
    locked.push(root);
    await expect(readdir(root)).rejects.toThrow();

    const finder = fakeFinder({
      count: { ok: true, stdout: '8\n' },
      // What Finder actually answers for folders, which is what this tool puts in the Trash.
      sizes: { ok: true, stdout: 'missing value, missing value' },
    });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(finder.scripts()[0]).toContain('count items in trash');
    expect(summary.source).toBe('finder');
    expect(summary.knownItems).toBe(8);
    // The count is knowable; the size is not, and no size may be implied.
    expect(summary.available).toBe(false);
    expect(summary.bytes).toBe(0);
    expect(summary.detail).toContain('Full Disk Access');
    // And the whole point: the offer survives the failure to measure.
    expect(mayOfferEmpty(summary)).toBe(true);
  });

  it('prefers the direct read, and does not disturb Finder when it works', async () => {
    // Finder costs an automation consent prompt and a round trip through another process.
    // Neither is worth paying when the answer is already on the filesystem.
    f = await fixture({ 'trash/a': dir(), 'trash/b': file('x', { size: 4096 }) });
    const finder = fakeFinder({ count: { ok: true, stdout: '99' } });

    const summary = await readTrashSummary({
      roots: [f.path('trash')],
      platform: 'darwin',
      exec: finder.exec,
    });

    expect(finder.calls).toEqual([]);
    expect(summary.source).toBe('filesystem');
    expect(summary.items).toBe(2);
  });

  it('reports a measured total when Finder can size every item', async () => {
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({
      count: { ok: true, stdout: '2' },
      sizes: { ok: true, stdout: '3000, 5000' },
    });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(summary).toEqual({ bytes: 8_000, items: 2, available: true, source: 'finder' });
  });

  it('reads Finder’s exponential notation for a very large item', async () => {
    // AppleScript prints big numbers as reals: `1.07374182E+11`. Parsed wrong this is either a
    // throw or a `1`, and the second would be a 107 GB Trash disclosed as a hundred bytes.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({
      count: { ok: true, stdout: '1' },
      sizes: { ok: true, stdout: '1.07374182E+11' },
    });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(summary.available).toBe(true);
    expect(summary.bytes).toBe(107_374_182_000);
    expect(summary.bytes).toBeGreaterThan(99 * 1024 ** 3);
  });

  it('reports no total at all when Finder can size only some of the items', async () => {
    // The load-bearing case. Finder answers `missing value` for every folder it has not
    // already measured, so a sum over what it *could* size is short by exactly the
    // `node_modules` this tool put there — an understated figure under a prompt that destroys
    // everything, which is the one arrangement the module forbids.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({
      count: { ok: true, stdout: '2' },
      sizes: { ok: true, stdout: '3000, missing value' },
    });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(summary.available).toBe(false);
    expect(summary.bytes).toBe(0);
    expect(summary.knownItems).toBe(2);
  });

  it('discards Finder’s sizes when the Trash changed between the two questions', async () => {
    // Count and sizes are two separate Apple events. A total assembled from a three-item Trash
    // and a two-item size list belongs to neither reading.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({
      count: { ok: true, stdout: '3' },
      sizes: { ok: true, stdout: '1000, 2000' },
    });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(summary.available).toBe(false);
    expect(summary.bytes).toBe(0);
    expect(summary.knownItems).toBe(3);
  });

  it('treats an empty Trash as a total, not as an absence of one', async () => {
    // Zero items is zero bytes, and that is a real disclosure. It is also what the pane shown
    // straight after a successful empty depends on being able to say.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({ count: { ok: true, stdout: '0' } });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(summary).toEqual({ bytes: 0, items: 0, available: true, source: 'finder' });
    // Nothing to size, so nothing was asked.
    expect(finder.scripts().some((script) => script.includes('physical size'))).toBe(false);
  });

  it('does not ask Finder to size a Trash too large to enumerate', async () => {
    // One number per item on one line. A hundred thousand of them overruns the pipe and turns
    // a fast "cannot measure this" into a slow one.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({ count: { ok: true, stdout: '200000' } });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(finder.calls).toHaveLength(1);
    expect(summary.knownItems).toBe(200000);
    expect(summary.available).toBe(false);
  });

  it('names both permissions, and still offers, when Finder refuses automation', async () => {
    // The second consent the user may decline. It must read as a checkbox they can tick, not
    // as a crash, and it must say *which* checkbox — Automation is not Full Disk Access.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({
      count: {
        ok: false,
        stderr: 'execution error: Not authorized to send Apple events to Finder. (-1743)',
      },
    });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(summary.source).toBe('blind');
    expect(summary.available).toBe(false);
    expect(summary.knownItems).toBeUndefined();
    expect(summary.detail).toContain('Automation');
    expect(summary.detail).toContain('Full Disk Access');
    expect(mayOfferEmpty(summary)).toBe(true);
  });

  it('treats an unintelligible Finder answer as no answer', async () => {
    // `missing value` on stdout with a zero exit is not a count. Reading it as one via
    // `parseInt` would give NaN, or worse, 0 — "the Trash is empty" under a prompt that
    // empties it.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({ count: { ok: true, stdout: 'missing value' } });

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(summary.source).toBe('blind');
    expect(summary.available).toBe(false);
    expect(summary.knownItems).toBeUndefined();
  });

  it('uses the shipped executor, in argv form, to ask the counting question', async () => {
    // The real read path against the mocked `child_process`: no shell, a bounded timeout, and
    // the counting script verbatim.
    f = await fixture({});
    const root = await unlistableRoot();
    spawns.result.stdout = '7\n';

    const summary = await readTrashSummary({ roots: [root], platform: 'darwin' });

    const asked = spawns.calls.filter((call) => call.command === 'osascript');
    expect(asked).toHaveLength(2);
    expect(asked[0]?.args).toEqual(['-e', 'tell application "Finder" to count items in trash']);
    expect(asked[0]?.options).not.toHaveProperty('shell');
    expect(asked[0]?.options.timeout).toBeGreaterThan(0);
    expect(summary.knownItems).toBe(7);
  });
});

describe('readTrashSummary: reading cannot destroy', () => {
  it('never asks to run osascript when the filesystem answers', async () => {
    // Reading the Trash must not be able to empty it, structurally and not merely by
    // intention. With no process creation possible in this file, the assertion is on what was
    // requested — and nothing resembling an empty may be.
    f = await fixture({ 'trash/a': dir(), 'trash/b': file('x', { size: 8192 }) });

    await readTrashSummary({ roots: [f.path('trash')], platform: 'darwin' });

    expect(spawnedCommands()).not.toContain('osascript');
    const requested = JSON.stringify(spawns.calls);
    expect(requested).not.toContain('empty');
    expect(requested).not.toContain('Finder');
  });

  it('asks Finder nothing that could destroy anything', async () => {
    // The read path may now spawn `osascript`, which is also how the Trash gets emptied. The
    // separation has to hold at the level of the script text: every question the read path can
    // ask only interrogates.
    f = await fixture({});
    const root = await unlistableRoot();
    const finder = fakeFinder({
      count: { ok: true, stdout: '4' },
      sizes: { ok: true, stdout: 'missing value, missing value, missing value, missing value' },
    });

    await readTrashSummary({ roots: [root], platform: 'darwin', exec: finder.exec });

    expect(finder.calls.length).toBeGreaterThan(0);
    for (const script of finder.scripts()) {
      expect(script).not.toContain('empty');
      expect(script).not.toContain('delete');
      expect(script).not.toContain('erase');
      expect(script).not.toMatch(/\brm\b/);
      expect(script).not.toContain('do shell script');
    }
  });
});

describe('defaultTrashRoots', () => {
  it('includes the per-volume trash of every mounted volume', async () => {
    f = await fixture({ 'home/.Trash': dir(), 'Volumes/Backup': dir(), 'Volumes/Media': dir() });

    const roots = await defaultTrashRoots({
      platform: 'darwin',
      home: f.path('home'),
      uid: 501,
      volumesDir: f.path('Volumes'),
    });

    expect(roots).toContain(f.path('home/.Trash'));
    expect(roots).toContain(f.path('Volumes/Backup/.Trashes/501'));
    expect(roots).toContain(f.path('Volumes/Media/.Trashes/501'));
  });

  it('counts a volume reachable by two paths once', async () => {
    // The boot volume commonly appears under /Volumes as well as at its own mount point.
    // Measuring the same directory twice would overstate the total, and an overstated total
    // is still a wrong total.
    f = await fixture({ 'home/.Trash': dir(), 'Volumes/Disk/.Trashes/501': dir() });
    await fsSymlink(f.path('Volumes/Disk'), f.path('Volumes/Alias'));

    const roots = await defaultTrashRoots({
      platform: 'darwin',
      home: f.path('home'),
      uid: 501,
      volumesDir: f.path('Volumes'),
    });

    expect(roots).toHaveLength(2);
  });

  it('yields nothing on a platform whose layout it does not know', async () => {
    f = await fixture({ 'home/.Trash': dir() });

    const roots = await defaultTrashRoots({ platform: 'linux', home: f.path('home'), uid: 501 });

    expect(roots).toEqual([]);
  });
});

describe('emptyTrash', () => {
  it('asks Finder to empty, and runs no delete of its own', async () => {
    // `rm -rf ~/.Trash/*` misses per-volume trashes, breaks Put Back, and is an unbounded
    // recursive delete aimed by a glob — written by the tool that exists because those go
    // wrong. (It also does not work: `rm` is refused `~/.Trash` for the same reason `readdir`
    // is.) The command is pinned so it cannot quietly become one.
    const { exec, calls } = recordingExec({ ok: true });

    const result = await emptyTrash({ platform: 'darwin', exec });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('osascript');
    expect(calls[0]?.args[0]).toBe('-e');
    expect(calls[0]?.args[1]).toContain('Finder');
    expect(calls[0]?.args[1]).toContain('empty trash');
    const everything = `${calls[0]?.command} ${calls[0]?.args.join(' ')}`;
    expect(everything).not.toMatch(/\brm\b/);
    expect(everything).not.toContain('*');
  });

  it('runs no command at all where emptying is unsupported', async () => {
    // The same request means something else, or nothing, on another platform. Refusing before
    // the executor is reached is the difference between declining and guessing.
    const { exec, calls } = recordingExec({ ok: true });

    const result = await emptyTrash({ platform: 'win32', exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('reports failure without retrying by another route', async () => {
    // A failed empty must not escalate into a second, blunter attempt.
    const { exec, calls } = recordingExec({ ok: false, stderr: 'execution error: whatever' });

    const result = await emptyTrash({ platform: 'darwin', exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('whatever');
    expect(calls).toHaveLength(1);
  });

  it('translates macOS automation denial into the step that fixes it', async () => {
    const { exec } = recordingExec({
      ok: false,
      stderr: 'execution error: Not authorized to send Apple events to Finder. (-1743)',
    });

    const result = await emptyTrash({ platform: 'darwin', exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Automation');
    expect(result.detail).toContain('-1743');
  });

  it('always gives a reason when it fails', async () => {
    const { exec } = recordingExec({ ok: false, stderr: '   ' });

    const result = await emptyTrash({ platform: 'darwin', exec });

    expect(result.ok).toBe(false);
    expect(result.detail?.length).toBeGreaterThan(0);
  });

  it('spawns osascript without a shell', async () => {
    // The shipped executor, exercised for real against the mocked child_process: argv form,
    // so nothing in the script text can be reinterpreted by a shell.
    spawns.result.error = null;

    const result = await emptyTrash({ platform: 'darwin' });

    expect(result.ok).toBe(true);
    expect(spawns.calls).toHaveLength(1);
    expect(spawns.calls[0]?.command).toBe('osascript');
    expect(spawns.calls[0]?.args).toEqual(['-e', 'tell application "Finder" to empty trash']);
    expect(spawns.calls[0]?.options).not.toHaveProperty('shell');
    expect(spawns.calls[0]?.options.timeout).toBeGreaterThan(0);
  });

  it('surfaces a spawn failure of the shipped executor as a reason, not a throw', async () => {
    spawns.result.error = Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' });
    spawns.result.stderr = 'spawn osascript ENOENT';

    const result = await emptyTrash({ platform: 'darwin' });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ENOENT');
  });
});

/**
 * `mayOfferEmpty` is the single place the difference between "no figure" and "no offer" is
 * decided, and the two must not blur in either direction.
 */
describe('mayOfferEmpty', () => {
  it('offers against a measured Trash', () => {
    expect(mayOfferEmpty({ bytes: 1, items: 1, available: true, source: 'filesystem' })).toBe(true);
  });

  it('offers against an unmeasurable one whose reason is known', () => {
    expect(mayOfferEmpty({ bytes: 0, items: 0, available: false, source: 'finder' })).toBe(true);
    expect(mayOfferEmpty({ bytes: 0, items: 0, available: false, source: 'blind' })).toBe(true);
  });

  it('offers nothing where nothing can be emptied', () => {
    expect(mayOfferEmpty({ bytes: 0, items: 0, available: false, source: 'unsupported' })).toBe(
      false,
    );
  });

  it('offers nothing against a summary that did not say why it is empty-handed', () => {
    // A caller that reports only "unavailable" has said nothing about whether an empty is even
    // possible. The reason an unmeasured offer is defensible is that the reason is known.
    expect(mayOfferEmpty({ bytes: 0, items: 0, available: false })).toBe(false);
  });
});

/**
 * The prompt itself. Rendered rather than asserted as props, because every claim here is about
 * what reaches the eyes of someone about to destroy data irreversibly.
 */
describe('TrashConfirm', () => {
  const WIDTH = 72;
  const confirm = (summary: TrashSummary, typed = ''): string =>
    frameOf(React.createElement(TrashConfirm, { summary, typed, width: WIDTH }));

  it('shows the measured total, and the word arms on it', () => {
    const frame = confirm({ bytes: 120 * 1024 ** 3, items: 348, available: true, source: 'filesystem' }, 'empty');

    expect(frame).toContain('120G · 348 items in the Trash');
    expect(frame).toContain('not only what dev-cleaner put there');
    expect(frame).toContain('enter empties the Trash');
  });

  it('offers the empty when the Trash cannot be measured, and prints no byte figure', () => {
    // The whole repair. Before this the pane said "empty it from Finder instead" and the
    // 107 GB stayed on the disk.
    const frame = confirm({
      bytes: 0,
      items: 0,
      available: false,
      source: 'finder',
      knownItems: 8,
      detail: 'dev-cleaner cannot measure the Trash. Grant Full Disk Access in System Settings.',
    });

    expect(frame).toContain('Empty the Trash?');
    expect(frame).toContain('Finder counts 8 items');
    // `empty` is styled, so the word is not contiguous with `type` in the frame; the prompt
    // that follows it is the assertable half.
    expect(frame).toContain('to confirm:');
    // No byte figure anywhere: `bytes` is 0 because it is unknown, and "0B" beside a prompt
    // that destroys everything is the understatement this module exists to prevent.
    expect(frame).not.toContain('0B');
    // And the copy has to say plainly what is unknown and what is destroyed.
    expect(frame).toContain('cannot see inside the Trash');
    expect(frame).toContain('including what you put there yourself');
    expect(frame).toContain('Full Disk Access');
  });

  it('offers the empty when nothing at all could be learned', () => {
    const frame = confirm({
      bytes: 0,
      items: 0,
      available: false,
      source: 'blind',
      detail: 'Grant Full Disk Access, or allow Automation, in System Settings.',
    });

    expect(frame).toContain('Trash contents unknown');
    expect(frame).toContain('including what you put there yourself');
    expect(frame).toContain('to confirm:');
    expect(frame).not.toContain('0B');
  });

  it('says everything it has to say inside the width it is given', async () => {
    // A line that truncates mid-sentence costs a whole row and withholds the ending, which is
    // exactly where the instruction lives ("…Grant Full Disk Access in System Se…"). Every
    // hint this module can produce is asserted to survive the pane it is rendered into.
    f = await fixture({});
    const root = await unlistableRoot();
    const finders = [
      fakeFinder({ count: { ok: true, stdout: '8' }, sizes: { ok: true, stdout: 'missing value' } }),
      fakeFinder({
        count: { ok: false, stderr: 'execution error: Not authorized … (-1743)' },
      }),
      fakeFinder({ count: { ok: true, stdout: 'missing value' } }),
      fakeFinder({ count: { ok: true, stdout: '200000' } }),
    ];

    for (const finder of finders) {
      const summary = await readTrashSummary({
        roots: [root],
        platform: 'darwin',
        exec: finder.exec,
      });
      expect(confirm(summary)).not.toContain('…');
    }
  });

  it('offers nothing when there is nothing to offer', () => {
    const frame = confirm({ bytes: 0, items: 0, available: false, source: 'unsupported' }, 'empty');

    expect(frame).toContain('could not read the Trash');
    expect(frame).not.toContain('to confirm:');
    expect(frame).not.toContain('enter empties the Trash');
  });

  it('arms on the whole word, and only where an offer exists', () => {
    const unseen: TrashSummary = { bytes: 0, items: 0, available: false, source: 'finder', knownItems: 8 };
    expect(trashConfirmArmed(unseen, 'empt')).toBe(false);
    expect(trashConfirmArmed(unseen, 'empty')).toBe(true);
    expect(trashConfirmArmed({ bytes: 0, items: 0, available: false }, 'empty')).toBe(false);
    expect(trashConfirmArmed({ bytes: 0, items: 0, available: false, source: 'unsupported' }, 'empty')).toBe(false);
  });
});

describe('TrashResult', () => {
  const WIDTH = 72;

  it('reports Finder’s count when the re-read still cannot be measured', () => {
    // The re-read is subject to the same permissions as the first one. "2 items still in
    // there" is the confirmation the user came for even with no byte figure to go with it.
    const frame = frameOf(
      React.createElement(TrashResult, {
        ok: true,
        detail: undefined,
        summary: { bytes: 0, items: 0, available: false, source: 'finder', knownItems: 2 },
        width: WIDTH,
      }),
    );

    expect(frame).toContain('Trash emptied.');
    expect(frame).toContain('Finder counts 2 items in the Trash now');
    expect(frame).not.toContain('0B');
  });

  it('says so when it cannot confirm at all', () => {
    const frame = frameOf(
      React.createElement(TrashResult, {
        ok: false,
        detail: 'macOS did not allow dev-cleaner to control Finder.',
        summary: { bytes: 0, items: 0, available: false, source: 'blind' },
        width: WIDTH,
      }),
    );

    expect(frame).toContain('The Trash was not emptied.');
    expect(frame).toContain('cannot read the Trash to confirm');
    expect(frame).toContain('did not allow');
  });
});

describe('the module cannot act by accident', () => {
  it('has no default export', async () => {
    const module = await import('../src/trash.js');

    expect((module as Record<string, unknown>).default).toBeUndefined();
  });

  it('touches neither the disk nor a subprocess when merely imported', async () => {
    // Importing a module that can irreversibly destroy data must be inert. Proven by giving
    // it mocked filesystem and process facilities and observing that it uses neither.
    vi.resetModules();
    const fsSpies = {
      readdir: vi.fn(async () => []),
      realpath: vi.fn(async (p: string) => p),
    };
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return { ...actual, ...fsSpies };
    });
    spawns.calls.length = 0;

    try {
      await import('../src/trash.js');
      expect(fsSpies.readdir).not.toHaveBeenCalled();
      expect(fsSpies.realpath).not.toHaveBeenCalled();
      expect(spawns.calls).toEqual([]);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
});
