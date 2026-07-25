import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectTypes, detectTypesFromNames } from '../src/detect.js';
import type { ProjectType } from '../src/types.js';
import { dir, fixture, type Fixture } from './fixture.js';

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const types = (...values: ProjectType[]): Set<ProjectType> => new Set(values);

describe('detectTypesFromNames', () => {
  it('detects a single type from its marker', () => {
    expect(detectTypesFromNames(['Cargo.toml', 'src', 'README.md'])).toEqual(types('rust'));
  });

  it('returns an empty set for a directory with no markers', () => {
    expect(detectTypesFromNames([])).toEqual(types());
    expect(detectTypesFromNames(['README.md', 'src', 'LICENSE', '.gitignore'])).toEqual(types());
  });

  it('detects every type in the spec matrix from its canonical marker', () => {
    const cases: Array<[string, ProjectType]> = [
      ['package.json', 'node'],
      ['Cargo.toml', 'rust'],
      ['pubspec.yaml', 'flutter'],
      ['Package.swift', 'xcode'],
      ['Runner.xcodeproj', 'xcode'],
      ['build.gradle', 'gradle'],
      ['build.gradle.kts', 'gradle'],
      ['settings.gradle', 'gradle'],
      ['settings.gradle.kts', 'gradle'],
      ['pyproject.toml', 'python'],
      ['requirements.txt', 'python'],
      ['Gemfile', 'ruby'],
      ['devise.gemspec', 'ruby'],
      ['go.mod', 'go'],
      ['App.csproj', 'dotnet'],
      ['CMakeLists.txt', 'cmake'],
    ];

    for (const [marker, expected] of cases) {
      expect(detectTypesFromNames([marker]), `${marker} should declare ${expected}`).toEqual(
        types(expected),
      );
    }
  });

  it('matches glob markers on the extension, not on a substring', () => {
    // `*.xcodeproj` and `*.csproj` are the two glob markers that carry a whole ecosystem.
    expect(detectTypesFromNames(['MyApp.xcodeproj'])).toEqual(types('xcode'));
    expect(detectTypesFromNames(['Some.Long.Name.xcodeproj'])).toEqual(types('xcode'));
    expect(detectTypesFromNames(['Web.Api.csproj'])).toEqual(types('dotnet'));

    // A near miss must not declare the type: the extension has to terminate the name.
    expect(detectTypesFromNames(['MyApp.xcodeproj.bak'])).toEqual(types());
    expect(detectTypesFromNames(['notes-about-xcodeproj.md'])).toEqual(types());
    expect(detectTypesFromNames(['App.csproj.user'])).toEqual(types());
    expect(detectTypesFromNames(['Gemfile.lock'])).toEqual(types());
    expect(detectTypesFromNames(['my-package.json'])).toEqual(types());
  });

  it('detects a polyglot Flutter tree as flutter + gradle + xcode + ruby at once', () => {
    // The spec's headline detection case: a single-type model under-cleans every mobile
    // project, so all four ecosystems must surface from one directory listing.
    const names = [
      'pubspec.yaml',
      'build.gradle',
      'Runner.xcodeproj',
      'Gemfile',
      'lib',
      'test',
      'README.md',
    ];

    expect(detectTypesFromNames(names)).toEqual(types('flutter', 'gradle', 'xcode', 'ruby'));
  });

  it('unions several markers for the same type without duplicating it', () => {
    const result = detectTypesFromNames([
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'Package.swift',
      'Runner.xcodeproj',
    ]);

    expect(result).toEqual(types('gradle', 'xcode'));
    expect(result.size).toBe(2);
  });

  it('is order-independent and does not mutate the input', () => {
    const names = ['Gemfile', 'package.json', 'go.mod'];
    const frozen = Object.freeze([...names]);

    expect(detectTypesFromNames(frozen)).toEqual(detectTypesFromNames([...names].reverse()));
    expect(frozen).toEqual(['Gemfile', 'package.json', 'go.mod']);
  });

  it('returns a fresh set each call, so callers may mutate it', () => {
    const first = detectTypesFromNames(['Cargo.toml']);
    first.add('node');

    expect(detectTypesFromNames(['Cargo.toml'])).toEqual(types('rust'));
  });
});

describe('detectTypes', () => {
  it('reads a real directory and classifies it', async () => {
    const f = await tree({
      'proj/Cargo.toml': '[package]\nname = "demo"\n',
      'proj/src/main.rs': 'fn main() {}\n',
      'proj/target': dir(),
    });

    await expect(detectTypes(f.path('proj'))).resolves.toEqual(types('rust'));
  });

  it('classifies a real polyglot directory as all four ecosystems', async () => {
    const f = await tree({
      'app/pubspec.yaml': 'name: app\n',
      'app/build.gradle': '// gradle\n',
      'app/Runner.xcodeproj/project.pbxproj': '// pbx\n',
      'app/Gemfile': "source 'https://rubygems.org'\n",
    });

    await expect(detectTypes(f.path('app'))).resolves.toEqual(
      types('flutter', 'gradle', 'xcode', 'ruby'),
    );
  });

  it('sees a directory-shaped marker such as *.xcodeproj', async () => {
    // `.xcodeproj` is a directory on disk; detection must not assume markers are files.
    const f = await tree({ 'ios/Runner.xcodeproj/project.pbxproj': '// pbx\n' });

    await expect(detectTypes(f.path('ios'))).resolves.toEqual(types('xcode'));
  });

  it('returns an empty set for an empty directory', async () => {
    const f = await tree({ empty: dir() });

    await expect(detectTypes(f.path('empty'))).resolves.toEqual(types());
  });

  it('fails closed on a nonexistent directory: empty set, never a throw', async () => {
    // A throw here would abort a whole scan mid-walk; an empty set only under-detects.
    await expect(detectTypes(path.join('/definitely', 'not', 'here', 'at-all'))).resolves.toEqual(
      types(),
    );
  });

  it('fails closed when the path is a file rather than a directory', async () => {
    const f = await tree({ 'notes.txt': 'hello' });

    await expect(detectTypes(f.path('notes.txt'))).resolves.toEqual(types());
  });

  it('fails closed on an unreadable directory', async () => {
    const f = await tree({ 'locked/Cargo.toml': '[package]\n' });
    const locked = f.path('locked');
    const { chmod } = await import('node:fs/promises');
    await chmod(locked, 0o000);

    try {
      const result = await detectTypes(locked);
      // Running as root defeats the permission bits; skip the assertion rather than
      // report a false pass.
      if (process.getuid?.() !== 0) expect(result).toEqual(types());
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
