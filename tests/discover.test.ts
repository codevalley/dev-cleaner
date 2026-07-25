/**
 * The walk: which directories become project roots, and what each one owns.
 *
 * `discover` answers three questions at once, and every test here pins exactly one of them:
 *
 * - **Where does a project start?** A directory holding `.git` or any type marker. A
 *   directory holding neither is a *container* — walked through, never listed.
 * - **Where does it stop?** Nowhere below, except at a linked worktree. Once a root is
 *   found no descendant becomes a second root, so a monorepo is one entry rather than
 *   twelve (spec: "Discovery and the roll-up rule").
 * - **What does it own?** The types declared anywhere in its rolled-up subtree, and the
 *   artifacts `resolveArtifacts` derives from them. Detecting only at the root would miss
 *   the artifacts of every nested sub-project, which in a monorepo is most of them.
 *
 * The adversarial cases — worktrees, symlinks, guarded roots — live in
 * `discover.safety.test.ts`. This file is the behaviour those safety rules protect.
 */

import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discover } from '../src/discover.js';
import type { Category, DiscoveredProject, ProjectType } from '../src/types.js';
import { dir, file, fixture, type Fixture } from './fixture.js';

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const ALL: readonly Category[] = ['build', 'deps', 'cache'];
const categories = (...values: Category[]): Set<Category> =>
  new Set<Category>(values.length === 0 ? ALL : values);

async function collect(
  roots: readonly string[],
  enabled: Set<Category> = categories(),
): Promise<DiscoveredProject[]> {
  const found: DiscoveredProject[] = [];
  for await (const project of discover(roots, enabled)) found.push(project);
  return found;
}

const rootsOf = (projects: readonly DiscoveredProject[]): string[] =>
  projects.map((project) => project.root).sort();

const namesOf = (projects: readonly DiscoveredProject[]): string[] =>
  projects.map((project) => project.name).sort();

function byRoot(projects: readonly DiscoveredProject[]): Map<string, DiscoveredProject> {
  return new Map(projects.map((project) => [project.root, project]));
}

function require_(projects: readonly DiscoveredProject[], root: string): DiscoveredProject {
  const project = byRoot(projects).get(root);
  expect(project, `no project discovered at ${root}`).toBeDefined();
  return project as DiscoveredProject;
}

const typesOf = (project: DiscoveredProject): ProjectType[] => [...project.types].sort();

const artifactPathsOf = (project: DiscoveredProject): string[] =>
  project.artifacts.map((artifact) => artifact.path).sort();

const relPathsOf = (project: DiscoveredProject): string[] =>
  project.artifacts.map((artifact) => artifact.relPath).sort();

describe('discover: roots and containers', () => {
  it('does not list an unmarked container, but does list its children', async () => {
    // `v2/` is the reference machine's shape: no marker of its own, two projects beneath.
    const f = await tree({
      'v2/zerolist/package.json': '{ "name": "zerolist" }\n',
      'v2/zerolist/src/index.ts': 'export const zero = 0;\n',
      'v2/zerolist/dist/bundle.js': file('d', { size: 1024 }),
      'v2/magicalll/Cargo.toml': '[package]\nname = "magicalll"\n',
      'v2/magicalll/target/debug/app': file('t', { size: 1024 }),
    });

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual([f.path('v2/magicalll'), f.path('v2/zerolist')].sort());
    expect(rootsOf(projects)).not.toContain(f.root);
    expect(rootsOf(projects)).not.toContain(f.path('v2'));
  });

  it('walks through several levels of container before finding anything', async () => {
    const f = await tree({
      'a/b/c/proj/package.json': '{ "name": "deep" }\n',
      'a/b/c/proj/dist/out.js': file('d', { size: 512 }),
    });

    expect(rootsOf(await collect([f.root]))).toEqual([f.path('a/b/c/proj')]);
  });

  it('treats the scan root itself as a project when it declares a type', async () => {
    const f = await tree({
      'Cargo.toml': '[package]\nname = "self"\n',
      'src/main.rs': 'fn main() {}\n',
      'target/debug/self': file('t', { size: 1024 }),
    });

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual([f.root]);
    // `path.relative(scanRoot, root)` is empty here; a project must still be nameable.
    expect(projects[0]!.name).toBe(path.basename(f.root));
  });

  it('treats a directory holding only a .git DIRECTORY as a project root', async () => {
    // No type marker at all: `.git` alone is enough to make a directory a project.
    const f = await tree({
      'repo/.git/HEAD': 'ref: refs/heads/main\n',
      'repo/README.md': '# repo\n',
    });

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual([f.path('repo')]);
    expect(projects[0]!.isWorktree).toBe(false);
  });

  it('yields nothing for a tree with no markers anywhere', async () => {
    const f = await tree({
      'notes/2026/january.md': '# january\n',
      empty: dir(),
    });

    expect(await collect([f.root])).toEqual([]);
  });

  it('names each project by its path relative to the scan root, with / separators', async () => {
    const f = await tree({
      'v2/zerolist/package.json': '{ "name": "zerolist" }\n',
      'tinysync/Cargo.toml': '[package]\nname = "tinysync"\n',
    });

    expect(namesOf(await collect([f.root]))).toEqual(['tinysync', 'v2/zerolist']);
  });

  it('scans several roots in one pass', async () => {
    const f = await tree({
      'one/alpha/package.json': '{ "name": "alpha" }\n',
      'two/beta/Cargo.toml': '[package]\nname = "beta"\n',
    });

    expect(rootsOf(await collect([f.path('one'), f.path('two')]))).toEqual(
      [f.path('one/alpha'), f.path('two/beta')].sort(),
    );
  });

  it('yields a project once even when the roots overlap', async () => {
    // `dev-cleaner ~/develop ~/develop/v2` must not offer the same directory twice; a
    // duplicated target is a duplicated delete and a double-counted total.
    const f = await tree({
      'v2/zerolist/package.json': '{ "name": "zerolist" }\n',
      'v2/zerolist/dist/out.js': file('d', { size: 512 }),
    });

    const projects = await collect([f.root, f.path('v2')]);

    expect(rootsOf(projects)).toEqual([f.path('v2/zerolist')]);
  });
});

describe('discover: the roll-up rule', () => {
  it('collapses a repository with nested markers into ONE project', async () => {
    // The `flutter/` SDK clone case: hundreds of nested `pubspec.yaml` files, one entry.
    const f = await tree({
      'mono/Cargo.toml': '[package]\nname = "mono"\n',
      'mono/src/main.rs': 'fn main() {}\n',
      'mono/crates/core/Cargo.toml': '[package]\nname = "core"\n',
      'mono/crates/core/src/lib.rs': 'pub fn core() {}\n',
      'mono/crates/util/Cargo.toml': '[package]\nname = "util"\n',
      'mono/crates/util/src/lib.rs': 'pub fn util() {}\n',
    });

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual([f.path('mono')]);
    expect(rootsOf(projects)).not.toContain(f.path('mono/crates/core'));
    expect(rootsOf(projects)).not.toContain(f.path('mono/crates/util'));
  });

  it('collects types across the whole rolled-up subtree, not only at the root', async () => {
    // `tinysync` declares rust at its root and xcode three levels down. Detecting only at
    // the root loses every artifact the sub-project names.
    const f = await tree({
      'tinysync/Cargo.toml': '[package]\nname = "tinysync"\n',
      'tinysync/src/main.rs': 'fn main() {}\n',
      'tinysync/apps/macos-file-provider/FileProvider.xcodeproj/project.pbxproj': '// objects\n',
      'tinysync/apps/macos-file-provider/Sources/main.swift': 'print("hi")\n',
    });

    expect(typesOf(require_(await collect([f.root]), f.path('tinysync')))).toEqual([
      'rust',
      'xcode',
    ]);
  });

  it('attributes a nested sub-project’s artifacts to the enclosing root', async () => {
    const f = await tree({
      'tinysync/Cargo.toml': '[package]\nname = "tinysync"\n',
      'tinysync/target/debug/tinysync': file('t', { size: 1024 }),
      'tinysync/crates/core/Cargo.toml': '[package]\nname = "core"\n',
      'tinysync/crates/core/target/debug/libcore.rlib': file('c', { size: 1024 }),
      'tinysync/apps/provider/Provider.xcodeproj/project.pbxproj': '// objects\n',
      'tinysync/apps/provider/build/Release/app.o': file('o', { size: 1024 }),
    });

    const project = require_(await collect([f.root]), f.path('tinysync'));

    expect(artifactPathsOf(project)).toEqual(
      [
        f.path('tinysync/target'),
        f.path('tinysync/crates/core/target'),
        f.path('tinysync/apps/provider/build'),
      ].sort(),
    );
  });

  it('resolves relative patterns against the directory that declared the type', async () => {
    // `app/build` is gradle's, anchored at `android/` where `build.gradle` lives.
    const f = await tree({
      'notchpad/pubspec.yaml': 'name: notchpad\n',
      'notchpad/lib/main.dart': 'void main() {}\n',
      'notchpad/.dart_tool/package_config.json': file('p', { size: 512 }),
      'notchpad/android/build.gradle': "apply plugin: 'x'\n",
      'notchpad/android/app/build/outputs/y.aar': file('a', { size: 512 }),
      'notchpad/ios/Runner.xcodeproj/project.pbxproj': '// objects\n',
      'notchpad/ios/Pods/Firebase/Firebase.h': file('h', { size: 512 }),
    });

    const project = require_(await collect([f.root]), f.path('notchpad'));

    expect(typesOf(project)).toEqual(['flutter', 'gradle', 'xcode']);
    expect(relPathsOf(project)).toEqual(
      ['.dart_tool', path.join('android', 'app', 'build'), path.join('ios', 'Pods')].sort(),
    );
  });
});

describe('discover: pruning', () => {
  it('never descends into node_modules', async () => {
    // A dependency that ships a `Cargo.toml` must not make the project rust, and its own
    // `target/` must not become a second delete candidate nested inside the first.
    const f = await tree({
      'proj/package.json': '{ "name": "proj" }\n',
      'proj/src/index.js': 'export const a = 1;\n',
      'proj/node_modules/.bin/tool': '#!/bin/sh\n',
      'proj/node_modules/native-dep/Cargo.toml': '[package]\nname = "native"\n',
      'proj/node_modules/native-dep/target/debug/native': file('n', { size: 1024 }),
      'proj/node_modules/nested/package.json': '{ "name": "nested" }\n',
    });

    const projects = await collect([f.root]);
    const project = require_(projects, f.path('proj'));

    expect(rootsOf(projects)).toEqual([f.path('proj')]);
    expect(typesOf(project), 'a dependency’s markers are not the project’s').toEqual(['node']);
    expect(artifactPathsOf(project)).toEqual([f.path('proj/node_modules')]);
  });

  it('never descends into an artifact directory, whatever it names', async () => {
    const f = await tree({
      'proj/Cargo.toml': '[package]\nname = "proj"\n',
      'proj/src/main.rs': 'fn main() {}\n',
      'proj/target/debug/build/inner/Cargo.toml': '[package]\nname = "inner"\n',
      'proj/target/debug/build/inner/target/x': file('x', { size: 256 }),
    });

    const project = require_(await collect([f.root]), f.path('proj'));

    expect(artifactPathsOf(project)).toEqual([f.path('proj/target')]);
  });

  it('never descends into a .git directory', async () => {
    // `.git/modules/<sub>` holds a whole repository layout; walking it invents projects.
    const f = await tree({
      'repo/.git/HEAD': 'ref: refs/heads/main\n',
      'repo/.git/modules/sub/package.json': '{ "name": "phantom" }\n',
      'repo/.git/modules/sub/node_modules/dep/index.js': file('d', { size: 512 }),
      'repo/package.json': '{ "name": "repo" }\n',
      'repo/dist/out.js': file('o', { size: 512 }),
    });

    const projects = await collect([f.root]);
    const project = require_(projects, f.path('repo'));

    expect(rootsOf(projects)).toEqual([f.path('repo')]);
    expect(artifactPathsOf(project)).toEqual([f.path('repo/dist')]);
  });

  it('does not descend a container child whose name is an artifact name', async () => {
    const f = await tree({
      'node_modules/some-package/package.json': '{ "name": "some-package" }\n',
      'proj/package.json': '{ "name": "proj" }\n',
    });

    expect(rootsOf(await collect([f.root]))).toEqual([f.path('proj')]);
  });
});

describe('discover: categories and artifact shape', () => {
  it('passes the requested categories through to artifact resolution', async () => {
    const f = await tree({
      'proj/package.json': '{ "name": "proj" }\n',
      'proj/node_modules/dep/index.js': file('n', { size: 512 }),
      'proj/dist/out.js': file('d', { size: 512 }),
      'proj/.turbo/log': file('c', { size: 128 }),
    });

    const buildOnly = require_(await collect([f.root], categories('build')), f.path('proj'));
    expect(relPathsOf(buildOnly)).toEqual(['dist']);

    const everything = require_(await collect([f.root], categories()), f.path('proj'));
    expect(relPathsOf(everything)).toEqual(['.turbo', 'dist', 'node_modules']);
  });

  it('yields artifacts with absolute paths, root-relative relPaths and no sizes yet', async () => {
    // Sizing belongs to `scan.ts`; `discover` leaves `bytes` at 0 deliberately.
    const f = await tree({
      'proj/pubspec.yaml': 'name: proj\n',
      'proj/build/app/out.apk': file('b', { size: 4096 }),
    });

    const project = require_(await collect([f.root]), f.path('proj'));

    expect(project.artifacts).toHaveLength(1);
    const artifact = project.artifacts[0]!;
    expect(path.isAbsolute(artifact.path)).toBe(true);
    expect(artifact.path).toBe(f.path('proj/build'));
    expect(artifact.relPath).toBe('build');
    expect(artifact.category).toBe('build');
    expect(artifact.bytes, 'discover does not size; scan does').toBe(0);
  });

  it('yields a project that declares a type but owns no artifacts', async () => {
    const f = await tree({
      'proj/go.mod': 'module example.com/proj\n',
      'proj/main.go': 'package main\n',
    });

    const projects = await collect([f.root]);

    expect(rootsOf(projects)).toEqual([f.path('proj')]);
    expect(projects[0]!.artifacts).toEqual([]);
    expect(projects[0]!.isWorktree).toBe(false);
  });

  it('hands back a fresh types set the caller may mutate', async () => {
    const f = await tree({ 'proj/Cargo.toml': '[package]\nname = "proj"\n' });

    const first = require_(await collect([f.root]), f.path('proj'));
    first.types.add('node');

    expect(typesOf(require_(await collect([f.root]), f.path('proj')))).toEqual(['rust']);
  });
});

describe('discover: resilience', () => {
  it('yields nothing rather than throwing for a root that does not exist', async () => {
    const f = await tree({ placeholder: dir() });

    await expect(collect([f.path('no-such-directory')])).resolves.toEqual([]);
  });

  it('survives an unreadable directory mid-walk', async () => {
    const f = await tree({
      'good/package.json': '{ "name": "good" }\n',
      'good/dist/out.js': file('d', { size: 256 }),
      'locked/Cargo.toml': '[package]\nname = "locked"\n',
    });
    const { chmod } = await import('node:fs/promises');
    await chmod(f.path('locked'), 0o000);

    try {
      const projects = await collect([f.root]);
      expect(rootsOf(projects)).toContain(f.path('good'));
    } finally {
      await chmod(f.path('locked'), 0o755);
    }
  });
});
