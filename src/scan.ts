/**
 * The pipeline: discovery → sizing → git → activity, composed into one stream of events.
 *
 * `discover()` yields a `DiscoveredProject` — roots, types and artifact paths, but no
 * sizes, no git metadata and no activity score. **This module is the only place those
 * three are attached.** Centralising enrichment here is what makes it impossible for a
 * consumer to hold a project without an `ActivityScore`: the UI's protected-section logic
 * and the CLI's report both read `project.activity` unconditionally, and an earlier draft
 * that enriched in two places shipped projects where it was missing.
 *
 * The stream is deliberately incremental. Sizing a 133 GB tree takes long enough to be
 * visible, so the TUI subscribes to `scanStream` and renders each project as it arrives
 * (spec: "Progressive rendering"). `scanAll` is the drain-it-all convenience for the
 * non-TTY report path and for tests.
 */

import { gatherSignals, scoreActivity, type ActivitySignals } from './activity.js';
import { currentCacheEnv, listCaches, type CacheListOptions } from './caches.js';
import { discover } from './discover.js';
import { readGitInfo } from './git.js';
import { dirSize, type SizeOptions } from './size.js';
import type {
  ActivityScore,
  Artifact,
  CacheEntry,
  Category,
  DiscoveredProject,
  GitInfo,
  Project,
} from './types.js';

export interface ScanOptions {
  roots: readonly string[];
  /** What the *walk* looks for. Always the widest set, so a preset change never re-walks. */
  categories: Set<Category>;
  includeCaches: boolean;
  nowMs: number;
  concurrency?: number;
  /**
   * What the active preset will actually *clean* — `categoriesForPreset(preset)`, which is
   * a subset of `categories` above. Nothing about the walk depends on it; it exists so the
   * cache table can describe the package store in terms of the run that is happening rather
   * than a run that is not. Left out by callers with no preset to speak for.
   */
  presetCategories?: ReadonlySet<Category>;
}

export type ScanEvent =
  | { kind: 'project'; project: Project }
  | { kind: 'cache'; cache: CacheEntry }
  | { kind: 'done' };

export interface ScanResult {
  projects: Project[];
  caches: CacheEntry[];
}

/**
 * Sizing is best-effort. A directory can vanish or become unreadable between the walk and
 * the measurement; reporting it as 0 under-states the reclaimable total, which is the
 * harmless direction. Throwing would abort the whole scan for one bad directory.
 */
async function sizeOf(target: string, options: SizeOptions | undefined): Promise<number> {
  try {
    const bytes = await dirSize(target, options);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  } catch {
    return 0;
  }
}

/**
 * `readGitInfo` already returns `undefined` for a non-repository. The catch covers the
 * other case: a repository the user merely downloaded, whose git invocation fails for
 * reasons of its own. A project with no git metadata is still a project.
 */
async function gitOf(root: string): Promise<GitInfo | undefined> {
  try {
    return await readGitInfo(root);
  } catch {
    return undefined;
  }
}

/** Enough of a signal set to score against when signal gathering itself fails. */
function fallbackSignals(git: GitInfo | undefined): ActivitySignals {
  const signals: ActivitySignals = {
    hasUncommittedChanges: git?.hasUncommittedChanges ?? false,
    newestSourceMs: 0,
    newestArtifactMs: 0,
  };
  if (git !== undefined) signals.lastCommitMs = git.lastCommitMs;
  return signals;
}

async function signalsOf(
  root: string,
  artifacts: readonly Artifact[],
  git: GitInfo | undefined,
): Promise<ActivitySignals> {
  try {
    return await gatherSignals(root, artifacts, git);
  } catch {
    return fallbackSignals(git);
  }
}

/**
 * `scoreActivity`'s body is the plan's one intentional TODO, authored by the repository
 * owner. Until it lands — and after, since it encodes a judgement rather than a
 * derivation — a throw from it must not take the scan down. Failing closed means `active`:
 * an active project is protected, not selected for deletion.
 */
function scoreOf(signals: ActivitySignals, nowMs: number): ActivityScore {
  try {
    return scoreActivity(signals, nowMs);
  } catch (error) {
    return {
      status: 'active',
      idleMs: 0,
      reason: `unscored (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** A `DiscoveredProject` in, a complete `Project` out. The one enrichment path. */
async function enrich(discovered: DiscoveredProject, options: ScanOptions): Promise<Project> {
  const sizeOptions: SizeOptions | undefined =
    options.concurrency === undefined ? undefined : { concurrency: options.concurrency };

  // Artifacts of one project are independent; `dirSize` bounds its own internal work.
  const artifacts: Artifact[] = await Promise.all(
    discovered.artifacts.map(async (artifact) => ({
      ...artifact,
      bytes: await sizeOf(artifact.path, sizeOptions),
    })),
  );

  const git = await gitOf(discovered.root);
  const signals = await signalsOf(discovered.root, artifacts, git);

  const project: Project = {
    root: discovered.root,
    name: discovered.name,
    types: new Set(discovered.types),
    artifacts,
    bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    activity: scoreOf(signals, options.nowMs),
  };
  // Left absent rather than set to `undefined`, so `'git' in project` reads truthfully.
  if (git !== undefined) project.git = git;
  return project;
}

/**
 * Yields each project as soon as it is fully enriched, then the global caches when asked
 * for, then exactly one `done`. `done` is always last and always present, including on an
 * empty scan, so a consumer can drive a spinner off it without special-casing.
 *
 * A `SafetyError` from a guarded scan root (invariant 3) propagates out of the generator
 * deliberately: refusing to scan `/` or `$HOME` is not a per-project failure to swallow.
 */
export async function* scanStream(options: ScanOptions): AsyncGenerator<ScanEvent> {
  for await (const discovered of discover(options.roots, options.categories)) {
    yield { kind: 'project', project: await enrich(discovered, options) };
  }

  if (options.includeCaches) {
    // The one place a cache can be marked unsafe *before* it is offered: `listCaches`
    // screens the package store here, so the default selection, the report total and the
    // interface all agree with what `clean.ts` would do at the boundary.
    const cacheOptions: CacheListOptions =
      options.presetCategories === undefined ? {} : { categories: options.presetCategories };
    for (const cache of await listCaches(currentCacheEnv(), cacheOptions)) {
      yield { kind: 'cache', cache };
    }
  }

  yield { kind: 'done' };
}

/** Drains `scanStream` into arrays. Same data, no progressive rendering. */
export async function scanAll(options: ScanOptions): Promise<ScanResult> {
  const projects: Project[] = [];
  const caches: CacheEntry[] = [];

  for await (const event of scanStream(options)) {
    if (event.kind === 'project') projects.push(event.project);
    else if (event.kind === 'cache') caches.push(event.cache);
  }

  return { projects, caches };
}
