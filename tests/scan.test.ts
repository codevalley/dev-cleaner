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
import { link, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { currentCacheEnv, listCaches } from '../src/caches.js';
import { countNodeModules, scanAll, scanStream, type ScanEvent, type ScanOptions } from '../src/scan.js';
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

  /**
   * The scan is where the screening has to happen, because the scan is what the user is
   * shown. A cache that arrives here unscreened gets preselected, counted into the promised
   * total, and refused at the deletion boundary — the tool promising 18.5G and delivering
   * 11G. These drive the *real* probe against a real hardlink, not an injected answer.
   */
  describe('the package store, screened before it is offered', () => {
    const RECOMMENDED = new Set<Category>(['build', 'cache']);

    /**
     * A home directory holding a pnpm store wherever the running platform looks for one —
     * macOS, Linux and Windows all covered, so the test asserts the same thing on any host
     * rather than silently becoming a no-op off macOS.
     */
    const STORE_DIRS = [
      'Library/pnpm/store', // darwin
      '.local/share/pnpm/store', // linux, XDG_DATA_HOME unset
      'AppData/Local/pnpm/store', // win32, LOCALAPPDATA unset
    ] as const;

    async function homeWithStore(): Promise<{ f: Fixture; restore: () => void }> {
      const spec: Record<string, ReturnType<typeof file>> = {
        'projects/alpha/package.json': file('{ "name": "alpha" }\n'),
        'projects/alpha/dist/bundle.js': file('d', { size: 1024 }),
      };
      for (const store of STORE_DIRS) spec[`home/${store}/files/aa/blob`] = file('p', { size: 4096 });
      const f = await tree(spec);

      const saved = { ...process.env };
      process.env['HOME'] = f.path('home');
      process.env['USERPROFILE'] = f.path('home');
      for (const key of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CARGO_HOME', 'LOCALAPPDATA']) {
        delete process.env[key];
      }

      return {
        f,
        restore: () => {
          for (const key of Object.keys(process.env)) {
            if (!(key in saved)) delete process.env[key];
          }
          Object.assign(process.env, saved);
        },
      };
    }

    const storeOf = (events: readonly ScanEvent[]): CacheEntry | undefined =>
      cachesOf(events).find((cache) => cache.id === 'pnpm-store');

    it('arrives blocked when a node_modules outside the scan still hardlinks into it', async () => {
      const { f, restore } = await homeWithStore();
      try {
        // The link is deliberately *outside* every scanned root: invariant 5 is a
        // machine-wide fact, and the scan's own scope can never establish it.
        for (const [index, store] of STORE_DIRS.entries()) {
          await link(
            f.path('home', ...store.split('/'), 'files', 'aa', 'blob'),
            f.path('home', `outside-node_modules-${index}`),
          );
        }

        const events = await collect(
          options([f.path('projects')], {
            includeCaches: true,
            presetCategories: RECOMMENDED,
          }),
        );

        const store = storeOf(events);
        expect(store).toBeDefined();
        expect(store?.blocked?.reason.length).toBeGreaterThan(0);
      } finally {
        restore();
      }
    });

    it('arrives clean when nothing links into it', async () => {
      const { f, restore } = await homeWithStore();
      try {
        const events = await collect(
          options([f.path('projects')], {
            includeCaches: true,
            presetCategories: RECOMMENDED,
          }),
        );

        const store = storeOf(events);
        expect(store).toBeDefined();
        expect(store?.blocked).toBeUndefined();
      } finally {
        restore();
      }
    });

    /**
     * The count, threaded from the walk to the table.
     *
     * `listCaches` can establish *that* the store is still held — it asks the filesystem —
     * but it has never walked a project and cannot know how many `node_modules` are sitting
     * there holding it. This is the one place both facts are in scope, and without the
     * hand-off the refusal a user reads is "a node_modules still links into it": which rule
     * fired, and nothing they can act on. (The real report was 31 of them, and a "why?".)
     */
    it('tells the cache table how many node_modules the walk found', async () => {
      const { f, restore } = await homeWithStore();
      try {
        for (const [index, store] of STORE_DIRS.entries()) {
          await link(
            f.path('home', ...store.split('/'), 'files', 'aa', 'blob'),
            f.path('home', `outside-node_modules-${index}`),
          );
        }
        // Three projects, three node_modules — and one `dist`, so the count is of
        // node_modules rather than of artifacts or of projects.
        for (const name of ['beta', 'gamma', 'delta']) {
          await mkdir(f.path('projects', name, 'node_modules', 'dep'), { recursive: true });
          await writeFile(f.path('projects', name, 'package.json'), `{ "name": "${name}" }\n`);
          await writeFile(
            f.path('projects', name, 'node_modules', 'dep', 'index.js'),
            Buffer.alloc(512),
          );
        }

        const store = storeOf(
          await collect(
            options([f.path('projects')], {
              includeCaches: true,
              presetCategories: RECOMMENDED,
            }),
          ),
        );

        // `alpha` has no node_modules, so this is 3 and not 4.
        expect(store?.blocked?.reason).toContain('3 node_modules found in this scan');
        expect(store?.note).toContain('3 found in this scan');
      } finally {
        restore();
      }
    });

    /**
     * Counted whatever the preset, because the count is a fact about the disk rather than
     * about the run. Under `recommended` the `deps` category is off and no `node_modules` is
     * a target at all — which is precisely when the store is refused, and precisely when the
     * user needs to know how many are holding it. Counting only what this run would trash
     * would report zero in the one configuration nearly every user runs.
     */
    it('counts node_modules the active preset will not touch', async () => {
      const { f, restore } = await homeWithStore();
      try {
        for (const [index, store] of STORE_DIRS.entries()) {
          await link(
            f.path('home', ...store.split('/'), 'files', 'aa', 'blob'),
            f.path('home', `outside-node_modules-${index}`),
          );
        }
        await mkdir(f.path('projects', 'alpha', 'node_modules', 'dep'), { recursive: true });
        await writeFile(
          f.path('projects', 'alpha', 'node_modules', 'dep', 'index.js'),
          Buffer.alloc(512),
        );

        const reasons = await Promise.all(
          [RECOMMENDED, ALL].map(
            async (presetCategories) =>
              storeOf(
                await collect(
                  options([f.path('projects')], { includeCaches: true, presetCategories }),
                ),
              )?.blocked?.reason,
          ),
        );

        for (const reason of reasons) expect(reason).toContain('1 node_modules found in this scan');
      } finally {
        restore();
      }
    });

    it('describes the store in terms of the preset that is actually running', async () => {
      const { f, restore } = await homeWithStore();
      try {
        for (const [index, store] of STORE_DIRS.entries()) {
          await link(
            f.path('home', ...store.split('/'), 'files', 'aa', 'blob'),
            f.path('home', `outside-node_modules-${index}`),
          );
        }

        const recommended = storeOf(
          await collect(
            options([f.path('projects')], {
              includeCaches: true,
              presetCategories: RECOMMENDED,
            }),
          ),
        );
        const aggressive = storeOf(
          await collect(
            options([f.path('projects')], { includeCaches: true, presetCategories: ALL }),
          ),
        );

        // `recommended` excludes `deps`, so no node_modules is trashed at all — which is
        // *why* the prune is refused. The shipped note said "those are trashed first",
        // describing a preset that was not running.
        expect(recommended?.note).toContain('does not trash node_modules');
        expect(recommended?.note).not.toContain('trashed first');
        expect(aggressive?.note).toContain('trashes those first');
      } finally {
        restore();
      }
    });
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

/**
 * The same count, for a consumer that already holds the projects.
 *
 * The interface needs it on the confirmation screen — "31 node_modules still link into it"
 * rather than "a node_modules still links into it" — and by then the scan has finished and
 * the number it handed the cache table is long gone. Exported rather than re-derived at the
 * call site because three modules already spell out what a `node_modules` is, and a fourth
 * spelling is a fourth chance to disagree with the one invariant 5 reasons about.
 */
describe('countNodeModules', () => {
  it('counts them across projects, and counts nothing else', async () => {
    const f = await tree({
      'projects/alpha/package.json': '{ "name": "alpha" }\n',
      'projects/alpha/node_modules/dep/index.js': file('n', { size: 512 }),
      'projects/alpha/dist/bundle.js': file('d', { size: 512 }),
      'projects/beta/package.json': '{ "name": "beta" }\n',
      'projects/beta/node_modules/dep/index.js': file('n', { size: 512 }),
      'projects/gamma/Cargo.toml': '[package]\nname = "gamma"\n',
      'projects/gamma/target/debug/gamma': file('t', { size: 512 }),
    });

    const projects = projectsOf(await collect(options([f.path('projects')])));

    expect(projects).toHaveLength(3);
    // Two node_modules among five artifacts: `dist` and `target` are build output, and a
    // count of artifacts or of projects would be three.
    expect(countNodeModules(projects)).toBe(2);
    expect(countNodeModules([])).toBe(0);
  });

  it('agrees with the number the stream hands the cache table', async () => {
    const f = await tree({
      'projects/alpha/package.json': '{ "name": "alpha" }\n',
      'projects/alpha/node_modules/dep/index.js': file('n', { size: 512 }),
      'projects/beta/package.json': '{ "name": "beta" }\n',
      'projects/beta/node_modules/dep/index.js': file('n', { size: 512 }),
      'projects/delta/package.json': '{ "name": "delta" }\n',
      'projects/delta/node_modules/dep/index.js': file('n', { size: 512 }),
    });

    const result = await scanAll(options([f.path('projects')]));

    // Three projects, three node_modules — the same 3 `scanStream` puts in the store's
    // reason. Two numbers for one fact, on two screens, is how they come to disagree.
    expect(countNodeModules(result.projects)).toBe(3);
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
