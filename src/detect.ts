/**
 * Marker files in a directory → the set of ecosystems that directory declares.
 *
 * Two entry points, deliberately:
 *
 * - `detectTypesFromNames` is pure and synchronous. The walk in `discover.ts` has already
 *   read the directory entries, so it classifies from that list rather than paying a
 *   second `readdir` per directory.
 * - `detectTypes` is a thin `readdir` wrapper for callers that hold only a path (and for
 *   tests). It fails **closed**: an unreadable, missing, or non-directory path yields an
 *   empty set rather than a throw that would abort a whole scan mid-walk. Under-detecting
 *   costs reclaimable space; throwing costs the run.
 *
 * A **set** is returned, never a single type. A Flutter project is simultaneously
 * `flutter`, `gradle`, `xcode`, and `ruby`; a single-type model under-cleans every mobile
 * project. `artifacts.ts` unions the path lists of every detected type.
 */

import { readdir } from 'node:fs/promises';

import type { ProjectType } from './types.js';

/**
 * The marker column of the spec's type/artifact matrix, transcribed verbatim.
 *
 * Matching is against a single directory entry **name** (never a path) and is
 * case-sensitive: these are the canonical spellings the respective toolchains write.
 * Entries containing `*` are globs; all others are exact names.
 */
const MARKER_TABLE: Readonly<Record<ProjectType, readonly string[]>> = {
  node: ['package.json'],
  rust: ['Cargo.toml'],
  flutter: ['pubspec.yaml'],
  xcode: ['*.xcodeproj', 'Package.swift'],
  gradle: ['build.gradle', 'build.gradle.kts', 'settings.gradle*'],
  python: ['pyproject.toml', 'requirements.txt'],
  ruby: ['Gemfile', '*.gemspec'],
  go: ['go.mod'],
  dotnet: ['*.csproj'],
  cmake: ['CMakeLists.txt'],
};

const PROJECT_TYPES = Object.keys(MARKER_TABLE) as ProjectType[];

/**
 * Exact markers indexed by name. One `Map.get` per directory entry, rather than a scan of
 * the whole table — the walk calls this for every directory it visits.
 */
const EXACT_MARKERS = new Map<string, ProjectType[]>();

/** Glob markers, pre-compiled. Only these are tested entry-by-entry. */
const GLOB_MARKERS: Array<{ readonly type: ProjectType; readonly test: RegExp }> = [];

/** Escape everything a glob does not give meaning to, then expand `*`. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`);
}

for (const type of PROJECT_TYPES) {
  for (const marker of MARKER_TABLE[type]) {
    if (marker.includes('*')) {
      GLOB_MARKERS.push({ type, test: globToRegExp(marker) });
      continue;
    }
    const existing = EXACT_MARKERS.get(marker);
    if (existing) existing.push(type);
    else EXACT_MARKERS.set(marker, [type]);
  }
}

/**
 * Classify a directory from the entry names it contains.
 *
 * Pure and synchronous — no filesystem access, no I/O, no ordering dependence. The names
 * are bare entry names as `fs.readdir` returns them, not paths; a marker may be a file
 * (`Cargo.toml`) or a directory (`Runner.xcodeproj`), and the distinction is irrelevant
 * here, so no `stat` is required.
 *
 * Returns a fresh, mutable set on every call; callers own the result.
 */
export function detectTypesFromNames(entryNames: readonly string[]): Set<ProjectType> {
  const found = new Set<ProjectType>();

  for (const name of entryNames) {
    const exact = EXACT_MARKERS.get(name);
    if (exact) {
      for (const type of exact) found.add(type);
    }
    for (const glob of GLOB_MARKERS) {
      if (!found.has(glob.type) && glob.test.test(name)) found.add(glob.type);
    }
  }

  return found;
}

/**
 * Classify a directory by reading it.
 *
 * Fails closed: any error — missing path, permission denied, not a directory — resolves to
 * an empty set. See the module note; a scan must survive directories it cannot read.
 */
export async function detectTypes(dir: string): Promise<Set<ProjectType>> {
  try {
    return detectTypesFromNames(await readdir(dir));
  } catch {
    return new Set<ProjectType>();
  }
}
