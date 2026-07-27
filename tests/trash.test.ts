/**
 * `src/trash.ts` — the disclosure that precedes an irreversible, total destruction.
 *
 * Nothing in this file empties a Trash, and nothing in it can. `node:child_process` is
 * mocked for the whole file, so no subprocess is ever created: the tests assert what
 * dev-cleaner *would* run, which is the only way to pin a command whose real execution is
 * unrecoverable. Every trash directory under test is a temporary fixture.
 *
 * A consequence worth stating, because it makes the byte figures real rather than stubbed:
 * with `execFile` mocked, `du` fails to spawn and `size.ts` falls back to its in-process
 * walker. The sizes measured here come from an actual filesystem.
 *
 * The properties these tests exist to hold down, in order of how much damage their loss
 * would do:
 *
 * 1. An unreadable trash directory reports `available: false`, never a zero. `dirSize` is
 *    best-effort and answers 0 for a directory it cannot read; if that 0 reached the user it
 *    would appear under an "Empty Trash?" prompt as "nothing in there", and they would
 *    approve the destruction of a Trash whose contents were never shown to them. macOS makes
 *    this the *common* path — `~/.Trash` needs Full Disk Access — so it is tested against a
 *    genuinely unreadable directory, not a stub.
 * 2. Unavailable means zero *and* nothing partial. A total smaller than what emptying
 *    destroys is worse than no total.
 * 3. The summary covers the whole Trash: every item, whatever it is, and every per-volume
 *    `.Trashes` directory Finder would empty.
 * 4. Emptying goes through Finder and never through a recursive delete of our own.
 * 5. Reading never empties, and an unsupported platform runs no command at all.
 */

import { chmod, readdir, symlink as fsSymlink } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultTrashRoots,
  emptyTrash,
  readTrashSummary,
  type TrashExec,
} from '../src/trash.js';
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

/** A `TrashExec` that records and never runs anything. */
function recordingExec(outcome: { ok: boolean; stderr?: string }): {
  exec: TrashExec;
  calls: Array<{ command: string; args: readonly string[] }>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const exec: TrashExec = async (command, args) => {
    calls.push({ command, args });
    return { ok: outcome.ok, stderr: outcome.stderr ?? '' };
  };
  return { exec, calls };
}

/** Sizes stubbed per path, for tests whose point is the arithmetic rather than the walker. */
function fixedSize(byPath: Record<string, number>): (target: string) => Promise<number> {
  return async (target) => byPath[target] ?? 0;
}

let f: Fixture;
/** Directories made unreadable by a test, restored before cleanup can trip over them. */
let locked: string[] = [];

beforeEach(() => {
  spawns.calls.length = 0;
  spawns.result.error = null;
  spawns.result.stdout = '';
  spawns.result.stderr = '';
  locked = [];
});

afterEach(async () => {
  for (const target of locked) await chmod(target, 0o700).catch(() => {});
  await f?.cleanup();
});

const RUNNING_AS_ROOT = process.getuid?.() === 0;

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

    expect(summary).toEqual({ bytes: 8_000, items: 2, available: true });
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
    'reports unavailable when a trash directory cannot be read',
    async () => {
      // The exact macOS default: a terminal without Full Disk Access gets EPERM on ~/.Trash.
      // `dirSize` would answer 0 for this directory without complaint. Reporting that 0 would
      // put "Trash: 0 B" above a prompt that destroys everything in it.
      f = await fixture({ 'trash/secret': dir() });
      const root = f.path('trash');
      await chmod(root, 0o000);
      locked.push(root);

      // Precondition: prove the directory really is unreadable, so this can never pass by
      // accident on a filesystem or user that ignores the mode.
      await expect(readdir(root)).rejects.toThrow();

      const summary = await readTrashSummary({ roots: [root], platform: 'darwin' });

      expect(summary.available).toBe(false);
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

    const summary = await readTrashSummary({
      roots: [readable, lockedRoot],
      platform: 'darwin',
      size: fixedSize({ [readable]: 9_000_000_000 }),
    });

    expect(summary).toEqual({ bytes: 0, items: 0, available: false });
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

    expect(summary).toEqual({ bytes: 1_500, items: 1, available: true });
  });

  it('reports unavailable where the platform has no known Trash layout', async () => {
    f = await fixture({ 'trash/a': dir() });

    const summary = await readTrashSummary({ platform: 'win32' });

    expect(summary).toEqual({ bytes: 0, items: 0, available: false });
  });
});

describe('readTrashSummary: reading cannot destroy', () => {
  it('never asks to run osascript', async () => {
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
    // wrong. The command is pinned so it cannot quietly become one.
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
