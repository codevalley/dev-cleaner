/**
 * `scan.ts` is the ONE place enrichment happens: a `DiscoveredProject` goes in, a complete
 * `Project` — with `bytes`, `git` and `activity` — comes out. The assertions below are
 * therefore mostly about *completeness*: no downstream consumer may ever receive a project
 * missing `activity`, because the TUI's protected-section logic reads it unconditionally.
 *
 * `scoreActivity`'s body is the plan's one intentional TODO and currently returns `active`
 * for everything. These tests assert the score is **populated and well-formed**, never that
 * it equals a particular status, so they keep passing when the real body lands.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { currentCacheEnv, listCaches } from '../src/caches.js';
import { scanAll, scanStream, type ScanEvent, type ScanOptions } from '../src/scan.js';
import type { CacheEntry, Category, Project } from '../src/types.js';
import { dir, file, fixture, type Fixture } from './fixture.js';

const execFileAsync = promisify(execFile);

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const ALL: Set<Category> = new Set<Category>(['build', 'deps', 'cache']);

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

function options(roots: string[], overrides: Partial<ScanOptions> = {}): ScanOptions {
  return {
    roots,
    categories: new Set(ALL),
    includeCaches: false,
    nowMs: NOW,
    ...overrides,
  };
}

async function collect(opts: ScanOptions): Promise<ScanEvent[]> {
  const events: ScanEvent[] = [];
  for await (const event of scanStream(opts)) events.push(event);
  return events;
}

function projectsOf(events: readonly ScanEvent[]): Project[] {
  return events.flatMap((e) => (e.kind === 'project' ? [e.project] : []));
}

function cachesOf(events: readonly ScanEvent[]): CacheEntry[] {
  return events.flatMap((e) => (e.kind === 'cache' ? [e.cache] : []));
}

function byName(projects: readonly Project[]): Map<string, Project> {
  return new Map(projects.map((p) => [p.name, p]));
}

/** Every project the pipeline emits must satisfy this, whatever its ecosystem or git state. */
function expectComplete(project: Project): void {
  expect(typeof project.root, `${project.name}: root`).toBe('string');
  expect(typeof project.name, `${project.name}: name`).toBe('string');
  expect(project.types, `${project.name}: types`).toBeInstanceOf(Set);
  expect(Array.isArray(project.artifacts), `${project.name}: artifacts`).toBe(true);

  expect(typeof project.bytes, `${project.name}: bytes`).toBe('number');
  expect(Number.isFinite(project.bytes), `${project.name}: bytes finite`).toBe(true);
  expect(project.bytes, `${project.name}: bytes non-negative`).toBeGreaterThanOrEqual(0);

  for (const artifact of project.artifacts) {
    expect(typeof artifact.bytes, `${project.name}/${artifact.relPath}: bytes`).toBe('number');
    expect(Number.isFinite(artifact.bytes)).toBe(true);
    expect(artifact.bytes).toBeGreaterThanOrEqual(0);
  }

  // The defect this module exists to prevent: a project reaching a consumer unscored.
  expect(project.activity, `${project.name}: activity`).toBeDefined();
  expect(['active', 'dormant']).toContain(project.activity.status);
  expect(typeof project.activity.idleMs, `${project.name}: idleMs`).toBe('number');
  expect(Number.isFinite(project.activity.idleMs)).toBe(true);
  expect(project.activity.idleMs).toBeGreaterThanOrEqual(0);
  expect(typeof project.activity.reason, `${project.name}: reason`).toBe('string');
  expect(project.activity.reason.length, `${project.name}: reason non-empty`).toBeGreaterThan(0);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  return stdout;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Fixture');
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-m', 'initial', '--no-verify');
}

/** A node project and a rust project side by side, each with real artifact bytes. */
async function twoProjects(): Promise<Fixture> {
  return tree({
    'projects/alpha/package.json': '{ "name": "alpha" }\n',
    'projects/alpha/src/index.js': 'export const a = 1;\n',
    'projects/alpha/node_modules/left-pad/index.js': file('n', { size: 4096 }),
    'projects/alpha/dist/bundle.js': file('d', { size: 2048 }),
    'projects/beta/Cargo.toml': '[package]\nname = "beta"\n',
    'projects/beta/src/main.rs': 'fn main() {}\n',
    'projects/beta/target/debug/beta': file('t', { size: 8192 }),
  });
}

describe('scanStream', () => {
  it('enriches every discovered project with bytes and a well-formed activity score', async () => {
    const f = await twoProjects();

    const events = await collect(options([f.path('projects')]));
    const projects = projectsOf(events);

    expect(projects).toHaveLength(2);
    for (const project of projects) expectComplete(project);

    const alpha = byName(projects).get('alpha');
    const beta = byName(projects).get('beta');
    expect(alpha, 'alpha discovered').toBeDefined();
    expect(beta, 'beta discovered').toBeDefined();

    // Sizes are real, not placeholder zeroes left over from discover().
    expect(alpha!.bytes).toBeGreaterThanOrEqual(4096 + 2048);
    expect(beta!.bytes).toBeGreaterThanOrEqual(8192);
    for (const artifact of alpha!.artifacts) expect(artifact.bytes).toBeGreaterThan(0);
  });

  it("sums each project's bytes from its own artifacts", async () => {
    const f = await twoProjects();

    for (const project of projectsOf(await collect(options([f.path('projects')])))) {
      const total = project.artifacts.reduce((sum, a) => sum + a.bytes, 0);
      expect(project.bytes, `${project.name}: bytes is the artifact sum`).toBe(total);
    }
  });

  it('attaches git info for a repository and leaves it undefined otherwise', async () => {
    const f = await tree({
      'projects/repo/package.json': '{ "name": "repo" }\n',
      'projects/repo/.gitignore': 'node_modules/\n',
      'projects/repo/src/index.js': 'export const a = 1;\n',
      'projects/repo/node_modules/dep/index.js': file('n', { size: 1024 }),
      'projects/plain/Cargo.toml': '[package]\nname = "plain"\n',
      'projects/plain/target/debug/plain': file('t', { size: 1024 }),
    });
    await initRepo(f.path('projects/repo'));

    const projects = byName(projectsOf(await collect(options([f.path('projects')]))));

    const repo = projects.get('repo');
    expect(repo, 'repo discovered').toBeDefined();
    expect(repo!.git, 'repo has git info').toBeDefined();
    expect(repo!.git!.branch).toBe('main');
    expect(repo!.git!.lastCommitMs).toBeGreaterThan(0);

    const plain = projects.get('plain');
    expect(plain, 'plain discovered').toBeDefined();
    expect(plain!.git, 'non-repo has no git info').toBeUndefined();
    // ...and is still scored. A missing repository must never mean a missing score.
    expectComplete(plain!);
  });

  it('scores a nested linked worktree independently of its parent', async () => {
    const f = await tree({
      'projects/mono/Cargo.toml': '[package]\nname = "mono"\n',
      'projects/mono/.gitignore': 'target/\n',
      'projects/mono/src/main.rs': 'fn main() {}\n',
      'projects/mono/target/debug/mono': file('m', { size: 2048 }),
    });
    const mono = f.path('projects/mono');
    await initRepo(mono);
    // Named `build` deliberately: the worktree-before-artifact ordering (invariant 6) is
    // what keeps this a project rather than a delete candidate.
    await git(mono, 'worktree', 'add', '-b', 'feature', 'build');

    const worktreeDir = f.path('projects/mono/build');
    await mkdir(path.join(worktreeDir, 'target', 'debug'), { recursive: true });
    await writeFile(path.join(worktreeDir, 'target', 'debug', 'mono'), Buffer.alloc(4096));

    const projects = projectsOf(await collect(options([f.path('projects')])));

    for (const project of projects) expectComplete(project);

    const roots = projects.map((p) => p.root);
    expect(roots, 'the worktree is its own project root').toContain(worktreeDir);
    expect(roots, 'the parent is still a project root').toContain(mono);

    const worktreeProject = projects.find((p) => p.root === worktreeDir)!;
    expect(worktreeProject.activity, 'the worktree is scored in its own right').toBeDefined();
    expect(worktreeProject.bytes, 'the worktree owns its own artifact bytes').toBeGreaterThan(0);
    expect(
      worktreeProject.artifacts.every((a) => a.path.startsWith(worktreeDir)),
      'no parent artifact is attributed to the worktree',
    ).toBe(true);
  });

  it('honours the requested categories', async () => {
    const f = await tree({
      'projects/alpha/package.json': '{ "name": "alpha" }\n',
      'projects/alpha/node_modules/dep/index.js': file('n', { size: 1024 }),
      'projects/alpha/dist/bundle.js': file('d', { size: 1024 }),
    });

    const buildOnly = projectsOf(
      await collect(options([f.path('projects')], { categories: new Set<Category>(['build']) })),
    );

    expect(buildOnly).toHaveLength(1);
    const relPaths = buildOnly[0]!.artifacts.map((a) => a.relPath);
    expect(relPaths).toContain('dist');
    expect(relPaths, 'node_modules is a `deps` artifact and was not requested').not.toContain(
      'node_modules',
    );
  });

  it('emits exactly one terminating `done` event, last', async () => {
    const f = await twoProjects();

    const events = await collect(options([f.path('projects')]));

    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'done' });
  });

  it('emits `done` even when nothing is found', async () => {
    const f = await tree({ 'projects/empty-container': dir() });

    const events = await collect(options([f.path('projects')]));

    expect(events).toEqual([{ kind: 'done' }]);
  });

  it('yields the first project before the stream is drained', async () => {
    // Progressive rendering depends on this: the UI must not wait for a complete scan.
    const f = await twoProjects();

    const iterator = scanStream(options([f.path('projects')]))[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ kind: 'project' });
    expectComplete((first.value as { kind: 'project'; project: Project }).project);

    await iterator.return?.(undefined);
  });

  it('emits no cache events when includeCaches is false', async () => {
    const f = await twoProjects();

    const events = await collect(options([f.path('projects')], { includeCaches: false }));

    expect(cachesOf(events)).toEqual([]);
  });

  it('emits the machine’s caches when includeCaches is true', async () => {
    const f = await tree({
      'projects/alpha/package.json': '{ "name": "alpha" }\n',
      'projects/alpha/dist/bundle.js': file('d', { size: 1024 }),
      // Shaped like a home directory so the cache table resolves inside the fixture
      // rather than against the developer's real (potentially enormous) caches.
      'home/.npm/_cacache/index-v5/aa/data': file('c', { size: 2048 }),
      'home/.cache/blob': file('c', { size: 512 }),
    });

    const saved = { ...process.env };
    process.env['HOME'] = f.path('home');
    process.env['USERPROFILE'] = f.path('home');
    delete process.env['XDG_CACHE_HOME'];
    delete process.env['CARGO_HOME'];
    delete process.env['LOCALAPPDATA'];

    try {
      const expected = await listCaches(currentCacheEnv());
      const events = await collect(options([f.path('projects')], { includeCaches: true }));
      const caches = cachesOf(events);

      // Identity, not just count: scan must surface exactly the cache table, unaltered.
      // `bytes` is left out of the comparison — it is the one field that can legitimately
      // drift between two listings of a live directory.
      const identity = (list: readonly CacheEntry[]) =>
        list
          .map(({ id, label, path: p, note }) => ({ id, label, path: p, note }))
          .sort((a, b) => a.path.localeCompare(b.path));

      expect(identity(caches)).toEqual(identity(expected));
      for (const cache of caches) {
        expect(typeof cache.id).toBe('string');
        expect(cache.id.length).toBeGreaterThan(0);
        expect(typeof cache.label).toBe('string');
        expect(typeof cache.path).toBe('string');
        expect(typeof cache.note).toBe('string');
        expect(typeof cache.bytes).toBe('number');
        expect(cache.bytes).toBeGreaterThanOrEqual(0);
      }

      // Whatever the machine holds, `done` still terminates the stream last.
      expect(events.at(-1)).toEqual({ kind: 'done' });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it('scans several roots in one pass', async () => {
    const f = await tree({
      'one/alpha/package.json': '{ "name": "alpha" }\n',
      'one/alpha/dist/bundle.js': file('d', { size: 1024 }),
      'two/beta/Cargo.toml': '[package]\nname = "beta"\n',
      'two/beta/target/debug/beta': file('t', { size: 1024 }),
    });

    const projects = projectsOf(await collect(options([f.path('one'), f.path('two')])));

    expect(projects.map((p) => p.root).sort()).toEqual(
      [f.path('one/alpha'), f.path('two/beta')].sort(),
    );
    for (const project of projects) expectComplete(project);
  });
});

describe('scanAll', () => {
  it('collects exactly what scanStream yields', async () => {
    const f = await twoProjects();

    const streamed = projectsOf(await collect(options([f.path('projects')])));
    const result = await scanAll(options([f.path('projects')]));

    expect(result.projects.map((p) => p.root).sort()).toEqual(
      streamed.map((p) => p.root).sort(),
    );
    expect(result.projects.map((p) => p.bytes).sort()).toEqual(
      streamed.map((p) => p.bytes).sort(),
    );
    for (const project of result.projects) expectComplete(project);
  });

  it('returns an empty caches array when includeCaches is false', async () => {
    const f = await twoProjects();

    const result = await scanAll(options([f.path('projects')], { includeCaches: false }));

    expect(result.caches).toEqual([]);
    expect(result.projects.length).toBe(2);
  });

  it('never contains a `done` marker in its result', async () => {
    const f = await twoProjects();

    const result = await scanAll(options([f.path('projects')]));

    expect(Object.keys(result).sort()).toEqual(['caches', 'projects']);
  });
});
