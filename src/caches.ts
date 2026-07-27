/**
 * The global cache table: the tool-managed caches that live *outside* any project root.
 *
 * On the reference machine these hold ~32 GB, so they are worth offering — but they are
 * also the one part of the tool that names absolute paths of its own rather than deriving
 * them from a walk. Two rules follow from that, and both are enforced here:
 *
 * 1. **Resolution is a pure function of a `CacheEnv`.** Nothing in this module reads
 *    `process.*` except `currentCacheEnv`, so the macOS, Linux and Windows tables can each
 *    be tested from any host. A table that can only be exercised on the platform it
 *    describes is a table that is wrong on the other two.
 * 2. **A cache that is not on this machine is omitted, never listed as zero.** A row
 *    reading "0B" invites the user to select a path the tool then cannot explain, and an
 *    entry that survives to `clean.ts` without existing is noise in the outcome list.
 *
 * `~/Library/Developer/CoreSimulator` as a whole is deliberately *not* in the table: it
 * holds downloaded runtimes and device state, which are not regenerable build output.
 * Only its `Caches` subdirectory is offered (spec: "Global caches").
 */

import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { dirSize } from './size.js';
import type { CacheBlock, CacheEntry, Category } from './types.js';

export interface CacheEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

/**
 * What the caller knows about the run that the table cannot work out for itself.
 *
 * Both fields exist so the store row can be described *truthfully*, which is a property of
 * the run rather than of the disk layout: what the active preset will actually trash, and
 * whether anything still hardlinks into the store.
 */
export interface CacheListOptions {
  /**
   * The categories the active preset cleans — `categoriesForPreset(preset)`. Used only to
   * word the store's note. Under `recommended` the `deps` category is excluded, so no
   * `node_modules` is ever trashed; a note that says "those are trashed first" is then
   * describing `aggressive`, a preset that is not running.
   *
   * Omitted when the caller has no preset to speak for, in which case the note states the
   * fact and claims nothing about what the run will do.
   */
  categories?: ReadonlySet<Category> | undefined;
  /**
   * The incoming-hardlink probe. Defaults to `storeHasIncomingHardlinks` — the real one,
   * asking the real filesystem. Injected by tests that need an answer without building a
   * hardlinked store on disk.
   */
  probeStore?: ((storePath: string) => Promise<boolean>) | undefined;
  /**
   * How many `node_modules` the scan just found on disk, threaded in by `scan.ts`.
   *
   * The probe answers *whether* the store is still held; this answers *how much there is to
   * do about it*. "A node_modules still links into it" tells a user which rule fired and
   * nothing they can act on — they cannot picture it, cannot estimate the work, and the one
   * report of this refusal from a real session was a question ("why?"), which is what a
   * refusal nobody can act on always produces.
   *
   * Attributed to the scan wherever it is printed, never asserted as a machine-wide census:
   * the probe's fact is machine-wide (some file under the store has `st_nlink > 1`, wherever
   * its other name lives) and this count is scoped to the roots that were walked. The two
   * are stated side by side rather than merged into one claim neither can support.
   *
   * Omitted by callers with no scan to speak for. Zero reads the same as omitted — a store
   * demonstrably still linked from *somewhere* is not explained by printing "0".
   */
  nodeModulesFound?: number | undefined;
}

/** A table row before it is checked against the disk: everything but `bytes`. */
interface CacheCandidate {
  id: string;
  label: string;
  path: string;
  note: string;
}

/**
 * An environment variable is honoured only when it names an absolute path. Empty is
 * plainly unset; relative would resolve against the process's cwd, quietly turning
 * `CARGO_HOME=vendor` into a delete target under whatever directory the tool was launched
 * from. Falling back to the documented default is the fail-closed direction.
 */
function absoluteFromEnv(env: CacheEnv, key: string): string | undefined {
  const value = env.env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) return undefined;
  return trimmed;
}

const cargoHome = (env: CacheEnv): string =>
  absoluteFromEnv(env, 'CARGO_HOME') ?? path.join(env.home, '.cargo');

const xdgCacheHome = (env: CacheEnv): string =>
  absoluteFromEnv(env, 'XDG_CACHE_HOME') ?? path.join(env.home, '.cache');

/** pnpm's store lives under the XDG *data* dir on Linux, not the cache dir. */
const xdgDataHome = (env: CacheEnv): string =>
  absoluteFromEnv(env, 'XDG_DATA_HOME') ?? path.join(env.home, '.local', 'share');

const localAppData = (env: CacheEnv): string =>
  absoluteFromEnv(env, 'LOCALAPPDATA') ?? path.join(env.home, 'AppData', 'Local');

const NOTE = {
  // Deliberately just the *fact*. What follows the dash is decided per run by `storeNote`,
  // because the rest of the sentence depends on the preset and on the disk, and a constant
  // cannot be right about either.
  pnpm: 'hardlink target for project node_modules',
  npm: 'safe — packages are re-downloaded on demand',
  gradle: 're-downloaded on next build',
  cargo: 're-downloaded on next build',
  derivedData: 'safe — regenerated on next build',
  coreSimulator: 'caches subdirectory only — runtimes and devices are untouched',
  pub: 're-downloaded on next build',
  yarn: 'safe — packages are re-downloaded on demand',
  cocoapods: 'safe — re-downloaded on next pod install',
} as const;

/**
 * The table, in the order the spec lists it. Keyed on platform rather than on what happens
 * to be present: a macOS-only cache is not offered on Linux even if a directory of that
 * name exists there.
 */
function cacheTable(env: CacheEnv): CacheCandidate[] {
  const { home } = env;

  if (env.platform === 'darwin') {
    return [
      { id: 'pnpm-store', label: 'pnpm store', path: path.join(home, 'Library', 'pnpm', 'store'), note: NOTE.pnpm },
      { id: 'npm-cache', label: 'npm cache', path: path.join(home, '.npm', '_cacache'), note: NOTE.npm },
      { id: 'gradle', label: 'Gradle caches', path: path.join(home, '.gradle', 'caches'), note: NOTE.gradle },
      { id: 'cargo-registry', label: 'Cargo registry', path: path.join(cargoHome(env), 'registry'), note: NOTE.cargo },
      {
        id: 'xcode-deriveddata',
        label: 'Xcode DerivedData',
        path: path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
        note: NOTE.derivedData,
      },
      {
        id: 'coresimulator-caches',
        // Never `.../CoreSimulator` itself — that holds downloaded runtimes.
        label: 'CoreSimulator caches',
        path: path.join(home, 'Library', 'Developer', 'CoreSimulator', 'Caches'),
        note: NOTE.coreSimulator,
      },
      { id: 'pub-cache', label: 'pub cache', path: path.join(home, '.pub-cache'), note: NOTE.pub },
      { id: 'yarn', label: 'Yarn cache', path: path.join(home, 'Library', 'Caches', 'Yarn'), note: NOTE.yarn },
      {
        id: 'cocoapods',
        label: 'CocoaPods cache',
        path: path.join(home, 'Library', 'Caches', 'CocoaPods'),
        note: NOTE.cocoapods,
      },
    ];
  }

  if (env.platform === 'win32') {
    const local = localAppData(env);
    return [
      { id: 'pnpm-store', label: 'pnpm store', path: path.join(local, 'pnpm', 'store'), note: NOTE.pnpm },
      { id: 'npm-cache', label: 'npm cache', path: path.join(local, 'npm-cache'), note: NOTE.npm },
      { id: 'gradle', label: 'Gradle caches', path: path.join(home, '.gradle', 'caches'), note: NOTE.gradle },
      { id: 'cargo-registry', label: 'Cargo registry', path: path.join(cargoHome(env), 'registry'), note: NOTE.cargo },
      { id: 'pub-cache', label: 'pub cache', path: path.join(local, 'Pub', 'Cache'), note: NOTE.pub },
      { id: 'yarn', label: 'Yarn cache', path: path.join(local, 'Yarn', 'Cache'), note: NOTE.yarn },
    ];
  }

  // Linux and the other POSIX platforms. Falling through to this table rather than
  // returning nothing keeps an unrecognised `process.platform` useful instead of blank.
  return [
    { id: 'pnpm-store', label: 'pnpm store', path: path.join(xdgDataHome(env), 'pnpm', 'store'), note: NOTE.pnpm },
    { id: 'npm-cache', label: 'npm cache', path: path.join(home, '.npm', '_cacache'), note: NOTE.npm },
    { id: 'gradle', label: 'Gradle caches', path: path.join(home, '.gradle', 'caches'), note: NOTE.gradle },
    { id: 'cargo-registry', label: 'Cargo registry', path: path.join(cargoHome(env), 'registry'), note: NOTE.cargo },
    { id: 'pub-cache', label: 'pub cache', path: path.join(home, '.pub-cache'), note: NOTE.pub },
    { id: 'yarn', label: 'Yarn cache', path: path.join(xdgCacheHome(env), 'yarn'), note: NOTE.yarn },
  ];
}

/**
 * `lstat`, not `stat`: a symlinked cache is reported as absent. Invariant 2 forbids
 * following links, so `clean.ts` would refuse such a target anyway — listing it would only
 * offer the user a row that cannot be acted on.
 */
async function isRealDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sizing is best-effort, exactly as in `scan.ts`: a cache that exists but cannot be
 * measured is still a cache, and under-stating its size is the harmless direction.
 */
async function sizeOf(target: string): Promise<number> {
  try {
    const bytes = await dirSize(target);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  } catch {
    return 0;
  }
}

/**
 * The one row in the table that is a hardlink *farm* rather than a download cache: its
 * files are the very inodes project `node_modules` point at. Every other cache can be
 * deleted with no reference to anything outside itself.
 *
 * Matched by id, which is safe *here* in a way it is not in `cli.ts` or `clean.ts`: this
 * module authors the id, so the two cannot drift apart. The downstream guards match on id
 * *or* path shape precisely because they receive an entry they did not construct.
 */
const STORE_ID = 'pnpm-store';

/**
 * How many directory entries the probe below will look at before giving up. A store it
 * cannot finish reading is a store it cannot clear, so exhausting this budget reports the
 * store as referenced — the cost of the bound is a missed cleanup, never an orphaned link.
 */
const STORE_PROBE_BUDGET = 200_000;

/**
 * True when anything on this machine still hardlinks into `storePath` — or when that
 * question could not be answered, which counts the same.
 *
 * **Why the filesystem is asked instead of the scan.** No project may still reference the
 * store when it is pruned (invariant 5). What the *scan* saw cannot establish that: `cd
 * ~/work/api && dev-cleaner .` finds one project, and `~/work/web`, `~/dev/*` and every
 * other pnpm project on the machine still hardlink into the same store. Scan scope cannot
 * settle a machine-wide fact. `st_nlink` can: a store file with more than one link *is* a
 * file some other directory entry still points at, wherever on the volume that entry lives.
 *
 * **Why it is cheap.** The question is existential — does *any* file under the store have
 * more than one link — so the walk stops at the first one it finds. On a real 7.5 GB store
 * that is the first file it stats, which is why this can run during the scan rather than
 * only at the deletion boundary. It is the equivalent of `find <store> -links +1 -print
 * -quit`, and it must stay that way: a version that collected every link count before
 * deciding would be a full second walk of the largest directory on the disk.
 *
 * **Why it runs before anything is trashed.** Trashing is a rename (invariant 4), so a
 * `node_modules` moved to the Trash keeps its links into the store. There is no later
 * moment at which the count improves, and a store whose only references belong to
 * `node_modules` trashed by this same run stays referenced, on purpose: those directories
 * are still on disk until the Trash is emptied (invariant 8).
 *
 * Every uncertainty resolves to `true`: an unreadable directory, a vanished store, a
 * symlink inside it (a store is a flat farm of regular files; a link means this is not the
 * shape the probe knows how to clear), or a budget that ran out. The cost of a false `true`
 * is a store that is not pruned. The cost of a false `false` is the harm invariant 5 exists
 * to prevent.
 */
export async function storeHasIncomingHardlinks(
  storePath: string,
  budget: number = STORE_PROBE_BUDGET,
): Promise<boolean> {
  let remaining = budget;
  const pending: string[] = [storePath];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return true;
    }

    for (const entry of entries) {
      if (remaining <= 0) return true;
      remaining -= 1;

      const child = path.join(directory, entry.name);
      // Never traversed, never resolved: a symlink is not a hardlink, and following one
      // would walk out of the store entirely (invariant 2).
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        // `lstat`, not `stat`: the entry is already known not to be a link, and the count
        // wanted is the one belonging to this inode. The `return` is the early exit — one
        // hit is the whole answer, so nothing below this file is ever looked at.
        if ((await lstat(child)).nlink > 1) return true;
      } catch {
        return true;
      }
    }
  }

  return false;
}

/**
 * The scan's `node_modules` count, when it is one worth stating.
 *
 * Zero and a missing count collapse to the same thing on purpose. A store the probe reports
 * as held is held by *something*, and printing "0 node_modules" beside it would state a
 * contradiction — the honest reading of a zero is "nothing in the roots I walked", which the
 * uncounted wording already says.
 */
function countedNodeModules(found: number | undefined): number | undefined {
  if (found === undefined || !Number.isFinite(found) || found < 1) return undefined;
  return Math.floor(found);
}

/**
 * Why the store cannot be pruned on this run. Worded as the machine-wide fact it is, since
 * that is what a user has to act on: the fix is to remove the `node_modules` elsewhere, not
 * to change anything about this run.
 */
const STORE_BLOCKED_CAUSE =
  'node_modules elsewhere on this machine still hardlink into it (or it could not be ' +
  'fully checked), so pruning it would orphan those links';

/**
 * The half the refusal was missing: what to do about it.
 *
 * The sequence is not obvious and the interface had never stated it. Cleaning `node_modules`
 * is *not* sufficient on its own, because this tool trashes rather than deletes (invariant
 * 4) and a trashed directory keeps every hardlink it had — the files are in the Trash, still
 * pointing at the same store inodes. So emptying the Trash is a step, not an afterthought,
 * and the store cannot be pruned until it has happened.
 */
const STORE_BLOCKED_FIX =
  'clean node_modules, then empty the Trash — a trashed node_modules keeps its hardlinks ' +
  '— and the store can be pruned on the next run';

function storeBlockedReason(found: number | undefined): string {
  const counted = countedNodeModules(found);
  const cause =
    counted === undefined
      ? STORE_BLOCKED_CAUSE
      : `${STORE_BLOCKED_CAUSE} (${counted} node_modules found in this scan)`;
  return `${cause}; ${STORE_BLOCKED_FIX}`;
}

/**
 * The rest of the store's note, which is a claim about *this run* and so cannot be a
 * constant. The previous fixed string — "those are trashed first" — described `aggressive`
 * and was simply false under the default preset, where `deps` is excluded and no
 * `node_modules` is trashed at all.
 */
function storeNote(
  referenced: boolean,
  trashesDeps: boolean | undefined,
  found: number | undefined,
): string {
  if (!referenced) return `${NOTE.pnpm} — nothing on this machine still links into it`;

  const counted = countedNodeModules(found);
  // Parenthesised rather than joined with a second dash: the clause after the dash is the
  // claim about the run, and a sentence with two dashes reads as two claims of equal rank.
  const head = counted === undefined ? NOTE.pnpm : `${NOTE.pnpm} (${counted} found in this scan)`;

  if (trashesDeps === true) {
    return `${head} — this preset trashes those first, but trashing keeps their hardlinks, so the store stays until you empty the Trash`;
  }
  if (trashesDeps === false) {
    return `${head} — this preset does not trash node_modules, so the store stays`;
  }
  return `${head} — some still link into it, so the store stays`;
}

/** The store row's note and, when it cannot be pruned, the reason it cannot. */
async function describeStore(
  storePath: string,
  options: CacheListOptions,
): Promise<{ note: string; blocked?: CacheBlock }> {
  const probe = options.probeStore ?? storeHasIncomingHardlinks;

  let referenced = true;
  try {
    referenced = await probe(storePath);
  } catch {
    // Same direction as the probe's own failures: unanswerable is not the same as clear.
    referenced = true;
  }

  const note = storeNote(referenced, options.categories?.has('deps'), options.nodeModulesFound);
  return referenced
    ? { note, blocked: { reason: storeBlockedReason(options.nodeModulesFound) } }
    : { note };
}

/** The environment of the running process, in the shape `listCaches` consumes. */
export function currentCacheEnv(): CacheEnv {
  const env = process.env;
  const fromEnv = process.platform === 'win32' ? env['USERPROFILE'] : env['HOME'];
  const home =
    fromEnv !== undefined && fromEnv.trim().length > 0 && path.isAbsolute(fromEnv.trim())
      ? fromEnv.trim()
      : os.homedir();
  return { platform: process.platform, home, env };
}

/**
 * The caches present on this machine, largest-first ordering left to the UI. Entries are
 * unique by path: an override such as `CARGO_HOME=$HOME/.cargo` must not produce the same
 * directory twice, since the UI keys selection on `id` and would then offer two rows for
 * one deletion.
 *
 * The package store is additionally *screened* here rather than only at the deletion
 * boundary. Doing it upstream is what lets the default selection, the report's total and
 * the interface all say the same thing `clean.ts` will do — see `CacheBlock`.
 */
export async function listCaches(
  env: CacheEnv,
  options: CacheListOptions = {},
): Promise<CacheEntry[]> {
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  const candidates: CacheCandidate[] = [];

  for (const candidate of cacheTable(env)) {
    if (seenPaths.has(candidate.path) || seenIds.has(candidate.id)) continue;
    seenPaths.add(candidate.path);
    seenIds.add(candidate.id);
    candidates.push(candidate);
  }

  const present = (
    await Promise.all(
      candidates.map(async (candidate) => ((await isRealDirectory(candidate.path)) ? candidate : undefined)),
    )
  ).filter((candidate): candidate is CacheCandidate => candidate !== undefined);

  return Promise.all(
    present.map(async (candidate): Promise<CacheEntry> => {
      const bytes = await sizeOf(candidate.path);
      // Only the store is probed. Every other cache is self-contained, and walking a
      // 20 GB Gradle cache to learn nothing would make the scan slower for no answer.
      if (candidate.id !== STORE_ID) return { ...candidate, bytes };

      const { note, blocked } = await describeStore(candidate.path, options);
      // `blocked` is left absent rather than set to `undefined`, so `'blocked' in entry`
      // reads truthfully — the same rule `scan.ts` follows for `project.git`.
      return blocked === undefined
        ? { ...candidate, bytes, note }
        : { ...candidate, bytes, note, blocked };
    }),
  );
}
