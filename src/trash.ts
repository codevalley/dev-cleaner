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
 * # Three ways of knowing, and one of not knowing
 *
 * On a stock Mac the obvious implementation does not work. `~/.Trash` is protected by TCC:
 * a terminal without Full Disk Access gets `EPERM` from `readdir`, and every process this
 * tool can spawn inherits that refusal — `du` included, and `do shell script` sent *through*
 * Finder included, which was tried and denied. So the direct read is not the common path on
 * the machines this tool is for; it is the lucky one.
 *
 * Finder, however, already holds the entitlement, and it will answer questions about the
 * Trash over Apple events. That is a *different* permission — Automation, not Full Disk
 * Access — asked for with a different prompt, and grantable independently. So there are four
 * states, and `TrashSource` names them:
 *
 * - `filesystem` — the direct read worked. Bytes and items are both exact. Preferred, always
 *   tried first: it is faster and it needs no automation consent.
 * - `finder` — the direct read was denied and Finder answered. Finder always knows the item
 *   count. It reports a *size* only for items it has already measured, which for folders is
 *   essentially never (`physical size of every item of trash` comes back `missing value` for
 *   every directory, and directories are exactly what this tool puts there). So this state
 *   usually carries a trustworthy count and no byte total at all.
 * - `blind` — neither answered. Nothing about the contents is known.
 * - `unsupported` — a platform whose Trash layout this module does not know, and cannot
 *   empty.
 *
 * # Why "we cannot see inside" is still an offer, not a refusal
 *
 * An earlier version treated `available: false` as "offer nothing". On the machine this tool
 * was written for that meant the feature was dead: 107 GB sat in the Trash, still occupying
 * the disk, and the tool — whose entire purpose is reclaiming that space — stopped one step
 * short of the only step that reclaims it, because it could not read a directory macOS does
 * not let it read.
 *
 * The reasoning behind that refusal was sound and is preserved exactly: an **understated byte
 * total** next to a prompt that destroys everything is the one arrangement that must never be
 * rendered. `bytes` is therefore still meaningless unless `available` is true, and callers
 * still must not print it otherwise. But "do not print a number you do not have" is not the
 * same instruction as "do not offer". A prompt that says *we cannot see what is in there, and
 * emptying takes all of it including whatever you put there yourself* is a worse deal for the
 * user than a measured one and an honest one — and it is the deal macOS actually offers.
 *
 * `mayOfferEmpty` is where that line is drawn, in one place, so the difference between "no
 * figure" and "no offer" cannot blur.
 *
 * # Why Finder, and not `rm -rf ~/.Trash/*`
 *
 * The shell one-liner is wrong three ways. It misses the per-volume `.Trashes/<uid>`
 * directories, so it silently leaves behind exactly the space the user asked to reclaim. It
 * bypasses the bookkeeping behind "Put Back", corrupting the state of items it does not
 * delete. And it is an unbounded recursive delete written by us, aimed by a glob, in a tool
 * whose entire reason for existing is that unbounded recursive deletes written casually are
 * how people lose data. Asking the platform to empty its own Trash costs one subprocess and
 * gets all three right. (It also would not work: `rm` is denied `~/.Trash` for the same
 * reason `readdir` is.)
 *
 * # Nothing here runs by accident
 *
 * There is no default export and no side effect at import: the module body only declares
 * constants and functions. Importing it cannot empty anything, cannot spawn anything, and
 * cannot even read the disk. Every effect requires a call.
 *
 * The read path may now spawn `osascript`, which the write path also does — so the two are
 * kept apart by construction. `EMPTY_SCRIPT` is the only string in this codebase that empties
 * anything and is reachable only from `emptyTrash`; the read path can pass nothing but
 * `COUNT_SCRIPT` and `SIZES_SCRIPT`, both of which only interrogate.
 */

import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { dirSize } from './size.js';

/**
 * How dev-cleaner learned what is in the Trash — or why it could not. See the module note;
 * on macOS the answer depends on which of two unrelated permissions the user has granted.
 */
export type TrashSource = 'filesystem' | 'finder' | 'blind' | 'unsupported';

/**
 * What is in the Trash — **all** of it, not this run's contribution. See the module note:
 * the distinction is the whole safety story of this file.
 *
 * When `available` is false the byte total could not be established, and `bytes` and `items`
 * are zero because they are unknown, not because the Trash is empty. Those two states must
 * never be rendered the same way, and `bytes` must not be printed at all in the second.
 *
 * `knownItems` is the one figure that can survive an unmeasurable Trash: Finder will report
 * how many items it holds even when it will not report their size. It is present only when
 * `available` is false and the count is nonetheless trustworthy — when `available` is true,
 * `items` is that count.
 */
export interface TrashSummary {
  bytes: number;
  items: number;
  available: boolean;
  /** How the figures were obtained. Absent on a summary built by hand rather than read. */
  source?: TrashSource;
  /** Finder's item count, when the byte total is unknown but the count is not. */
  knownItems?: number;
  /** The missing permission and where to grant it, in the user's terms. */
  detail?: string;
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
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

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
  /**
   * Subprocess runner for the Finder fallback. Injected so tests can drive Finder's answers —
   * and its refusals — without an Apple event ever leaving the process.
   */
  exec?: TrashExec;
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
 * The read path's entire vocabulary. Both only interrogate: there is no verb in either that
 * moves, deletes or empties anything, which is what keeps "reading cannot destroy" a property
 * of the code rather than of the author's care.
 */
const COUNT_SCRIPT = 'tell application "Finder" to count items in trash';
const SIZES_SCRIPT = 'tell application "Finder" to get physical size of every item of trash';

/**
 * Generous on purpose. Finder blocks until the empty completes, and a Trash holding a few
 * hundred thousand `node_modules` inodes — which is precisely what this tool puts there —
 * takes minutes. A tight timeout would report failure over a successful long empty, which is
 * the worse lie: the user would be told nothing happened while everything did.
 */
const EMPTY_TIMEOUT_MS = 10 * 60_000;

/**
 * The read path gets its own, much shorter budget. It runs while the user waits at a prompt,
 * and its failure mode is benign — an unanswered question degrades to "we cannot see inside",
 * which is a state this module now handles rather than an error. It must also be long enough
 * to cover the automation consent dialog, which blocks `osascript` until the user answers it.
 */
const READ_TIMEOUT_MS = 60_000;

/**
 * Above this many items, do not ask Finder to size them. The reply is one number per item on
 * a single line, so a Trash holding a hundred thousand files would overrun the pipe buffer and
 * turn a fast "we cannot measure this" into a slow one. The count alone is still worth having.
 */
const SIZE_PROBE_LIMIT = 5_000;

/**
 * Finder's own bookkeeping file. Finder does not show it and neither should we: reporting
 * "1 item, 0 B" for a Trash the user sees as empty reads as a bug and teaches them to
 * distrust the count. Only this exact name is excluded — a user may legitimately trash a
 * dotfile, and `.env` is an item like any other.
 */
const FINDER_METADATA = '.DS_Store';

/**
 * The actionable half of a permission failure, and nothing else.
 *
 * Each fits inside the 72 columns the pane is given, indent included, because a hint that
 * truncates mid-sentence is worse than no hint: it costs a line, teaches the user that the
 * tool's own text does not fit, and withholds the ending — which is where the instruction is.
 * The diagnosis belongs in `describeFailure`, on the failure screen, where there is room.
 */
const CANNOT_MEASURE_HINT = 'Full Disk Access would let dev-cleaner show you the size.';
const AUTOMATION_REFUSED_HINT =
  'Automation was refused — grant it, or Full Disk Access, in Settings.';
const NO_ANSWER_HINT = 'Finder did not answer. Grant Full Disk Access in System Settings.';

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
 * Non-macOS returns nothing: see `readTrashSummary`, which reports that as unsupported
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
 * a terminal does not have by default. Unreadable is the *common* outcome, not the exotic
 * one, and it is what sends `readTrashSummary` to Finder.
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

function unknownTrash(source: TrashSource, detail: string): TrashSummary {
  return { bytes: 0, items: 0, available: false, source, detail };
}

/**
 * The production executors: `osascript`, in argv form.
 *
 * `execFile`, never `exec`, so no string is ever handed to a shell — there is nothing here
 * for a shell to reinterpret, and the script text stays a single opaque argument.
 */
function osascriptExec(timeoutMs: number): TrashExec {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            ok: error === null,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
          });
        },
      );
    });
}

const systemExec: TrashExec = osascriptExec(EMPTY_TIMEOUT_MS);
const readExec: TrashExec = osascriptExec(READ_TIMEOUT_MS);

/** macOS denies Apple events to un-consented applications with error -1743. */
function isAutomationDenial(stderr: string): boolean {
  return stderr.includes('-1743') || stderr.toLowerCase().includes('not authorized');
}

/**
 * macOS denies Apple events to un-consented applications with error -1743, which arrives as
 * an opaque line of AppleScript diagnostics. Left raw it looks like a bug in dev-cleaner; the
 * user's actual next step is a checkbox in System Settings, so say that.
 */
function describeFailure(stderr: string): string {
  const detail = stderr.trim();
  if (isAutomationDenial(detail)) {
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
 * Finder's count, as a whole number. Anything else — a refusal, an AppleScript error printed
 * to stdout, an empty reply — is `undefined`, never a zero: "Finder would not say" and "the
 * Trash is empty" are the two states this module exists to keep apart.
 */
function parseCount(stdout: string): number | undefined {
  const text = stdout.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The sum of `physical size of every item of trash`, or `undefined` if any part of the reply
 * is not a number.
 *
 * Finder answers `missing value` for anything whose size it has not already calculated, which
 * is every folder — so this returns `undefined` far more often than it returns a total. That
 * is the correct outcome and not a degraded one: a sum over the items Finder *could* size
 * would be smaller than the truth, and an understated total is the single figure this module
 * will not produce.
 *
 * `expected` is checked against the reply's length for the same reason. The count and the
 * sizes are two separate Apple events, and a Trash that changed between them would otherwise
 * yield a total that belongs to neither reading.
 */
function parseSizes(stdout: string, expected: number): number | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;

  const tokens = text.split(',').map((token) => token.trim());
  if (tokens.length !== expected) return undefined;

  let total = 0;
  for (const token of tokens) {
    // `missing value`, and anything else Finder might say, fails here. AppleScript prints
    // large sizes in exponential form (`1.07374182E+11`), which still begins with a digit and
    // which `Number` reads correctly.
    if (!/^\d/.test(token)) return undefined;
    const value = Number(token);
    if (!Number.isFinite(value) || value < 0) return undefined;
    total += value;
  }
  return total;
}

/**
 * Ask Finder. Reached only when the direct read was denied.
 *
 * Two questions, in order, and the second is skipped unless the first makes it worth asking.
 * Neither can modify anything: see `COUNT_SCRIPT` and `SIZES_SCRIPT`.
 */
async function readViaFinder(exec: TrashExec): Promise<TrashSummary> {
  const counted = await exec('osascript', ['-e', COUNT_SCRIPT]);
  const count = counted.ok ? parseCount(counted.stdout) : undefined;
  if (count === undefined) {
    // Finder refused or answered unintelligibly. Nothing about the contents is known — but
    // the offer to empty survives that, with copy that says so. See the module note.
    const refused = isAutomationDenial(counted.stderr.trim());
    return unknownTrash('blind', refused ? AUTOMATION_REFUSED_HINT : NO_ANSWER_HINT);
  }

  // An empty Trash is the one thing Finder can tell us exactly. Zero items is zero bytes, and
  // that is a real, disclosable total rather than an absence of one.
  if (count === 0) return { bytes: 0, items: 0, available: true, source: 'finder' };

  if (count <= SIZE_PROBE_LIMIT) {
    const sized = await exec('osascript', ['-e', SIZES_SCRIPT]);
    const bytes = sized.ok ? parseSizes(sized.stdout, count) : undefined;
    if (bytes !== undefined) {
      return { bytes, items: count, available: true, source: 'finder' };
    }
  }

  return {
    bytes: 0,
    items: 0,
    available: false,
    source: 'finder',
    knownItems: count,
    detail: CANNOT_MEASURE_HINT,
  };
}

/**
 * How much is in the Trash right now — **the whole Trash**, every trash directory on the
 * machine, everything `emptyTrash` would destroy.
 *
 * ## The shell's obligation
 *
 * Whatever renders an "Empty Trash?" prompt must display *these* figures beside it, and must
 * not display the byte total or item count of the clean that just ran. Emptying does not
 * remove this run's items; it removes everything, including whatever the user put there for
 * reasons that have nothing to do with build artifacts. Showing the run's smaller figure next
 * to a prompt with this larger effect misrepresents the offer even if every individual number
 * on screen is true. The full explanation is in the module note above.
 *
 * When `available` is false the shell must show **no byte figure**: the total could not be
 * established, and `bytes` is zero because it is *unknown*. It may still show `knownItems`
 * when that is present, and — see `mayOfferEmpty` — it may still offer to empty, provided the
 * copy says plainly that the contents are unseen and that emptying takes all of them.
 *
 * ## The order of attempts
 *
 * The direct filesystem read is tried first and preferred: it is exact, it is fast, and it
 * asks the user for nothing. Only when a trash directory answers `EPERM` — the macOS default,
 * not the exception — is Finder asked, which costs an automation consent prompt the first
 * time and may itself be declined.
 *
 * Never throws, and never mutates anything — reading the Trash cannot empty it, and the only
 * scripts this function can run are the two that interrogate.
 */
export async function readTrashSummary(options: TrashSummaryOptions = {}): Promise<TrashSummary> {
  const platform = options.platform ?? process.platform;
  const size = options.size ?? ((target: string) => dirSize(target));

  const roots = options.roots ?? (await defaultTrashRoots(options));
  // No known trash layout for this platform, and nothing here can empty one either.
  if (roots.length === 0) {
    return unknownTrash(
      'unsupported',
      `dev-cleaner does not know how to read or empty the Trash on ${platform}.`,
    );
  }

  let bytes = 0;
  let items = 0;
  let blocked = false;
  for (const root of roots) {
    const reading = await readRoot(root, size);
    // Fail closed on the byte total. One unreadable trash directory means the figure would be
    // smaller than what emptying destroys, and an understated total is the one number that
    // must never appear next to this prompt. The partial sum is abandoned, not reported.
    if (reading.kind === 'unreadable') {
      blocked = true;
      break;
    }
    if (reading.kind === 'absent') continue;
    bytes += reading.bytes;
    items += reading.items;
  }

  if (!blocked) return { bytes, items, available: true, source: 'filesystem' };

  // Finder holds the entitlement this process does not. It is macOS-only, so everywhere else
  // an unreadable trash directory is simply the end of the road.
  if (platform !== 'darwin') {
    return unknownTrash('blind', 'dev-cleaner could not read the Trash on this system.');
  }
  return readViaFinder(options.exec ?? readExec);
}

/**
 * May an "Empty the Trash?" prompt be offered against this summary?
 *
 * The one place the distinction between "no figure" and "no offer" is decided, so the two
 * cannot blur. Three of the four states permit an offer:
 *
 * - measured (`available`) — offer it, captioned with the total;
 * - `finder` or `blind` — offer it, captioned with the truth that the contents are unseen and
 *   that emptying takes every one of them. Refusing here is what made this feature dead on a
 *   stock Mac, and stopping short of the step that reclaims the space is doing half a job;
 * - `unsupported` — no. There is nothing to offer: `emptyTrash` will not run a command on a
 *   platform whose Trash it does not know.
 *
 * A summary with no `source` at all was not produced by this module — it was built by hand, by
 * a caller that said only "unavailable" and nothing about why. That gets the conservative
 * answer, because the reason an offer is defensible above is that the reason is known.
 */
export function mayOfferEmpty(summary: TrashSummary): boolean {
  if (summary.available) return true;
  return summary.source === 'finder' || summary.source === 'blind';
}

/**
 * Empty the Trash. **IRREVERSIBLE, and total.**
 *
 * This destroys everything in every trash directory on the machine — not the items this run
 * put there, everything. Call it only after the user has agreed to that having seen what
 * `readTrashSummary` could establish, and only when `mayOfferEmpty` allowed the offer.
 *
 * Delegates to Finder rather than deleting anything itself, which is what makes it cover the
 * per-volume trashes and leave Finder's own state coherent. See the module note for why the
 * obvious `rm -rf` is not merely inferior but wrong — and, on a stock Mac, not even possible.
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
