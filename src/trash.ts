/**
 * The Trash itself: how much is sitting in it, and — only on an explicit instruction —
 * emptying it.
 *
 * dev-cleaner moves things to the Trash rather than unlinking them (invariant 4), so a run
 * that reports "18.1G trashed" has not yet handed the user back a single byte. Invariant 8
 * closes that gap: disclose the total now sitting in the Trash, and offer to empty it.
 * This module is that disclosure and that offer, and nothing else.
 *
 * # Emptying is IRREVERSIBLE
 *
 * `emptyTrash()` destroys the Trash's entire contents. There is no undo, no Finder "Put
 * Back", and no second confirmation from this module — by the time it is called the
 * decision has already been made somewhere above. Every other destructive path in this
 * codebase is recoverable precisely *because* it ends in the Trash; this one is where that
 * recoverability is spent.
 *
 * # It is not "our" Trash, and there is no way to make it ours
 *
 * The dangerous moment is the one right after a clean, when the screen says "18.1G is now
 * in the Trash" and a prompt appears beneath it. That juxtaposition implies the prompt
 * empties *this run's* 18.1G. It does not, and it cannot: once a directory has been moved
 * to the Trash it is an ordinary item in there, indistinguishable from the holiday photos
 * the user dragged in last March and the document they deleted yesterday. `trash@9` hands
 * back no handle, macOS records no provenance we may read, and even matching by name and
 * timestamp would be a guess that fails silently in the direction that destroys more.
 *
 * So this module refuses to describe a subset. `readTrashSummary` measures the **whole**
 * Trash — every trash directory Finder would empty — and the shell is required to show
 * *that* total and *that* item count next to the prompt, never the figures from the run
 * that just finished. The user must be able to see the holiday photos in the number before
 * they agree to destroy them. Showing this run's bytes beside an "Empty Trash?" prompt
 * would be a lie of arrangement, which is the kind this tool is least able to afford.
 *
 * That requirement is also why `available: false` zeroes the counts rather than reporting a
 * partial one: an understated total under a prompt that empties everything is worse than no
 * total at all. `available: false` means *do not show a figure and do not offer to empty*.
 *
 * # Why Finder, and not `rm -rf ~/.Trash/*`
 *
 * The shell one-liner is wrong three ways. It misses the per-volume `.Trashes/<uid>`
 * directories, so it silently leaves behind exactly the space the user asked to reclaim. It
 * bypasses the bookkeeping behind "Put Back", corrupting the state of items it does not
 * delete. And it is an unbounded recursive delete written by us, aimed by a glob, in a tool
 * whose entire reason for existing is that unbounded recursive deletes written casually are
 * how people lose data. Asking the platform to empty its own Trash costs one subprocess and
 * gets all three right.
 *
 * # Nothing here runs by accident
 *
 * There is no default export and no side effect at import: the module body only declares
 * constants and functions. Importing it cannot empty anything, cannot spawn anything, and
 * cannot even read the disk. Every effect requires a call.
 */

import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { dirSize } from './size.js';

/**
 * What is in the Trash — **all** of it, not this run's contribution. See the module note:
 * the distinction is the whole safety story of this file.
 *
 * When `available` is false the tool could not establish the total, and `bytes` and `items`
 * are zero because they are unknown, not because the Trash is empty. Those two states must
 * never be rendered the same way.
 */
export interface TrashSummary {
  bytes: number;
  items: number;
  available: boolean;
}

/** The outcome of an empty request. `detail` carries the platform's own words on failure. */
export interface EmptyTrashResult {
  ok: boolean;
  detail?: string;
}

/**
 * A subprocess, reduced to what this module needs. Injected so tests can prove what command
 * would have been run without a machine anywhere ever running it.
 */
export type TrashExec = (
  command: string,
  args: readonly string[],
) => Promise<{ ok: boolean; stderr: string }>;

export interface TrashRootOptions {
  platform?: NodeJS.Platform;
  /** The user's home directory. */
  home?: string;
  /** The user's numeric id — per-volume trash directories are namespaced by it. */
  uid?: number;
  /** Where secondary and removable volumes are mounted. */
  volumesDir?: string;
}

export interface TrashSummaryOptions extends TrashRootOptions {
  /** Trash directories to measure. Defaults to every one Finder would empty. */
  roots?: readonly string[];
  /** Byte sizer, for tests that need a deterministic total. */
  size?: (target: string) => Promise<number>;
}

export interface EmptyTrashOptions {
  platform?: NodeJS.Platform;
  exec?: TrashExec;
}

/**
 * Finder's own vocabulary for the operation. Kept as a lone constant so there is exactly one
 * string in this codebase that empties the Trash, and it is greppable.
 */
const EMPTY_SCRIPT = 'tell application "Finder" to empty trash';

/**
 * Generous on purpose. Finder blocks until the empty completes, and a Trash holding a few
 * hundred thousand `node_modules` inodes — which is precisely what this tool puts there —
 * takes minutes. A tight timeout would report failure over a successful long empty, which is
 * the worse lie: the user would be told nothing happened while everything did.
 */
const EMPTY_TIMEOUT_MS = 10 * 60_000;

/**
 * Finder's own bookkeeping file. Finder does not show it and neither should we: reporting
 * "1 item, 0 B" for a Trash the user sees as empty reads as a bug and teaches them to
 * distrust the count. Only this exact name is excluded — a user may legitimately trash a
 * dotfile, and `.env` is an item like any other.
 */
const FINDER_METADATA = '.DS_Store';

/** Errors that mean "this trash directory is not here", which is not the same as a failure. */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function resolveOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

/**
 * Every trash directory on this machine, in the sense that matters: every one that
 * `emptyTrash` would destroy. The home Trash is only the first of them — anything trashed
 * while it lived on an external or secondary volume sits in `<volume>/.Trashes/<uid>`, and a
 * summary that omitted those would under-disclose exactly the bytes the user is about to
 * lose.
 *
 * Deduplicated by realpath because a volume can be reachable by more than one path (the boot
 * volume commonly appears under `/Volumes` as well), and the same directory counted twice
 * would overstate the total.
 *
 * Non-macOS returns nothing: see `readTrashSummary`, which reports that as unavailable
 * rather than guessing at another platform's layout.
 */
export async function defaultTrashRoots(options: TrashRootOptions = {}): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return [];

  const home = options.home ?? os.homedir();
  const uid = options.uid ?? process.getuid?.();
  const volumesDir = options.volumesDir ?? '/Volumes';

  const candidates: string[] = [path.join(home, '.Trash')];

  if (uid !== undefined) {
    let volumes: Dirent[] = [];
    try {
      volumes = await readdir(volumesDir, { withFileTypes: true });
    } catch {
      // No /Volumes, or unreadable. The home Trash is still worth reporting.
      volumes = [];
    }
    for (const volume of volumes) {
      // Mount points are directories; a symlinked one still leads to a real per-volume
      // trash, and including it is the direction that discloses more. The realpath dedupe
      // below is what keeps that from double counting.
      if (!volume.isDirectory() && !volume.isSymbolicLink()) continue;
      candidates.push(path.join(volumesDir, volume.name, '.Trashes', String(uid)));
    }
  }

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    const key = await resolveOrSelf(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate);
  }
  return roots;
}

type RootReading =
  | { kind: 'counted'; bytes: number; items: number }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/**
 * `readdir` first, and the count comes from it rather than from the sizer.
 *
 * That ordering is the load-bearing part. `dirSize` is best-effort by contract: handed an
 * unreadable directory it returns 0 rather than throwing, because a scan of a thousand
 * candidates must not die on one of them. Here that same kindness would be a disaster — a
 * Trash we lack permission to read would size as 0 and be reported as empty, under a prompt
 * that empties it. The explicit `readdir` is what turns "cannot read" into a refusal instead
 * of a zero.
 *
 * This is not a hypothetical: on macOS, reading `~/.Trash` requires Full Disk Access, which
 * a terminal does not have by default. Unavailable is the *common* outcome, not the exotic
 * one, and it has to be a first-class answer rather than an error path.
 */
async function readRoot(
  root: string,
  size: (target: string) => Promise<number>,
): Promise<RootReading> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return isAbsent(error) ? { kind: 'absent' } : { kind: 'unreadable' };
  }

  const items = entries.filter((entry) => entry.name !== FINDER_METADATA).length;
  // One measurement of the whole directory rather than one per entry: a Trash holding a few
  // thousand loose files would otherwise cost a few thousand subprocesses. The directory's
  // own allocation rides along, which on APFS is zero and everywhere else is noise against a
  // figure reported in gigabytes.
  const bytes = await size(root);
  return { kind: 'counted', bytes, items };
}

function unavailable(): TrashSummary {
  return { bytes: 0, items: 0, available: false };
}

/**
 * How much is in the Trash right now — **the whole Trash**, every trash directory on the
 * machine, everything `emptyTrash` would destroy.
 *
 * ## The shell's obligation
 *
 * Whatever renders an "Empty Trash?" prompt must display *these* two numbers beside it, and
 * must not display the byte total or item count of the clean that just ran. Emptying does
 * not remove this run's items; it removes everything, including whatever the user put there
 * for reasons that have nothing to do with build artifacts. Showing the run's smaller figure
 * next to a prompt with this larger effect misrepresents the offer even if every individual
 * number on screen is true. The full explanation is in the module note above.
 *
 * When `available` is false the shell must show no figure and offer no empty: the total
 * could not be established, and `bytes`/`items` are zero because they are *unknown*.
 *
 * Never throws, and never mutates anything — reading the Trash cannot empty it, and this
 * function runs no subprocess capable of doing so.
 */
export async function readTrashSummary(options: TrashSummaryOptions = {}): Promise<TrashSummary> {
  const platform = options.platform ?? process.platform;
  const size = options.size ?? ((target: string) => dirSize(target));

  const roots = options.roots ?? (await defaultTrashRoots(options));
  // No known trash layout for this platform, so no honest total to report.
  if (roots.length === 0) return unavailable();

  let bytes = 0;
  let items = 0;
  for (const root of roots) {
    const reading = await readRoot(root, size);
    // Fail closed. One unreadable trash directory means the reported total would be smaller
    // than what emptying destroys, and an understated total is the one number that must
    // never appear next to this prompt.
    if (reading.kind === 'unreadable') return unavailable();
    if (reading.kind === 'absent') continue;
    bytes += reading.bytes;
    items += reading.items;
  }

  return { bytes, items, available: true };
}

/**
 * The production executor: `osascript`, in argv form.
 *
 * `execFile`, never `exec`, so no string is ever handed to a shell — there is nothing here
 * for a shell to reinterpret, and the script text stays a single opaque argument.
 */
const systemExec: TrashExec = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: 'utf8',
        timeout: EMPTY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        resolve({ ok: error === null, stderr: typeof stderr === 'string' ? stderr : '' });
      },
    );
  });

/**
 * macOS denies Apple events to un-consented applications with error -1743, which arrives as
 * an opaque line of AppleScript diagnostics. Left raw it looks like a bug in dev-cleaner; the
 * user's actual next step is a checkbox in System Settings, so say that.
 */
function describeFailure(stderr: string): string {
  const detail = stderr.trim();
  if (detail.includes('-1743') || detail.toLowerCase().includes('not authorized')) {
    return (
      'macOS did not allow dev-cleaner to control Finder. ' +
      'Grant it under System Settings > Privacy & Security > Automation, ' +
      'or empty the Trash from Finder. ' +
      (detail.length > 0 ? `(${detail})` : '')
    ).trim();
  }
  return detail.length > 0 ? detail : 'osascript failed without reporting a reason.';
}

/**
 * Empty the Trash. **IRREVERSIBLE, and total.**
 *
 * This destroys everything in every trash directory on the machine — not the items this run
 * put there, everything. Call it only after the user has agreed to that having seen
 * `readTrashSummary`'s figures, and only when that summary reported `available: true`; an
 * empty offered without a disclosed total is an offer the user cannot evaluate.
 *
 * Delegates to Finder rather than deleting anything itself, which is what makes it cover the
 * per-volume trashes and leave Finder's own state coherent. See the module note for why the
 * obvious `rm -rf` is not merely inferior but wrong.
 *
 * Returns `ok: false` rather than throwing on every failure, including a platform where this
 * is unsupported — where it also runs **no command at all**, since the same request means
 * something different, or nothing, elsewhere.
 *
 * A failure is not proof that nothing happened. Finder may have emptied part of the Trash
 * before erroring, and a timeout on a very large empty is more likely to mean "still working"
 * than "failed". Callers must re-read `readTrashSummary` rather than assume either outcome.
 */
export async function emptyTrash(options: EmptyTrashOptions = {}): Promise<EmptyTrashResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false,
      detail: `Emptying the Trash is not supported on ${platform}; use the desktop's own Trash.`,
    };
  }

  const exec = options.exec ?? systemExec;
  const result = await exec('osascript', ['-e', EMPTY_SCRIPT]);
  if (result.ok) return { ok: true };
  return { ok: false, detail: describeFailure(result.stderr) };
}
