/**
 * End-to-end verification against a tree shaped like the real `~/develop`.
 *
 * The unit suites prove each module in isolation. This one proves the *assembly*: a walk
 * that rolls up, a worktree that escapes the roll-up, a polyglot project whose artifacts
 * are scattered across four platform subdirectories, sizing, scoring, and finally a
 * `clean()` run whose `TrashFn` records rather than deletes.
 *
 * The fixture is deliberately built from the shapes that have historically gone wrong:
 *
 * - a **container** directory (`v2/`) that is not a project but whose children are;
 * - a **Rust monorepo** whose types are declared at three different depths, and which
 *   contains a linked worktree **named `build`** — the exact name that turns invariant 6
 *   from a wording into a consequence. A worktree named `namespace-foundation` passes
 *   while the invariant is broken; `build` is captured by a basename-first check and
 *   deleted, taking real source and any uncommitted work with it;
 * - a **polyglot Flutter project** — `flutter` + `gradle` + `xcode` + `ruby` — with output
 *   in `build/`, `.dart_tool/`, `android/.gradle/`, `android/app/build/` and `ios/Pods/`.
 *   A single-type model finds one of those five;
 * - a **symlink named `build`** pointing at `$HOME`, which must never become an artifact
 *   and therefore never a delete target (invariant 2).
 *
 * The load-bearing assertion is the last one, and it is stated as a *negative*: no path
 * handed to the `TrashFn` may be, or contain, a source file, a project root, or a worktree
 * root. Asserting that the right things were trashed is not enough — a run that trashes
 * every artifact *and* the repository that holds them also passes that test.
 */

import { lstat, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clean, type CleanOptions } from '../src/clean.js';
import { scanAll } from '../src/scan.js';
import type {
  Category,
  CleanOutcome,
  CleanTarget,
  Project,
  ProjectType,
  TrashFn,
} from '../src/types.js';
import {
  EMPTY_SELECTION,
  SECTION_ORDER,
  buildRows,
  toTargets,
  toggleSection,
  type Selection,
} from '../src/ui/model.js';
import { file, fixture, symlink, worktree, type Fixture } from './fixture.js';

const KB = 1024;
const MB = 1024 * KB;

const ALL_CATEGORIES: Set<Category> = new Set<Category>(['build', 'deps', 'cache']);

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

/**
 * Every basename that is allowed to appear as a delete target in this fixture, written out
 * literally rather than imported from `artifacts.ts`. Importing the table would make the
 * assertion circular — it would prove only that `clean` agrees with the same table that
 * produced the candidates, which is true even when both are wrong.
 */
const ALLOWED_TARGET_BASENAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.next',
  'target',
  'build',
  '.dart_tool',
  '.gradle',
  'Pods',
]);

/**
 * A `.git` file's `gitdir:` pointer. It intentionally names a path that does not exist:
 * nothing in the pipeline reads it, and `git` failing to open it is the realistic outcome
 * for a worktree whose main repository has moved. What matters is that `.git` is a FILE.
 */
const DANGLING_GITDIR = '/nonexistent/tinysync/.git/worktrees/build';

let f: Fixture;
let projects: Project[];

/** Absolute paths into the fixture, resolved once the temp root exists. */
let P: Record<string, string>;

beforeAll(async () => {
  f = await fixture({
    // ── v2/ is a container: no marker of its own, but its children are projects ───────
    'v2/zerolist/package.json': '{ "name": "zerolist" }\n',
    'v2/zerolist/src/index.ts': 'export const zero = 0;\n',
    'v2/zerolist/node_modules/left-pad/index.js': file('m', { size: 64 * KB }),
    'v2/zerolist/dist/bundle.js': file('d', { size: 32 * KB }),
    'v2/zerolist/.next/BUILD_ID': file('n', { size: 8 * KB }),

    'v2/magicalll/package.json': '{ "name": "magicalll" }\n',
    'v2/magicalll/src/app.ts': 'export const app = 1;\n',
    'v2/magicalll/node_modules/react/index.js': file('r', { size: 48 * KB }),
    // Invariant 2: an artifact-named SYMLINK. Following it would size, and then trash,
    // the user's entire home directory.
    'v2/magicalll/build': symlink(os.homedir()),

    // ── a Rust monorepo: types declared at three depths, artifacts at three depths ────
    'tinysync/Cargo.toml': '[package]\nname = "tinysync"\n',
    'tinysync/src/main.rs': 'fn main() {}\n',
    'tinysync/target/debug/tinysync': file('t', { size: 128 * KB }),
    'tinysync/crates/core/Cargo.toml': '[package]\nname = "core"\n',
    'tinysync/crates/core/src/lib.rs': 'pub fn core() {}\n',
    'tinysync/crates/core/target/debug/libcore.rlib': file('c', { size: 64 * KB }),
    // A nested Xcode sub-app: `tinysync` must come out as {rust, xcode}, and the sub-app
    // must NOT come out as a project of its own.
    'tinysync/apps/macos-file-provider/FileProvider.xcodeproj/project.pbxproj': '// objects\n',
    'tinysync/apps/macos-file-provider/Sources/main.swift': 'print("provider")\n',
    'tinysync/apps/macos-file-provider/build/Release/app.o': file('o', { size: 48 * KB }),

    // ── the trap: a linked worktree named `build`, nested inside the monorepo ─────────
    'tinysync/.worktrees/build': worktree(DANGLING_GITDIR),
    'tinysync/.worktrees/build/Cargo.toml': '[package]\nname = "tinysync"\n',
    'tinysync/.worktrees/build/src/lib.rs': 'pub fn feature() {}\n',
    // The largest single reclaimable item lives inside the worktree — which is exactly
    // the situation the worktree-as-root rule exists to make visible.
    'tinysync/.worktrees/build/target/debug/huge.rlib': file('w', { size: 2 * MB }),

    // ── a polyglot Flutter project: flutter + gradle + xcode + ruby ───────────────────
    'notchpad/pubspec.yaml': 'name: notchpad\n',
    'notchpad/lib/main.dart': 'void main() {}\n',
    'notchpad/Gemfile': "source 'https://rubygems.org'\n",
    'notchpad/build/app/outputs/app.apk': file('f', { size: 96 * KB }),
    'notchpad/.dart_tool/package_config.json': file('p', { size: 16 * KB }),
    'notchpad/android/build.gradle': "apply plugin: 'com.android.application'\n",
    'notchpad/android/.gradle/caches/modules/x.jar': file('g', { size: 24 * KB }),
    'notchpad/android/app/build/outputs/y.aar': file('a', { size: 20 * KB }),
    'notchpad/ios/Runner.xcodeproj/project.pbxproj': '// objects\n',
    'notchpad/ios/Runner/AppDelegate.swift': 'import Flutter\n',
    'notchpad/ios/Pods/Firebase/Firebase.h': file('h', { size: 40 * KB }),
  });

  P = {
    // project roots
    zerolist: f.path('v2/zerolist'),
    magicalll: f.path('v2/magicalll'),
    tinysync: f.path('tinysync'),
    worktree: f.path('tinysync/.worktrees/build'),
    notchpad: f.path('notchpad'),
    // containers, which must never be roots
    container: f.root,
    v2: f.path('v2'),
    // rolled-up subprojects, which must never be roots
    crate: f.path('tinysync/crates/core'),
    subapp: f.path('tinysync/apps/macos-file-provider'),
    // artifacts
    zerolistNodeModules: f.path('v2/zerolist/node_modules'),
    zerolistDist: f.path('v2/zerolist/dist'),
    zerolistNext: f.path('v2/zerolist/.next'),
    magicalllNodeModules: f.path('v2/magicalll/node_modules'),
    magicalllSymlink: f.path('v2/magicalll/build'),
    tinysyncTarget: f.path('tinysync/target'),
    crateTarget: f.path('tinysync/crates/core/target'),
    subappBuild: f.path('tinysync/apps/macos-file-provider/build'),
    worktreeTarget: f.path('tinysync/.worktrees/build/target'),
    notchpadBuild: f.path('notchpad/build'),
    notchpadDartTool: f.path('notchpad/.dart_tool'),
    notchpadGradle: f.path('notchpad/android/.gradle'),
    notchpadAndroidAppBuild: f.path('notchpad/android/app/build'),
    notchpadPods: f.path('notchpad/ios/Pods'),
  };

  const result = await scanAll({
    roots: [f.root],
    categories: new Set(ALL_CATEGORIES),
    includeCaches: false,
    nowMs: NOW,
  });
  projects = result.projects;
});

afterAll(async () => {
  await f?.cleanup();
});

/** Every file in the fixture that is source, not output. None may be trashed, ever. */
function sourceFiles(): string[] {
  return [
    f.path('v2/zerolist/package.json'),
    f.path('v2/zerolist/src/index.ts'),
    f.path('v2/magicalll/package.json'),
    f.path('v2/magicalll/src/app.ts'),
    f.path('tinysync/Cargo.toml'),
    f.path('tinysync/src/main.rs'),
    f.path('tinysync/crates/core/Cargo.toml'),
    f.path('tinysync/crates/core/src/lib.rs'),
    f.path('tinysync/apps/macos-file-provider/FileProvider.xcodeproj/project.pbxproj'),
    f.path('tinysync/apps/macos-file-provider/Sources/main.swift'),
    f.path('tinysync/.worktrees/build/.git'),
    f.path('tinysync/.worktrees/build/Cargo.toml'),
    f.path('tinysync/.worktrees/build/src/lib.rs'),
    f.path('notchpad/pubspec.yaml'),
    f.path('notchpad/lib/main.dart'),
    f.path('notchpad/Gemfile'),
    f.path('notchpad/android/build.gradle'),
    f.path('notchpad/ios/Runner.xcodeproj/project.pbxproj'),
    f.path('notchpad/ios/Runner/AppDelegate.swift'),
  ];
}

function projectRoots(): string[] {
  return [P.zerolist!, P.magicalll!, P.tinysync!, P.worktree!, P.notchpad!];
}

function byRoot(): Map<string, Project> {
  return new Map(projects.map((project) => [project.root, project]));
}

function requireProject(root: string): Project {
  const project = byRoot().get(root);
  expect(project, `no project discovered at ${root}`).toBeDefined();
  return project as Project;
}

function artifactPaths(project: Project): string[] {
  return project.artifacts.map((artifact) => artifact.path).sort();
}

function typesOf(project: Project): ProjectType[] {
  return [...project.types].sort();
}

/** True when `ancestor` is `descendant` or contains it — i.e. trashing it takes it out. */
function coversPath(ancestor: string, descendant: string): boolean {
  return descendant === ancestor || descendant.startsWith(ancestor + path.sep);
}

/** A `TrashFn` that records instead of deleting, so the fixture survives the assertions. */
function recordingTrash(): { trash: TrashFn; trashed: string[] } {
  const trashed: string[] = [];
  const trash: TrashFn = async (paths) => {
    trashed.push(...paths);
  };
  return { trash, trashed };
}

function cleanOptions(trash: TrashFn): CleanOptions {
  return { trash, roots: [f.root], allowedCachePaths: [], unselectedNodeModules: [] };
}

/** Every artifact of every discovered project, as `clean` wants them. */
function allTargets(): CleanTarget[] {
  return projects.flatMap((project) =>
    project.artifacts.map((artifact): CleanTarget => ({ kind: 'project', project, artifact })),
  );
}

describe('e2e: discovery against a tree shaped like ~/develop', () => {
  it('finds exactly the project roots, and neither containers nor rolled-up subprojects', () => {
    expect([...byRoot().keys()].sort()).toEqual(projectRoots().sort());
  });

  it('does not treat the scan root or an unmarked container as a project', () => {
    const roots = new Set(byRoot().keys());
    expect(roots.has(P.container!)).toBe(false);
    expect(roots.has(P.v2!)).toBe(false);
  });

  it('rolls a monorepo up to one project, collecting types across the whole subtree', () => {
    const roots = new Set(byRoot().keys());
    expect(roots.has(P.crate!)).toBe(false);
    expect(roots.has(P.subapp!)).toBe(false);

    // `rust` is declared at the root, `xcode` three levels down. Detecting only at the
    // root would miss every artifact of every nested sub-project.
    expect(typesOf(requireProject(P.tinysync!))).toEqual(['rust', 'xcode']);
  });

  it('attributes nested subproject artifacts to the enclosing root', () => {
    expect(artifactPaths(requireProject(P.tinysync!))).toEqual(
      [P.tinysyncTarget!, P.crateTarget!, P.subappBuild!].sort(),
    );
  });

  it('gives every project a size, a name and an activity score', () => {
    expect(projects).toHaveLength(5);
    for (const project of projects) {
      expect(project.name, `${project.root}: name`).not.toBe('');
      expect(project.bytes, `${project.root}: bytes`).toBeGreaterThan(0);
      expect(project.activity.status, `${project.root}: status`).toMatch(/^(active|dormant)$/);
      expect(typeof project.activity.reason, `${project.root}: reason`).toBe('string');
      for (const artifact of project.artifacts) {
        expect(artifact.bytes, `${artifact.path}: bytes`).toBeGreaterThan(0);
        expect(path.isAbsolute(artifact.path), `${artifact.path}: absolute`).toBe(true);
        expect(artifact.relPath, `${artifact.path}: relPath`).not.toBe('');
      }
    }
  });
});

describe('e2e: the nested worktree named `build`', () => {
  it('is its own project root, not an artifact of the repository containing it', () => {
    // Invariant 6. Basename-first matching captures `build` here and deletes a checkout.
    expect(byRoot().has(P.worktree!)).toBe(true);
    expect(artifactPaths(requireProject(P.tinysync!))).not.toContain(P.worktree!);
  });

  it('owns its own artifacts, which are not attributed to the parent', () => {
    expect(artifactPaths(requireProject(P.worktree!))).toEqual([P.worktreeTarget!]);

    const parentPaths = artifactPaths(requireProject(P.tinysync!));
    for (const candidate of parentPaths) {
      expect(coversPath(P.worktree!, candidate), `${candidate} belongs to the worktree`).toBe(
        false,
      );
    }
  });

  it('is scored and sized independently, so the parent’s recency cannot protect it', () => {
    const parent = requireProject(P.tinysync!);
    const wt = requireProject(P.worktree!);

    // Under plain roll-up the worktree's 2 MB would be attributed to `tinysync` and would
    // inherit its score. Independent sizing is what makes the two numbers differ at all.
    expect(wt.bytes).not.toBe(parent.bytes);
    expect(wt.activity.status).toMatch(/^(active|dormant)$/);
    expect(typeof wt.activity.idleMs).toBe('number');
    expect(typeof wt.activity.reason).toBe('string');
  });

  it('is the largest project, which is the whole point of scoring it separately', () => {
    const largest = [...projects].sort((a, b) => b.bytes - a.bytes)[0];
    expect(largest?.root).toBe(P.worktree!);
  });
});

describe('e2e: the polyglot Flutter project', () => {
  it('detects all four ecosystems from one tree', () => {
    expect(typesOf(requireProject(P.notchpad!))).toEqual(['flutter', 'gradle', 'ruby', 'xcode']);
  });

  it('finds artifacts scattered across build/, .dart_tool/, android/.gradle and ios/Pods', () => {
    expect(artifactPaths(requireProject(P.notchpad!))).toEqual(
      [
        P.notchpadBuild!,
        P.notchpadDartTool!,
        P.notchpadGradle!,
        P.notchpadAndroidAppBuild!,
        P.notchpadPods!,
      ].sort(),
    );
  });

  it('categorises each artifact conservatively', () => {
    const categories = new Map(
      requireProject(P.notchpad!).artifacts.map((artifact) => [artifact.path, artifact.category]),
    );
    expect(categories.get(P.notchpadBuild!)).toBe('build');
    expect(categories.get(P.notchpadDartTool!)).toBe('deps');
    expect(categories.get(P.notchpadPods!)).toBe('deps');
    expect(categories.get(P.notchpadGradle!)).toBe('cache');
  });
});

describe('e2e: symlinks (invariant 2)', () => {
  it('never turns an artifact-named symlink into an artifact', async () => {
    expect((await lstat(P.magicalllSymlink!)).isSymbolicLink()).toBe(true);

    const magicalll = requireProject(P.magicalll!);
    expect(artifactPaths(magicalll)).toEqual([P.magicalllNodeModules!]);
    for (const project of projects) {
      expect(artifactPaths(project)).not.toContain(P.magicalllSymlink!);
    }
  });
});

describe('e2e: clean() with a recording TrashFn', () => {
  let outcomes: CleanOutcome[];
  let trashed: string[];

  beforeAll(async () => {
    const recorder = recordingTrash();
    outcomes = await clean(allTargets(), cleanOptions(recorder.trash));
    trashed = recorder.trashed;
  });

  it('trashes every artifact and refuses none of them', () => {
    const refused = outcomes.filter((outcome) => outcome.outcome !== 'trashed');
    expect(
      refused.map((outcome) => `${outcome.label}: ${outcome.outcome} ${outcome.refusal ?? ''}`),
    ).toEqual([]);
    expect(outcomes).toHaveLength(allTargets().length);
  });

  it('targets exactly the artifact directories, and nothing else', () => {
    const expected = [
      P.zerolistNodeModules!,
      P.zerolistDist!,
      P.zerolistNext!,
      P.magicalllNodeModules!,
      P.tinysyncTarget!,
      P.crateTarget!,
      P.subappBuild!,
      P.worktreeTarget!,
      P.notchpadBuild!,
      P.notchpadDartTool!,
      P.notchpadGradle!,
      P.notchpadAndroidAppBuild!,
      P.notchpadPods!,
    ].sort();
    expect([...trashed].sort()).toEqual(expected);
  });

  it('never targets a source file, a project root or a worktree root', () => {
    // Stated as a negative and checked by containment, because trashing a directory takes
    // everything beneath it. A run that trashes every artifact AND the repository holding
    // them satisfies "the artifacts were trashed" perfectly well.
    const mustSurvive = [...sourceFiles(), ...projectRoots(), P.container!, P.v2!];
    for (const target of trashed) {
      for (const protectedPath of mustSurvive) {
        expect(
          coversPath(target, protectedPath),
          `trashing ${target} would remove ${protectedPath}`,
        ).toBe(false);
      }
    }
  });

  it('never targets the symlink, however it is named', () => {
    expect(trashed).not.toContain(P.magicalllSymlink!);
    expect(trashed).not.toContain(os.homedir());
  });

  it('trashes only real directories, none of them symlinks', async () => {
    for (const target of trashed) {
      const link = await lstat(target);
      expect(link.isSymbolicLink(), `${target} is a symlink`).toBe(false);
      expect((await stat(target)).isDirectory(), `${target} is not a directory`).toBe(true);
      expect(
        ALLOWED_TARGET_BASENAMES.has(path.basename(target)),
        `${target} has a basename outside the artifact table`,
      ).toBe(true);
    }
  });

  it('cleans the worktree’s artifacts on the same terms as any other project’s', () => {
    // Spec, "Worktrees": worktree status informs the user; it never gates a deletion. The
    // worktree ROOT is untouchable; its `target/` is ordinary build output.
    expect(trashed).toContain(P.worktreeTarget!);
    expect(trashed).not.toContain(P.worktree!);
  });

  it('reports the bytes it trashed', () => {
    const total = outcomes.reduce((sum, outcome) => sum + outcome.bytes, 0);
    expect(total).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(outcome.label, 'every outcome is labelled').not.toBe('');
    }
  });
});

describe('e2e: the path a user can actually invoke', () => {
  it('routes the interface’s selection into clean() without flattening it', async () => {
    // The UI builds `CleanTarget`s, not paths. Flattening to `{path, bytes}` would still
    // delete correctly here while making every guard in `clean.ts` unreachable from the
    // only code path a user can reach.
    const rows = buildRows({ projects, caches: [], categories: ALL_CATEGORIES });
    let selection: Selection = EMPTY_SELECTION;
    for (const section of SECTION_ORDER) selection = toggleSection(selection, rows, section);

    const targets = toTargets({ rows, selection, categories: ALL_CATEGORIES });
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.kind).toBe('project');
      if (target.kind === 'project') {
        expect(target.project.root).not.toBe('');
        expect(target.artifact.path).not.toBe('');
      }
    }

    const recorder = recordingTrash();
    const outcomes: CleanOutcome[] = await clean(targets, cleanOptions(recorder.trash));

    expect(outcomes.every((outcome) => outcome.outcome === 'trashed')).toBe(true);
    expect([...recorder.trashed].sort()).toEqual(
      projects.flatMap((project) => artifactPaths(project)).sort(),
    );
    for (const target of recorder.trashed) {
      for (const protectedPath of [...sourceFiles(), ...projectRoots()]) {
        expect(
          coversPath(target, protectedPath),
          `trashing ${target} would remove ${protectedPath}`,
        ).toBe(false);
      }
    }
  });
});
