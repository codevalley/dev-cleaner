/**
 * Regressions for defects found by adversarial review of the shipped code.
 *
 * Each case here was a real hole that the existing suite passed straight over, so each
 * test is written to fail against the code as it stood before the fix. The theme is the
 * same one that runs through `clean.safety.test.ts`: a guard proven only against the
 * *convenient* input is not proven at all.
 *
 * - **The default preset made invariant 5 vacuous.** `clean` tracked `node_modules` that
 *   were *selected and then failed*. Under the shipped default preset (`recommended`) the
 *   `deps` category is excluded, so no `node_modules` is ever a target, nothing fails,
 *   and the store prune proceeded — orphaning the hardlinks of every pnpm project on the
 *   machine. The failure-only signal cannot see targets that were never offered, which is
 *   why `CleanOptions.unselectedNodeModules` exists and is a *required* field.
 * - **`.git` as a directory walked past the worktree guard.** The guard tested only for
 *   the *file* form. `git clone -b gh-pages <repo> dist` leaves `dist/` a real repository
 *   whose unpushed commits exist nowhere else.
 * - **`$HOME` reached through a symlink passed the home guard.** `os.homedir()` is
 *   lexical; every path `clean` checks is a realpath. On the standard automount layout
 *   (`/home/me -> /export/home/me`) they differ and the guard missed.
 */

import { symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clean } from '../src/clean.js';
import type { CleanOptions } from '../src/clean.js';
import type {
  ActivityScore,
  Artifact,
  CacheEntry,
  CleanTarget,
  Project,
  ProjectType,
  TrashFn,
} from '../src/types.js';
import { fixture, type Fixture } from './fixture.js';

const KB = 1024;
const DORMANT: ActivityScore = { status: 'dormant', idleMs: 400 * 86_400_000, reason: 'test' };

let f: Fixture;

beforeAll(async () => {
  f = await fixture({
    // A pnpm-style project: node_modules on disk, hardlinking into the store below.
    'app/package.json': '{ "name": "app" }\n',
    'app/node_modules/.package-lock.json': '{}\n',
    'app/dist/bundle.js': 'console.log(1);\n',
    'caches/pnpm/store/v3/files/aa/deadbeef': 'x',

    // The gh-pages layout: `dist` is a real repository, not build output.
    'ghp/package.json': '{ "name": "ghp" }\n',
    'ghp/dist/.git/HEAD': 'ref: refs/heads/gh-pages\n',
    'ghp/dist/index.html': '<!doctype html>\n',

    // A home directory reachable by two names, as an automount presents it.
    'export/home/me/package.json': '{ "name": "dotfiles" }\n',
    'export/home/me/node_modules/left.js': 'x',
  });
});

afterAll(async () => {
  await f?.cleanup();
});

function artifactAt(root: string, rel: string, category: Artifact['category'] = 'deps'): Artifact {
  return { path: path.join(root, rel), relPath: rel, category, bytes: KB };
}

function projectAt(root: string, name: string, artifacts: Artifact[]): Project {
  return {
    root,
    name,
    types: new Set<ProjectType>(['node']),
    artifacts,
    bytes: artifacts.reduce((sum, a) => sum + a.bytes, 0),
    activity: DORMANT,
  };
}

function cacheAt(id: string, target: string): CacheEntry {
  return { id, label: 'pnpm store', path: target, bytes: 8 * KB, note: 'test cache' };
}

function recordingTrash(): { trash: TrashFn; trashed: string[] } {
  const trashed: string[] = [];
  return { trash: async (paths) => void trashed.push(...paths), trashed };
}

function optionsWith(trash: TrashFn, overrides: Partial<CleanOptions> = {}): CleanOptions {
  return { trash, roots: [f.root], allowedCachePaths: [], unselectedNodeModules: [], ...overrides };
}

describe('invariant 5: the default preset must not orphan the store', () => {
  it('refuses the store prune when a node_modules is on disk but was never selected', async () => {
    // Exactly what `--preset recommended` produces: the store is a cache and is selected,
    // `node_modules` is `deps` and is not. Nothing fails, so a failure-only check sees a
    // clean run — and prunes the store out from under a project that still hardlinks it.
    const app = projectAt(f.path('app'), 'app', []);
    const dist = artifactAt(app.root, 'dist', 'build');
    app.artifacts = [dist];
    const store = cacheAt('pnpm-store', f.path('caches/pnpm/store'));

    const recorder = recordingTrash();
    const outcomes = await clean(
      [
        { kind: 'project', project: app, artifact: dist } satisfies CleanTarget,
        { kind: 'cache', cache: store } satisfies CleanTarget,
      ],
      optionsWith(recorder.trash, {
        allowedCachePaths: [store.path],
        // The scan saw it; the preset did not select it.
        unselectedNodeModules: [f.path('app/node_modules')],
      }),
    );

    const storeOutcome = outcomes.find((o) => o.target.kind === 'cache');
    expect(storeOutcome?.outcome).toBe('refused');
    expect(storeOutcome?.refusal).toBe('store-prune-unsafe');
    expect(recorder.trashed).not.toContain(store.path);

    // The unrelated build artifact is still cleaned — the guard is targeted, not a halt.
    expect(recorder.trashed).toContain(dist.path);
  });

  it('allows the store prune when no node_modules is left behind', async () => {
    // The opposite direction, so the test above cannot pass by refusing everything.
    const app = projectAt(f.path('app'), 'app', []);
    const nodeModules = artifactAt(app.root, 'node_modules', 'deps');
    app.artifacts = [nodeModules];
    const store = cacheAt('pnpm-store', f.path('caches/pnpm/store'));

    const recorder = recordingTrash();
    const outcomes = await clean(
      [
        { kind: 'project', project: app, artifact: nodeModules } satisfies CleanTarget,
        { kind: 'cache', cache: store } satisfies CleanTarget,
      ],
      optionsWith(recorder.trash, {
        allowedCachePaths: [store.path],
        unselectedNodeModules: [],
      }),
    );

    expect(outcomes.every((o) => o.outcome === 'trashed')).toBe(true);
    expect(recorder.trashed).toContain(store.path);
    // Ordering still holds: the hardlink source goes first.
    expect(recorder.trashed.indexOf(nodeModules.path)).toBeLessThan(
      recorder.trashed.indexOf(store.path),
    );
  });
});

describe('a real repository is never trashed as build output', () => {
  it('refuses a dist/ that is a git clone (.git is a DIRECTORY, not a file)', async () => {
    // `git clone -b gh-pages <repo> dist` — an everyday deploy layout. The worktree guard
    // tests for `.git` as a *file* and walks straight past this.
    const ghp = projectAt(f.path('ghp'), 'ghp', []);
    const dist = artifactAt(ghp.root, 'dist', 'build');
    ghp.artifacts = [dist];

    const recorder = recordingTrash();
    const [outcome] = await clean(
      [{ kind: 'project', project: ghp, artifact: dist } satisfies CleanTarget],
      optionsWith(recorder.trash),
    );

    expect(outcome?.outcome).toBe('refused');
    expect(outcome?.refusal).toBe('contains-repository');
    expect(recorder.trashed).toHaveLength(0);
  });
});

describe('invariant 3: $HOME reached through a symlink', () => {
  it('refuses the home directory when os.homedir() and its realpath differ', async () => {
    // The automount layout: /home/me -> /export/home/me. `os.homedir()` returns the
    // lexical name; every path clean checks is a realpath. A lexical-only comparison
    // never matches, and $HOME's own artifacts get trashed.
    const realHome = f.path('export/home/me');
    const linkedHome = f.path('home-link');
    await symlink(realHome, linkedHome, 'dir');

    const original = os.homedir;
    // The linked spelling is what the environment reports; the target is what clean sees.
    (os as { homedir: () => string }).homedir = () => linkedHome;
    try {
      const home = projectAt(realHome, 'dotfiles', []);
      const nodeModules = artifactAt(realHome, 'node_modules', 'deps');
      home.artifacts = [nodeModules];

      const recorder = recordingTrash();
      const [outcome] = await clean(
        [{ kind: 'project', project: home, artifact: nodeModules } satisfies CleanTarget],
        optionsWith(recorder.trash, { roots: [f.root] }),
      );

      expect(outcome?.outcome).toBe('refused');
      expect(outcome?.refusal).toBe('guarded-path');
      expect(recorder.trashed).toHaveLength(0);
    } finally {
      (os as { homedir: () => string }).homedir = original;
    }
  });
});
