/**
 * `src/artifacts.ts` — the type/artifact matrix, pattern matching, and the one function
 * that turns a directory into delete candidates.
 *
 * The tests that matter most here are the ones that constrain what `resolveArtifacts` is
 * allowed to *return*, because everything downstream — sizing, the TUI's checkboxes,
 * `clean.ts`'s allowlist — is built from that list. A candidate that should never have
 * been produced is a deletion the user is invited to approve.
 */

import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_TABLE,
  artifactPatternsFor,
  categoriesForPreset,
  dedupeArtifacts,
  isArtifactBasename,
  matchesGlob,
  resolveArtifacts,
  type Pattern,
} from '../src/artifacts.js';
import type { Artifact, Category, ProjectType } from '../src/types.js';
import { file, fixture, symlink, worktree, type Fixture, type FixtureSpec } from './fixture.js';

const ALL: Set<Category> = new Set<Category>(['build', 'deps', 'cache']);

const KB = 1024;

/** Platform-correct expectation for a `relPath`, which uses the platform separator. */
const rel = (...segments: string[]): string => path.join(...segments);

const fixtures: Fixture[] = [];

async function tree(spec: FixtureSpec): Promise<Fixture> {
  const created = await fixture(spec);
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()!.cleanup();
});

/**
 * Build the `declarations` map the way `discover.ts` does: absolute directory path → the
 * types that directory declares. `'.'` names the scan root itself.
 */
function declarations(
  root: string,
  spec: Record<string, readonly ProjectType[]>,
): Map<string, Set<ProjectType>> {
  const map = new Map<string, Set<ProjectType>>();
  for (const [dirPath, types] of Object.entries(spec)) {
    map.set(dirPath === '.' ? root : path.join(root, dirPath), new Set(types));
  }
  return map;
}

const relPaths = (artifacts: readonly Artifact[]): string[] =>
  artifacts.map((artifact) => artifact.relPath).sort();

const categoryOf = (artifacts: readonly Artifact[], relPath: string): Category | undefined =>
  artifacts.find((artifact) => artifact.relPath === relPath)?.category;

// ─── the table ───────────────────────────────────────────────────────────────────────

describe('ARTIFACT_TABLE', () => {
  /**
   * The spec's 10-type × 3-category matrix, written out again rather than derived, so the
   * test fails when the shipped table drifts from the design document. `—` in the matrix
   * is an empty list, never a missing key: consumers index `[type][category]`
   * unconditionally.
   */
  it('transcribes the spec matrix verbatim', () => {
    expect(ARTIFACT_TABLE).toEqual({
      node: {
        build: ['dist', 'build', '.next', 'out', '.output', '.svelte-kit', 'storybook-static'],
        deps: ['node_modules'],
        cache: ['.turbo', '.cache', '.parcel-cache', '.eslintcache', '.vite'],
      },
      rust: { build: ['target'], deps: [], cache: [] },
      flutter: {
        build: ['build'],
        deps: ['.dart_tool', '.packages', 'ios/.symlinks'],
        cache: [],
      },
      xcode: { build: ['build', 'DerivedData', '.build'], deps: ['Pods'], cache: [] },
      gradle: { build: ['build', 'app/build'], deps: [], cache: ['.gradle', '.kotlin'] },
      python: {
        build: ['dist', 'build', '*.egg-info'],
        deps: ['.venv', 'venv'],
        cache: ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'],
      },
      ruby: { build: [], deps: ['vendor/bundle'], cache: ['.bundle'] },
      go: { build: ['bin'], deps: [], cache: [] },
      dotnet: { build: ['bin', 'obj'], deps: [], cache: [] },
      cmake: { build: ['build', 'cmake-build-*'], deps: [], cache: [] },
    });
  });

  it('covers all ten project types with all three categories', () => {
    const types: ProjectType[] = [
      'node', 'rust', 'flutter', 'xcode', 'gradle', 'python', 'ruby', 'go', 'dotnet', 'cmake',
    ];
    expect(Object.keys(ARTIFACT_TABLE).sort()).toEqual([...types].sort());
    for (const type of types) {
      expect(Object.keys(ARTIFACT_TABLE[type]).sort(), type).toEqual(['build', 'cache', 'deps']);
    }
  });

  /** It is the allowlist (invariant 1). A mutable allowlist is not an allowlist. */
  it('is frozen, table and lists alike', () => {
    expect(Object.isFrozen(ARTIFACT_TABLE)).toBe(true);
    expect(Object.isFrozen(ARTIFACT_TABLE.rust)).toBe(true);
    expect(Object.isFrozen(ARTIFACT_TABLE.rust.build)).toBe(true);
    expect(() => ARTIFACT_TABLE.rust.build.push('src')).toThrow();
    expect(ARTIFACT_TABLE.rust.build).toEqual(['target']);
  });
});

// ─── presets ─────────────────────────────────────────────────────────────────────────

describe('categoriesForPreset', () => {
  it('recommended is build + cache, and never deps', () => {
    const categories = categoriesForPreset('recommended');
    expect([...categories].sort()).toEqual(['build', 'cache']);
    expect(categories.has('deps')).toBe(false);
  });

  it('aggressive adds deps', () => {
    expect([...categoriesForPreset('aggressive')].sort()).toEqual(['build', 'cache', 'deps']);
  });

  it('custom starts from the recommended set, which the checkboxes then edit', () => {
    expect([...categoriesForPreset('custom')].sort()).toEqual(['build', 'cache']);
  });

  it('returns a fresh set per call, so a caller mutating it cannot widen the next preset', () => {
    const first = categoriesForPreset('recommended');
    first.add('deps');
    expect(categoriesForPreset('recommended').has('deps')).toBe(false);
  });
});

// ─── glob matching ───────────────────────────────────────────────────────────────────

describe('matchesGlob', () => {
  it('expands `*` to any run of characters', () => {
    expect(matchesGlob('*.egg-info', 'mypkg.egg-info')).toBe(true);
    expect(matchesGlob('*.egg-info', '.egg-info')).toBe(true);
    expect(matchesGlob('cmake-build-*', 'cmake-build-debug')).toBe(true);
    expect(matchesGlob('cmake-build-*', 'cmake-build-')).toBe(true);
  });

  it('anchors at both ends', () => {
    expect(matchesGlob('*.egg-info', 'mypkg.egg-info.bak')).toBe(false);
    expect(matchesGlob('cmake-build-*', 'x-cmake-build-debug')).toBe(false);
    expect(matchesGlob('cmake-build-*', 'cmake-build')).toBe(false);
  });

  it('treats a pattern without `*` as an exact comparison', () => {
    expect(matchesGlob('node_modules', 'node_modules')).toBe(true);
    expect(matchesGlob('node_modules', 'node_modules2')).toBe(false);
  });

  /** `.` is a literal here. A naive `new RegExp(pattern)` would match `xnext`. */
  it('does not let regex metacharacters through', () => {
    expect(matchesGlob('.next', '.next')).toBe(true);
    expect(matchesGlob('.next', 'xnext')).toBe(false);
    expect(matchesGlob('a+b', 'a+b')).toBe(true);
    expect(matchesGlob('a+b', 'aab')).toBe(false);
    expect(matchesGlob('a(b', 'a(b')).toBe(true);
  });

  /** `*` is a path-segment wildcard, so a glob can never widen across a directory. */
  it('does not let `*` cross a path separator', () => {
    expect(matchesGlob('*.egg-info', 'src/mypkg.egg-info')).toBe(false);
    expect(matchesGlob('vendor/*', 'vendor/bundle')).toBe(true);
    expect(matchesGlob('vendor/*', 'vendor/bundle/gems')).toBe(false);
  });
});

// ─── basename membership ─────────────────────────────────────────────────────────────

describe('isArtifactBasename', () => {
  it('accepts every plain basename in the table', () => {
    for (const name of ['node_modules', 'dist', 'build', '.next', 'target', 'Pods', '.dart_tool',
      '.gradle', '__pycache__', '.venv', 'bin', 'obj', 'DerivedData', '.turbo']) {
      expect(isArtifactBasename(name), name).toBe(true);
    }
  });

  it('accepts names matching a glob entry', () => {
    expect(isArtifactBasename('mypkg.egg-info')).toBe(true);
    expect(isArtifactBasename('cmake-build-debug')).toBe(true);
  });

  /**
   * The final component of a relative entry counts too: `clean.ts` checks a candidate's
   * basename against the table, and a legitimate `vendor/bundle` target must not be
   * refused as `not-in-artifact-table`.
   */
  it('accepts the final component of a relative entry', () => {
    expect(isArtifactBasename('bundle')).toBe(true);
    expect(isArtifactBasename('.symlinks')).toBe(true);
  });

  /**
   * The *leading* component must not: the walk prunes on this predicate, so treating
   * `app`, `ios` or `vendor` as artifact names would stop the descent one level short of
   * the very directories those relative entries name.
   */
  it('rejects the leading component of a relative entry', () => {
    for (const name of ['app', 'ios', 'vendor']) {
      expect(isArtifactBasename(name), name).toBe(false);
    }
  });

  it('rejects ordinary names', () => {
    for (const name of ['src', 'lib', 'crates', 'README.md', 'package.json', '.git', '']) {
      expect(isArtifactBasename(name), name).toBe(false);
    }
  });
});

// ─── pattern selection ───────────────────────────────────────────────────────────────

describe('artifactPatternsFor', () => {
  const valuesOf = (patterns: readonly Pattern[]): string[] =>
    patterns.map((pattern) => pattern.value).sort();

  it('returns nothing for no types', () => {
    expect(artifactPatternsFor(new Set<ProjectType>(), ALL)).toEqual([]);
  });

  it('returns one type’s whole row', () => {
    expect(artifactPatternsFor(new Set<ProjectType>(['rust']), ALL)).toEqual([
      { value: 'target', kind: 'basename', category: 'build' },
    ]);
  });

  it('honours the category filter', () => {
    const patterns = artifactPatternsFor(new Set<ProjectType>(['node']), new Set<Category>(['build']));
    expect(valuesOf(patterns)).toEqual(
      ['.next', '.output', '.svelte-kit', 'build', 'dist', 'out', 'storybook-static'].sort(),
    );
    for (const pattern of patterns) expect(pattern.category).toBe('build');
  });

  it('unions several types and yields one pattern per value', () => {
    const patterns = artifactPatternsFor(
      new Set<ProjectType>(['flutter', 'xcode', 'gradle', 'cmake']),
      ALL,
    );
    expect(patterns.filter((pattern) => pattern.value === 'build')).toHaveLength(1);
    expect(valuesOf(patterns)).toEqual(
      ['build', '.dart_tool', '.packages', 'ios/.symlinks', 'DerivedData', '.build', 'Pods',
        'app/build', '.gradle', '.kotlin', 'cmake-build-*'].sort(),
    );
  });

  it('classifies the three pattern kinds', () => {
    const patterns = artifactPatternsFor(
      new Set<ProjectType>(['node', 'gradle', 'python', 'ruby', 'flutter']),
      ALL,
    );
    const kindOf = (value: string): Pattern['kind'] | undefined =>
      patterns.find((pattern) => pattern.value === value)?.kind;

    expect(kindOf('node_modules')).toBe('basename');
    expect(kindOf('app/build')).toBe('relative');
    expect(kindOf('vendor/bundle')).toBe('relative');
    expect(kindOf('ios/.symlinks')).toBe('relative');
    expect(kindOf('*.egg-info')).toBe('glob');
  });
});

// ─── resolveArtifacts: the three pattern kinds ───────────────────────────────────────

describe('resolveArtifacts: a bare basename matches at any depth', () => {
  it('finds the root’s and every nested occurrence', async () => {
    const f = await tree({
      'Cargo.toml': '[package]\nname = "mono"\n',
      'src/main.rs': 'fn main() {}\n',
      'target/debug/mono': file('t', { size: 4 * KB }),
      'crates/core/Cargo.toml': '[package]\nname = "core"\n',
      'crates/core/src/lib.rs': 'pub fn core() {}\n',
      'crates/core/target/debug/libcore.rlib': file('c', { size: 4 * KB }),
    });

    const artifacts = await resolveArtifacts(
      f.root,
      declarations(f.root, { '.': ['rust'], 'crates/core': ['rust'] }),
      ALL,
    );

    expect(relPaths(artifacts)).toEqual([rel('crates', 'core', 'target'), 'target']);
    for (const artifact of artifacts) {
      expect(artifact.category).toBe('build');
      expect(artifact.bytes, 'sizes are attached by scan.ts, not here').toBe(0);
      expect(path.isAbsolute(artifact.path)).toBe(true);
      expect(artifact.path).toBe(path.join(f.root, artifact.relPath));
    }
  });

  it('applies a nested declaration’s basenames across the whole project', async () => {
    // `xcode` is declared three levels down, but the project is one rolled-up unit, so
    // its basenames match at the root too. Anything else under-cleans every monorepo.
    const f = await tree({
      'Cargo.toml': '[package]\nname = "tinysync"\n',
      'DerivedData/Build/x.o': file('d', { size: KB }),
      'apps/mac/App.xcodeproj/project.pbxproj': '// objects\n',
      'apps/mac/build/Release/app.o': file('o', { size: KB }),
    });

    const artifacts = await resolveArtifacts(
      f.root,
      declarations(f.root, { '.': ['rust'], 'apps/mac': ['xcode'] }),
      ALL,
    );

    expect(relPaths(artifacts)).toEqual(['DerivedData', rel('apps', 'mac', 'build')]);
  });

  it('never descends into a directory it has already claimed', async () => {
    const f = await tree({
      'package.json': '{}\n',
      'node_modules/left-pad/package.json': '{}\n',
      'node_modules/left-pad/dist/index.js': file('x', { size: KB }),
    });

    const artifacts = await resolveArtifacts(f.root, declarations(f.root, { '.': ['node'] }), ALL);
    expect(relPaths(artifacts)).toEqual(['node_modules']);
  });
});

describe('resolveArtifacts: a value containing `/` is relative to the declaring directory', () => {
  it('matches under the declarer and nowhere else', async () => {
    const f = await tree({
      // The project root declares rust; only `sub` declares ruby.
      'Cargo.toml': '[package]\nname = "mono"\n',
      'sub/Gemfile': "source 'https://rubygems.org'\n",
      'sub/vendor/bundle/ruby/3.3/gems/rails/lib.rb': file('g', { size: KB }),
      // Same relative shape, but hanging off a directory that declares nothing.
      'vendor/bundle/decoy.rb': 'x\n',
      'sub/lib/vendor/bundle/decoy.rb': 'x\n',
    });

    const artifacts = await resolveArtifacts(
      f.root,
      declarations(f.root, { '.': ['rust'], sub: ['ruby'] }),
      ALL,
    );

    expect(relPaths(artifacts)).toEqual([rel('sub', 'vendor', 'bundle')]);
    expect(categoryOf(artifacts, rel('sub', 'vendor', 'bundle'))).toBe('deps');
  });

  it('matches a relative entry at the root declarer', async () => {
    const f = await tree({
      'pubspec.yaml': 'name: notchpad\n',
      'ios/.symlinks/plugins/x/lib.dart': file('s', { size: KB }),
      'ios/Runner/AppDelegate.swift': 'import Flutter\n',
      'android/build.gradle': "apply plugin: 'com.android.application'\n",
      'android/app/build/outputs/y.aar': file('a', { size: KB }),
      'android/app/src/main/Main.kt': 'fun main() {}\n',
    });

    const artifacts = await resolveArtifacts(
      f.root,
      declarations(f.root, { '.': ['flutter'], android: ['gradle'] }),
      ALL,
    );

    expect(relPaths(artifacts)).toEqual([
      rel('android', 'app', 'build'),
      rel('ios', '.symlinks'),
    ]);
    expect(categoryOf(artifacts, rel('ios', '.symlinks'))).toBe('deps');
    expect(categoryOf(artifacts, rel('android', 'app', 'build'))).toBe('build');
  });
});

describe('resolveArtifacts: a value containing `*` is a glob', () => {
  it('matches egg-info directories at any depth, and only those', async () => {
    const f = await tree({
      'pyproject.toml': '[project]\nname = "pysa"\n',
      'mypkg.egg-info/PKG-INFO': file('p', { size: KB }),
      'src/other.egg-info/PKG-INFO': file('o', { size: KB }),
      'egg-info/keep.txt': 'not an artifact\n',
      'src/pysa/__init__.py': '\n',
    });

    const artifacts = await resolveArtifacts(f.root, declarations(f.root, { '.': ['python'] }), ALL);

    expect(relPaths(artifacts)).toEqual(['mypkg.egg-info', rel('src', 'other.egg-info')]);
    expect(categoryOf(artifacts, 'mypkg.egg-info')).toBe('build');
  });

  it('matches cmake-build-* without matching its prefix', async () => {
    const f = await tree({
      'CMakeLists.txt': 'project(x)\n',
      'cmake-build-debug/CMakeCache.txt': file('c', { size: KB }),
      'cmake-build/keep.txt': 'not matched by cmake-build-*\n',
      'cmakebuild/keep.txt': 'nor this\n',
    });

    const artifacts = await resolveArtifacts(f.root, declarations(f.root, { '.': ['cmake'] }), ALL);
    expect(relPaths(artifacts)).toEqual(['cmake-build-debug']);
  });
});

// ─── dedup and the conservative category ─────────────────────────────────────────────

describe('the dedup rule', () => {
  /**
   * The rule the spec states: duplicates collapse by absolute path, and where they carry
   * different categories the **more conservative** one wins (`deps` > `build` > `cache`),
   * "so a directory is only cleaned under the preset that most explicitly opts into it".
   *
   * Asserted against `dedupeArtifacts` — the function `resolveArtifacts` runs every
   * candidate through — because the shipped table happens to contain no value claimed by
   * two types under different categories, so no fixture can produce the cross-category
   * case today. The rule still has to hold the day a type is added.
   */
  const claim = (relPath: string, category: Category): Artifact => ({
    path: `/projects/demo/${relPath}`,
    relPath,
    category,
    bytes: 0,
  });

  it('yields ONE artifact when two types claim the same directory', () => {
    const merged = dedupeArtifacts([claim('build', 'build'), claim('build', 'build')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.path).toBe('/projects/demo/build');
  });

  it('keeps the more conservative category: deps beats build', () => {
    expect(dedupeArtifacts([claim('x', 'build'), claim('x', 'deps')])).toEqual([
      claim('x', 'deps'),
    ]);
    expect(dedupeArtifacts([claim('x', 'deps'), claim('x', 'build')])).toEqual([
      claim('x', 'deps'),
    ]);
  });

  it('keeps the more conservative category: build beats cache', () => {
    expect(dedupeArtifacts([claim('x', 'cache'), claim('x', 'build')])).toEqual([
      claim('x', 'build'),
    ]);
    expect(dedupeArtifacts([claim('x', 'build'), claim('x', 'cache')])).toEqual([
      claim('x', 'build'),
    ]);
  });

  it('keeps the more conservative category: deps beats cache', () => {
    expect(dedupeArtifacts([claim('x', 'cache'), claim('x', 'deps')])).toEqual([
      claim('x', 'deps'),
    ]);
  });

  it('collapses three claims of three categories into the single most conservative', () => {
    const merged = dedupeArtifacts([
      claim('x', 'cache'),
      claim('x', 'build'),
      claim('x', 'deps'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.category).toBe('deps');
  });

  it('leaves distinct paths alone', () => {
    const merged = dedupeArtifacts([claim('a', 'build'), claim('b', 'deps')]);
    expect(merged).toHaveLength(2);
  });

  it('collapses a directory claimed by four types to one artifact', async () => {
    // `build` is claimed by node, flutter, gradle and cmake — one entry, not four.
    const f = await tree({
      'package.json': '{ "name": "poly" }\n',
      'pubspec.yaml': 'name: poly\n',
      'build.gradle': "apply plugin: 'java'\n",
      'CMakeLists.txt': 'project(poly)\n',
      'build/output.o': file('b', { size: KB }),
    });

    const artifacts = await resolveArtifacts(
      f.root,
      declarations(f.root, { '.': ['node', 'flutter', 'gradle', 'cmake'] }),
      ALL,
    );

    expect(artifacts.filter((artifact) => artifact.relPath === 'build')).toHaveLength(1);
    expect(categoryOf(artifacts, 'build')).toBe('build');
  });
});

// ─── safety ──────────────────────────────────────────────────────────────────────────

describe('resolveArtifacts: invariant 2 — never a symlink, never through one', () => {
  it('never returns an artifact-named symlink', async () => {
    const f = await tree({
      'proj/package.json': '{}\n',
      // Following either of these sizes, and then trashes, the user's home directory.
      'proj/node_modules': symlink(os.homedir()),
      'proj/build': symlink(os.homedir()),
      'proj/dist/bundle.js': file('d', { size: KB }),
    });

    const artifacts = await resolveArtifacts(
      f.path('proj'),
      declarations(f.path('proj'), { '.': ['node'] }),
      ALL,
    );

    expect(relPaths(artifacts)).toEqual(['dist']);
    for (const artifact of artifacts) {
      expect((await lstat(artifact.path)).isSymbolicLink(), artifact.path).toBe(false);
      expect((await lstat(artifact.path)).isDirectory(), artifact.path).toBe(true);
    }
  });

  it('never walks through a symlinked directory to reach artifacts outside the root', async () => {
    const f = await tree({
      'proj/package.json': '{}\n',
      'proj/src/index.ts': 'export const x = 1;\n',
      'elsewhere/node_modules/left-pad/index.js': file('m', { size: KB }),
      'elsewhere/dist/bundle.js': file('d', { size: KB }),
      'proj/link': symlink('../elsewhere'),
    });

    const artifacts = await resolveArtifacts(
      f.path('proj'),
      declarations(f.path('proj'), { '.': ['node'] }),
      ALL,
    );

    expect(artifacts).toEqual([]);
    for (const artifact of artifacts) {
      expect(artifact.path.startsWith(f.path('proj') + path.sep)).toBe(true);
    }
  });
});

describe('resolveArtifacts: `.git` is never descended', () => {
  it('ignores artifact-named directories inside .git', async () => {
    const f = await tree({
      'package.json': '{}\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/modules/sub/node_modules/x/index.js': file('m', { size: KB }),
      '.git/dist/objects.pack': file('p', { size: KB }),
      'dist/bundle.js': file('d', { size: KB }),
    });

    const artifacts = await resolveArtifacts(f.root, declarations(f.root, { '.': ['node'] }), ALL);

    expect(relPaths(artifacts)).toEqual(['dist']);
    for (const artifact of artifacts) {
      expect(artifact.relPath.split(path.sep)).not.toContain('.git');
    }
  });
});

describe('resolveArtifacts: invariant 6 — a linked worktree is a root, not an artifact', () => {
  const GITDIR = '/nonexistent/mono/.git/worktrees/build';

  it('never claims a worktree named `build`, `target` or `dist`, nor descends it', async () => {
    const f = await tree({
      'mono/Cargo.toml': '[package]\nname = "mono"\n',
      'mono/target/debug/mono': file('t', { size: KB }),
      // The trap: three worktrees whose names are in the artifact table.
      'mono/.worktrees/build': worktree(GITDIR),
      'mono/.worktrees/build/Cargo.toml': '[package]\nname = "mono"\n',
      'mono/.worktrees/build/src/lib.rs': 'pub fn feature() {}\n',
      'mono/.worktrees/build/target/debug/huge.rlib': file('w', { size: 2 * KB }),
      'mono/dist': worktree(GITDIR),
      'mono/dist/Cargo.toml': '[package]\nname = "mono"\n',
      'mono/dist/src/lib.rs': 'pub fn dist() {}\n',
      'mono/target-wt': worktree(GITDIR),
    });

    const artifacts = await resolveArtifacts(
      f.path('mono'),
      declarations(f.path('mono'), { '.': ['node', 'rust'] }),
      ALL,
    );

    expect(relPaths(artifacts)).toEqual(['target']);
    // Neither the worktree root nor anything inside it belongs to the parent.
    for (const artifact of artifacts) {
      expect(artifact.path.startsWith(f.path('mono', '.worktrees'))).toBe(false);
      expect(artifact.path).not.toBe(f.path('mono', 'dist'));
    }
  });

  it('still resolves a worktree’s own artifacts when the worktree IS the root', async () => {
    const f = await tree({
      'wt/build': worktree(GITDIR),
      'wt/build/Cargo.toml': '[package]\nname = "mono"\n',
      'wt/build/src/lib.rs': 'pub fn feature() {}\n',
      'wt/build/target/debug/huge.rlib': file('w', { size: 2 * KB }),
    });

    const artifacts = await resolveArtifacts(
      f.path('wt/build'),
      declarations(f.path('wt/build'), { '.': ['rust'] }),
      ALL,
    );

    expect(relPaths(artifacts)).toEqual(['target']);
  });
});

describe('resolveArtifacts: only directories', () => {
  it('never claims a regular file, however it is named', async () => {
    // `build` is very often an executable build script. Deleting it deletes source.
    const f = await tree({
      'package.json': '{}\n',
      build: '#!/bin/sh\nnpm run compile\n',
      dist: 'a file, not a directory\n',
      '.eslintcache': '{}\n',
      'out/bundle.js': file('o', { size: KB }),
    });

    const artifacts = await resolveArtifacts(f.root, declarations(f.root, { '.': ['node'] }), ALL);
    expect(relPaths(artifacts)).toEqual(['out']);
  });
});

// ─── category filtering and edges ────────────────────────────────────────────────────

describe('resolveArtifacts: category filtering', () => {
  const spec: FixtureSpec = {
    'package.json': '{}\n',
    'dist/bundle.js': file('d', { size: KB }),
    'node_modules/left-pad/index.js': file('m', { size: KB }),
    '.turbo/cache.log': file('t', { size: KB }),
    'src/index.ts': 'export const x = 1;\n',
  };

  it('returns only the enabled categories', async () => {
    const f = await tree(spec);
    const declared = declarations(f.root, { '.': ['node'] });

    expect(relPaths(await resolveArtifacts(f.root, declared, new Set<Category>(['build'])))).toEqual(
      ['dist'],
    );
    expect(relPaths(await resolveArtifacts(f.root, declared, new Set<Category>(['deps'])))).toEqual(
      ['node_modules'],
    );
    expect(relPaths(await resolveArtifacts(f.root, declared, new Set<Category>(['cache'])))).toEqual(
      ['.turbo'],
    );
    expect(relPaths(await resolveArtifacts(f.root, declared, ALL))).toEqual([
      '.turbo',
      'dist',
      'node_modules',
    ]);
  });

  it('labels each artifact with its category', async () => {
    const f = await tree(spec);
    const artifacts = await resolveArtifacts(f.root, declarations(f.root, { '.': ['node'] }), ALL);
    expect(categoryOf(artifacts, 'dist')).toBe('build');
    expect(categoryOf(artifacts, 'node_modules')).toBe('deps');
    expect(categoryOf(artifacts, '.turbo')).toBe('cache');
  });

  it('returns nothing for an empty category set', async () => {
    const f = await tree(spec);
    expect(
      await resolveArtifacts(f.root, declarations(f.root, { '.': ['node'] }), new Set<Category>()),
    ).toEqual([]);
  });
});

describe('resolveArtifacts: edges', () => {
  it('returns nothing when nothing is declared', async () => {
    const f = await tree({
      'dist/bundle.js': file('d', { size: KB }),
      'node_modules/x/index.js': file('m', { size: KB }),
    });
    expect(await resolveArtifacts(f.root, new Map(), ALL)).toEqual([]);
  });

  it('fails closed on a root that does not exist', async () => {
    const f = await tree({ 'proj/package.json': '{}\n' });
    const missing = f.path('proj/nope');
    expect(await resolveArtifacts(missing, declarations(missing, { '.': ['node'] }), ALL)).toEqual(
      [],
    );
  });

  it('returns a deterministic order', async () => {
    const f = await tree({
      'package.json': '{}\n',
      'dist/a.js': file('a', { size: KB }),
      'out/b.js': file('b', { size: KB }),
      'node_modules/x/index.js': file('m', { size: KB }),
      'packages/api/package.json': '{}\n',
      'packages/api/dist/c.js': file('c', { size: KB }),
    });
    const declared = declarations(f.root, { '.': ['node'], 'packages/api': ['node'] });

    const first = await resolveArtifacts(f.root, declared, ALL);
    const second = await resolveArtifacts(f.root, declared, ALL);
    expect(first.map((artifact) => artifact.relPath)).toEqual(
      second.map((artifact) => artifact.relPath),
    );
    expect(relPaths(first)).toEqual([
      'dist',
      'node_modules',
      'out',
      rel('packages', 'api', 'dist'),
    ]);
  });
});
