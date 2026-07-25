/**
 * Directory sizing: how many bytes a candidate would actually give back.
 *
 * Two paths compute the same number. `du -sk` is one subprocess for a whole subtree and
 * is dramatically faster than anything in-process on a large tree; a concurrent Node
 * walker covers the platforms and situations where `du` is not there (Windows) or refuses
 * to run. `dirSize` picks the fast path and falls back silently, so callers never care
 * which ran — but the two must not disagree, and `tests/size.test.ts` pins them to the
 * same fixture. `duSize` and `walkSize` are exported for that test alone; every other
 * module calls `dirSize`.
 *
 * **The number is disk usage, not apparent size.** `du` reports allocated blocks, so the
 * walker sums `blocks * 512` to match it, counts a hardlinked file once (`du` does, and a
 * pnpm-hardlinked `node_modules` would otherwise report several times the space it really
 * occupies), and counts directories and symlinks by their own allocation. Summing
 * `stat.size` instead would have been the more obvious walker, and would have disagreed
 * with `du` on every tree containing a small file: 5 bytes of content occupy a 4 KiB
 * block. `du --apparent-size` is not an option — BSD `du`, which is what macOS ships and
 * what the reference machine runs, has no such flag.
 *
 * **Neither path follows a symbolic link** (spec invariant 2). `du` without `-L` does not
 * descend links; the walker uses `lstat` and never `stat`. A link handed to `dirSize`
 * directly measures 0 rather than whatever it points at, which is what keeps
 * `~/Library/pnpm -> /` from reporting the whole volume as reclaimable.
 */

import { execFile } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SizeOptions {
  concurrency?: number;
}

/**
 * Sizing is IO-bound, so a little over-subscription helps and a lot does not. The floor of
 * 4 keeps a single-core CI box from serialising an entire scan; the cap of 16 keeps a
 * 128-thread workstation from opening enough concurrent directory reads to starve the
 * TUI's own event loop.
 */
export function defaultConcurrency(): number {
  const cores = os.availableParallelism();
  if (!Number.isFinite(cores)) return 4;
  return Math.min(16, Math.max(4, Math.floor(cores)));
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return defaultConcurrency();
  return Math.max(1, Math.floor(value));
}

/**
 * `stat.blocks` is a POSIX field; Node reports 0 for it on Windows, where `du` does not
 * exist either and the walker is the only path. Falling back to `stat.size` there keeps
 * Windows from reporting every tree as empty, but the fallback is deliberately confined to
 * that platform: on POSIX a `blocks` of 0 is the truth about a sparse file, and `du` would
 * report the same 0.
 *
 * Directories and links are measured by allocation only — a directory's `size` is a
 * metadata figure (192 bytes for an empty APFS directory that occupies no blocks at all)
 * and counting it would put the walker permanently above `du`.
 */
const BLOCKS_UNAVAILABLE = process.platform === 'win32';

function allocatedBytes(stat: Stats): number {
  if (BLOCKS_UNAVAILABLE) {
    return stat.isFile() && stat.size > 0 ? stat.size : 0;
  }
  const blocks = stat.blocks;
  return Number.isFinite(blocks) && blocks > 0 ? blocks * 512 : 0;
}

/** `false` once a spawn has proved `du` is not on this machine; no point retrying per call. */
let duSpawnable = !BLOCKS_UNAVAILABLE;

function parseDuOutput(stdout: string): number | undefined {
  // `du -sk` prints "<kilobytes>\t<path>"; with warnings on stderr the total is still the
  // last line of stdout.
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  const field = last.trim().split(/\s+/)[0];
  if (field === undefined) return undefined;
  const kilobytes = Number(field);
  if (!Number.isFinite(kilobytes) || kilobytes < 0) return undefined;
  return kilobytes * 1024;
}

/**
 * The `du -sk` fast path. Resolves to `undefined` — never throws — when `du` is missing,
 * unusable, or printed something unparseable, which is `dirSize`'s signal to walk instead.
 *
 * A non-zero exit is not itself a failure: `du` exits 1 after warning about a single
 * unreadable subdirectory, having already printed a correct total for everything else.
 * That best-effort total is exactly what the walker would produce, so it is accepted. The
 * `--` guards a target whose name begins with `-`.
 */
export function duSize(target: string): Promise<number | undefined> {
  if (!duSpawnable) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    execFile(
      'du',
      ['-sk', '--', target],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        // LC_ALL keeps the number field free of locale separators; BLOCKSIZE is belt and
        // braces, since -k already fixes the unit on both BSD and GNU du.
        env: { ...process.env, LC_ALL: 'C', BLOCKSIZE: '1024' },
      },
      (error, stdout) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          // A string code with a syscall is a spawn failure (the binary is absent or not
          // executable); a numeric code is du's own exit status, whose stdout still counts.
          if (typeof code === 'string' && (code === 'ENOENT' || code === 'EACCES')) {
            duSpawnable = false;
            resolve(undefined);
            return;
          }
        }
        resolve(parseDuOutput(stdout));
      },
    );
  });
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pooled<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function safeLstat(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch {
    return undefined;
  }
}

async function safeReaddir(target: string): Promise<Dirent[]> {
  try {
    return await readdir(target, { withFileTypes: true });
  } catch {
    // Unreadable or vanished mid-walk. `du` warns and carries on with a partial total;
    // matching that keeps the two paths agreeing, and under-reporting reclaimable space is
    // the harmless direction.
    return [];
  }
}

/**
 * The fallback: a breadth-first walk, one level at a time, with the level fanned out
 * across the pool. Level-at-a-time bounds concurrency without the bookkeeping of a
 * work-stealing queue, and directory trees are wide enough that it saturates the pool.
 *
 * Exported for `tests/size.test.ts`, which has to be able to run this path even on a
 * machine where `du` exists.
 */
export async function walkSize(target: string, options: SizeOptions = {}): Promise<number> {
  const limit = normalizeConcurrency(options.concurrency);

  const rootStat = await safeLstat(target);
  if (rootStat === undefined) return 0;
  if (rootStat.isSymbolicLink()) return 0; // invariant 2: never through a link
  if (!rootStat.isDirectory()) return allocatedBytes(rootStat);

  let total = allocatedBytes(rootStat);
  /** Inodes of multiply-linked files already counted, as `du` tracks them. */
  const counted = new Set<string>();
  let level: string[] = [target];

  while (level.length > 0) {
    const nextLevel: string[] = [];

    await pooled(level, limit, async (directory) => {
      const entries = await safeReaddir(directory);
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        const stat = await safeLstat(child);
        if (stat === undefined) continue;

        if (stat.isSymbolicLink()) {
          total += allocatedBytes(stat); // the link's own blocks, never its target's
          continue;
        }
        if (stat.isDirectory()) {
          total += allocatedBytes(stat);
          nextLevel.push(child);
          continue;
        }
        if (stat.nlink > 1) {
          const key = `${stat.dev}:${stat.ino}`;
          if (counted.has(key)) continue;
          counted.add(key);
        }
        total += allocatedBytes(stat);
      }
    });

    level = nextLevel;
  }

  return total;
}

/**
 * Bytes occupied by `target`, via `du` where it works and the walker otherwise.
 *
 * Best-effort by design: a target that vanished or turned unreadable between the walk and
 * the measurement sizes as 0 rather than throwing, because one bad directory must not
 * abort a scan of a thousand. A symlink sizes as 0 — invariant 2, enforced here before
 * either path runs so that neither has to be trusted with it.
 */
export async function dirSize(target: string, options?: SizeOptions): Promise<number> {
  const stat = await safeLstat(target);
  if (stat === undefined) return 0;
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return allocatedBytes(stat);

  const fast = await duSize(target);
  if (fast !== undefined) return fast;
  return walkSize(target, options ?? {});
}

/**
 * Newest modification time of any file under `root`, with `exclude`d paths and their
 * subtrees left out entirely. Returns 0 when nothing was found — an empty tree, a missing
 * root, an unreadable one.
 *
 * This is how `activity.ts` gets `newestSourceMs` without a second walk: it passes the
 * project's artifact directories, and what comes back is the newest *source* file. The
 * exclusions must therefore prune the descent, not merely filter the results — a
 * `target/` full of freshly written object files would otherwise make every built project
 * look like it was edited a minute ago, and every dormant project would score active.
 *
 * `.git` is pruned for the same reason and is not the caller's job to pass: it is object
 * storage, not source (the spec's own skip list), and a `git fetch` on an untouched repo
 * rewrites it. Entries in `exclude` may be absolute or relative to `root`. Symbolic links
 * are never followed and never contribute, so a link into a live tree cannot make a
 * dormant project look fresh.
 */
export async function newestMtimeMs(root: string, exclude: readonly string[]): Promise<number> {
  const base = path.resolve(root);
  const excluded = new Set(exclude.map((entry) => path.resolve(base, entry)));
  if (excluded.has(base)) return 0;

  const rootStat = await safeLstat(base);
  if (rootStat === undefined) return 0;
  if (rootStat.isSymbolicLink()) return 0;
  if (!rootStat.isDirectory()) return rootStat.mtimeMs;

  const limit = defaultConcurrency();
  let newest = 0;
  let level: string[] = [base];

  while (level.length > 0) {
    const nextLevel: string[] = [];

    await pooled(level, limit, async (directory) => {
      const entries = await safeReaddir(directory);
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        if (excluded.has(child)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name === '.git') continue;
          nextLevel.push(child);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await safeLstat(child);
        if (stat === undefined || stat.isSymbolicLink()) continue;
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    });

    level = nextLevel;
  }

  return newest;
}
