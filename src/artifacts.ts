/**
 * The type/artifact matrix, and the one function that turns a directory into delete
 * candidates.
 *
 * `ARTIFACT_TABLE` is the **allowlist** on which invariant 1 rests: a path is deletable
 * only because a pattern here names it. It is therefore transcribed verbatim from the
 * spec's matrix and deep-frozen — a table a later module can push onto is not an allowlist.
 *
 * `resolveArtifacts` is the single code path from "a project root" to "these directories
 * may be trashed" (spec: "exactly one code path"). `discover.ts` delegates to it rather
 * than re-walking, so every rule that decides what a candidate *is* lives here and is
 * tested once:
 *
 * - **Three pattern kinds.** A bare basename matches at any depth in the project; a value
 *   containing `/` matches relative to the directory that *declared* the type; a value
 *   containing `*` is a glob.
 * - **Invariant 2.** A symlink is never returned and never walked through, so no candidate
 *   can escape the project root.
 * - **Invariant 6.** A child whose `.git` is a *file* is a linked worktree and is skipped
 *   entirely — tested **before** its basename is matched. Reversed, `git worktree add
 *   build feature` produces a checkout named `build` that the table claims, and the tool
 *   offers real source with uncommitted work for deletion.
 * - **Directories only.** `build` is very often an executable build *script*; `dist` is
 *   sometimes a file. Everything downstream (sizing, pruning, the worktree check) is
 *   directory-shaped, and refusing files costs a few kilobytes of `.eslintcache` while
 *   removing a way to delete source.
 */

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Artifact, Category, Preset, ProjectType } from './types.js';

export interface Pattern {
  value: string;
  kind: 'basename' | 'relative' | 'glob';
  category: Category;
}

/**
 * The spec's 10-type × 3-category matrix, verbatim. `—` in the matrix is an empty list,
 * never a missing key, so consumers may index `[type][category]` unconditionally.
 *
 * Entries containing `/` match a relative path from the declaring directory; entries
 * containing `*` are globs; all others match a basename at any depth within the project.
 */
export const ARTIFACT_TABLE: Record<ProjectType, Record<Category, string[]>> = deepFreeze({
  node: {
    build: ['dist', 'build', '.next', 'out', '.output', '.svelte-kit', 'storybook-static'],
    deps: ['node_modules'],
    cache: ['.turbo', '.cache', '.parcel-cache', '.eslintcache', '.vite'],
  },
  rust: {
    build: ['target'],
    deps: [],
    cache: [],
  },
  flutter: {
    build: ['build'],
    deps: ['.dart_tool', '.packages', 'ios/.symlinks'],
    cache: [],
  },
  xcode: {
    build: ['build', 'DerivedData', '.build'],
    deps: ['Pods'],
    cache: [],
  },
  gradle: {
    build: ['build', 'app/build'],
    deps: [],
    cache: ['.gradle', '.kotlin'],
  },
  python: {
    build: ['dist', 'build', '*.egg-info'],
    deps: ['.venv', 'venv'],
    cache: ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'],
  },
  ruby: {
    build: [],
    deps: ['vendor/bundle'],
    cache: ['.bundle'],
  },
  go: {
    build: ['bin'],
    deps: [],
    cache: [],
  },
  dotnet: {
    build: ['bin', 'obj'],
    deps: [],
    cache: [],
  },
  cmake: {
    build: ['build', 'cmake-build-*'],
    deps: [],
    cache: [],
  },
});

/** Freeze the table and every list inside it, so the allowlist cannot be widened at runtime. */
function deepFreeze(
  table: Record<ProjectType, Record<Category, string[]>>,
): Record<ProjectType, Record<Category, string[]>> {
  for (const row of Object.values(table)) {
    for (const values of Object.values(row)) Object.freeze(values);
    Object.freeze(row);
  }
  return Object.freeze(table);
}

const PROJECT_TYPES = Object.keys(ARTIFACT_TABLE) as ProjectType[];
const CATEGORIES: readonly Category[] = ['build', 'deps', 'cache'];

/**
 * Conservatism order: `deps` > `build` > `cache`. Lower rank wins a collision, so a
 * directory two types disagree about is only cleaned under the preset that most explicitly
 * opts into it (spec: "the more conservative category wins").
 */
const CATEGORY_RANK: Readonly<Record<Category, number>> = { deps: 0, build: 1, cache: 2 };

/**
 * Preset → the categories it enables.
 *
 * A fresh set per call: the TUI holds the result in state and the CLI hands it to the scan,
 * and a shared set that one of them mutates silently widens what the other deletes.
 * `custom` means per-category checkboxes, which only the interface can express; it starts
 * from the recommended set — the fail-closed direction — and the user edits from there.
 */
export function categoriesForPreset(preset: Preset): Set<Category> {
  return preset === 'aggressive'
    ? new Set<Category>(['build', 'deps', 'cache'])
    : new Set<Category>(['build', 'cache']);
}

/** Compiled globs, cached: the walk tests every directory name against every glob. */
const globCache = new Map<string, RegExp>();

function globRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached !== undefined) return cached;

  // Escape every regex metacharacter, then expand `*` to "any run within one segment".
  // `*` never crosses a separator, so a glob cannot widen across a directory boundary.
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  const compiled = new RegExp(`^${source}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

/**
 * Glob match, anchored at both ends. A pattern without `*` degenerates to an exact
 * comparison, which is why callers can run every pattern kind through it.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  return globRegExp(pattern).test(value);
}

function kindOf(value: string): Pattern['kind'] {
  if (value.includes('*')) return 'glob';
  return value.includes('/') ? 'relative' : 'basename';
}

/** A glob may still be anchored to the declaring directory if it spans segments. */
function isRelativePattern(pattern: Pattern): boolean {
  return pattern.kind === 'relative' || (pattern.kind === 'glob' && pattern.value.includes('/'));
}

/**
 * Every basename the table can claim: plain names, glob names, and the **final component**
 * of a relative entry.
 *
 * The final component is included because `clean.ts` re-checks a candidate's basename
 * against the table at the deletion boundary; without `bundle` and `.symlinks` a
 * legitimate `vendor/bundle` target would be refused as `not-in-artifact-table`. The
 * *leading* component is deliberately excluded: the walk prunes on this predicate, and
 * treating `vendor`, `app` or `ios` as artifact names would stop the descent one level
 * short of the directories those entries name.
 */
const EXACT_BASENAMES = new Set<string>();
const GLOB_BASENAMES: string[] = [];

for (const type of PROJECT_TYPES) {
  for (const category of CATEGORIES) {
    for (const value of ARTIFACT_TABLE[type][category]) {
      const basename = value.includes('/') ? (value.split('/').pop() ?? '') : value;
      if (basename === '') continue;
      if (basename.includes('*')) GLOB_BASENAMES.push(basename);
      else EXACT_BASENAMES.add(basename);
    }
  }
}

/**
 * Does this directory name appear in the artifact table, for any type and any category?
 *
 * Two callers, both of which want the table-wide answer rather than a per-project one:
 * the walk prunes on it (spec: "never descends into a directory whose basename appears in
 * the artifact table"), and `clean.ts` uses it as the deletion-boundary allowlist check.
 */
export function isArtifactBasename(name: string): boolean {
  if (name === '') return false;
  if (EXACT_BASENAMES.has(name)) return true;
  return GLOB_BASENAMES.some((pattern) => matchesGlob(pattern, name));
}

/**
 * The patterns the given types contribute, restricted to the given categories.
 *
 * Deduplicated by `value`: four types claim `build`, and matching it four times would
 * produce four candidates for one directory. Where a duplicated value carries different
 * categories the more conservative one wins, the same rule `dedupeArtifacts` applies to
 * resolved paths.
 */
export function artifactPatternsFor(
  types: Set<ProjectType>,
  categories: Set<Category>,
): Pattern[] {
  const byValue = new Map<string, Pattern>();

  for (const type of PROJECT_TYPES) {
    if (!types.has(type)) continue;
    for (const category of CATEGORIES) {
      if (!categories.has(category)) continue;
      for (const value of ARTIFACT_TABLE[type][category]) {
        const existing = byValue.get(value);
        if (existing === undefined) {
          byValue.set(value, { value, kind: kindOf(value), category });
        } else if (CATEGORY_RANK[category] < CATEGORY_RANK[existing.category]) {
          existing.category = category;
        }
      }
    }
  }

  return [...byValue.values()];
}

/**
 * Collapse candidates that name the same absolute path, keeping the most conservative
 * category (`deps` > `build` > `cache`).
 *
 * Exported because it is the whole of the spec's dedup rule and the shipped table happens
 * to contain no value claimed by two types under *different* categories — so no fixture
 * can exercise the cross-category case end-to-end, and the rule would otherwise ship
 * untested until the day a type is added that collides.
 */
export function dedupeArtifacts(candidates: readonly Artifact[]): Artifact[] {
  const byPath = new Map<string, Artifact>();

  for (const candidate of candidates) {
    const existing = byPath.get(candidate.path);
    if (existing === undefined) {
      byPath.set(candidate.path, { ...candidate });
      continue;
    }
    if (CATEGORY_RANK[candidate.category] < CATEGORY_RANK[existing.category]) {
      existing.category = candidate.category;
    }
  }

  return [...byPath.values()];
}

/** `true` when `dir` is a linked git worktree: its `.git` is a file, not a directory. */
async function isWorktreeDir(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, '.git'))).isFile();
  } catch {
    return false;
  }
}

/** A relative pattern together with the declaring directory it is anchored to. */
interface AnchoredPattern {
  base: string;
  pattern: Pattern;
}

/** Relative paths are compared with `/` separators, as the table writes them. */
const toPosix = (value: string): string =>
  path.sep === '/' ? value : value.split(path.sep).join('/');

/**
 * Resolve a project root into its delete candidates.
 *
 * `declarations` maps a directory to the types **that directory** declares — the map the
 * walk in `discover.ts` builds as it descends, covering the whole rolled-up subtree.
 * Basename and bare-glob patterns come from the union of every declared type and match at
 * any depth, because a monorepo is one project whose sub-projects each contribute
 * artifact names. Patterns containing `/` are anchored to their declaring directory only.
 *
 * The category filter is applied to the **merged** category, after dedup, so a directory
 * two types disagree about is only cleaned under the preset that opts into the more
 * conservative of the two.
 *
 * Fails closed throughout: a directory that cannot be read contributes nothing rather than
 * aborting the scan, and `bytes` is left at 0 for `scan.ts` to fill in.
 */
export async function resolveArtifacts(
  root: string,
  declarations: ReadonlyMap<string, Set<ProjectType>>,
  categories: Set<Category>,
): Promise<Artifact[]> {
  const rootPath = path.resolve(root);

  // Normalise declaration keys against the root, and collect the project's whole type set.
  const declaredTypes = new Map<string, Set<ProjectType>>();
  const unionTypes = new Set<ProjectType>();
  for (const [dirPath, types] of declarations) {
    const absolute = path.resolve(rootPath, dirPath);
    const merged = declaredTypes.get(absolute) ?? new Set<ProjectType>();
    for (const type of types) {
      merged.add(type);
      unionTypes.add(type);
    }
    declaredTypes.set(absolute, merged);
  }
  if (unionTypes.size === 0) return [];

  // Matched against ALL categories: the enabled-category filter applies to the merged
  // category once every claim on a path is known.
  const allCategories = new Set<Category>(CATEGORIES);
  const namePatterns = artifactPatternsFor(unionTypes, allCategories).filter(
    (pattern) => !isRelativePattern(pattern),
  );

  /** Relative patterns of one declaring directory, anchored to it. */
  const anchoredAt = (dirPath: string): AnchoredPattern[] => {
    const types = declaredTypes.get(dirPath);
    if (types === undefined) return [];
    return artifactPatternsFor(types, allCategories)
      .filter(isRelativePattern)
      .map((pattern) => ({ base: dirPath, pattern }));
  };

  const candidates: Artifact[] = [];

  /** Every category claiming this directory — usually one, occasionally several. */
  const claimsOn = (name: string, dirPath: string, anchored: readonly AnchoredPattern[]): Category[] => {
    const claims: Category[] = [];

    for (const pattern of namePatterns) {
      const hit =
        pattern.kind === 'basename' ? pattern.value === name : matchesGlob(pattern.value, name);
      if (hit) claims.push(pattern.category);
    }

    for (const { base, pattern } of anchored) {
      const relative = toPosix(path.relative(base, dirPath));
      const hit =
        pattern.kind === 'relative'
          ? pattern.value === relative
          : matchesGlob(pattern.value, relative);
      if (hit) claims.push(pattern.category);
    }

    return claims;
  };

  async function walk(dirPath: string, inherited: readonly AnchoredPattern[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // Unreadable directories under-report; they never abort the scan.
    }

    const anchored = declaredTypes.has(dirPath)
      ? [...inherited, ...anchoredAt(dirPath)]
      : inherited;

    for (const entry of entries) {
      // `withFileTypes` does not follow links, so a symlinked directory reports as a
      // symlink and is skipped here — invariant 2, enforced before anything else looks
      // at the name.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;

      const name = entry.name;
      if (name === '.git') continue; // Object storage, not build output. Never descended.

      const childPath = path.join(dirPath, name);

      // Invariant 6: worktree detection precedes artifact matching. A worktree named
      // `build` is a checkout with its own history; `discover.ts` yields it as a root of
      // its own, and it is neither claimed nor descended here.
      if (await isWorktreeDir(childPath)) continue;

      const claims = claimsOn(name, childPath, anchored);
      if (claims.length > 0) {
        const relPath = path.relative(rootPath, childPath);
        for (const category of claims) {
          candidates.push({ path: childPath, relPath, category, bytes: 0 });
        }
        continue; // Never descend into a directory already claimed.
      }

      // Pruning is table-wide and category-independent (spec: "never descends into a
      // directory whose basename appears in the artifact table"): a `node_modules` that
      // the current preset does not enable is still not worth walking.
      if (isArtifactBasename(name)) continue;

      await walk(childPath, anchored);
    }
  }

  await walk(rootPath, anchoredAt(rootPath));

  return dedupeArtifacts(candidates)
    .filter((artifact) => categories.has(artifact.category))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
