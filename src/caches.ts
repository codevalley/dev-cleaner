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

import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { dirSize } from './size.js';
import type { CacheEntry } from './types.js';

export interface CacheEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
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
  pnpm: 'hardlink target for project node_modules — those are trashed first',
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
 */
export async function listCaches(env: CacheEnv): Promise<CacheEntry[]> {
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
    present.map(async (candidate) => ({ ...candidate, bytes: await sizeOf(candidate.path) })),
  );
}
