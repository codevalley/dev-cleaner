/**
 * Invariant 5, asked of the filesystem rather than of the scan.
 *
 * `clean.ts` refuses a store prune when a `node_modules` it was told about is left behind.
 * That list can only hold what the *scan* walked, and the scan walks whatever directory the
 * user pointed at: `cd ~/work/api && dev-cleaner .` finds one project, trashes its
 * `node_modules` successfully, and hands `clean` an empty left-behind list — while every
 * other pnpm project on the machine still hardlinks into the store that is about to go to
 * the Trash. The tests below build exactly that arrangement on a real disk, with real
 * hardlinks, and assert the prune is refused anyway.
 *
 * They use the *real* probe (`deps.storeHasIncomingHardlinks` is left unset) for the same
 * reason `systemTrash` is pinned here: a default nothing exercises is a default that can be
 * replaced with a no-op without a single test noticing.
 */

import { chmod, link, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  HELP_TEXT,
  main,
  storeHasIncomingHardlinks,
  type CliIO,
  type MainDeps,
} from '../src/cli.js';
import { systemTrash } from '../src/clean.js';
import type { CleanOptions } from '../src/clean.js';
import type {
  CacheEntry,
  Category,
  CleanOutcome,
  CleanTarget,
  Preset,
  Project,
} from '../src/types.js';
import { fixture, type Fixture } from './fixture.js';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const CATEGORIES: Record<Preset, Set<Category>> = {
  recommended: new Set<Category>(['build', 'cache']),
  aggressive: new Set<Category>(['build', 'deps', 'cache']),
  custom: new Set<Category>(['build']),
};

function fakeIO(): CliIO & { out(): string } {
  const stdout: string[] = [];
  return {
    isTTY: true,
    write: (text: string) => void stdout.push(text),
    writeError: () => undefined,
    out: () => stdout.join(''),
  };
}

function nodeModulesProject(root: string): Project {
  return {
    root,
    name: path.basename(root),
    types: new Set(['node'] as const),
    artifacts: [
      {
        path: path.join(root, 'node_modules'),
        relPath: 'node_modules',
        category: 'deps',
        bytes: 2 * GB,
      },
    ],
    bytes: 2 * GB,
    activity: { status: 'dormant', idleMs: 200 * DAY, reason: 'no commits' },
  };
}

function storeCache(storePath: string, id = 'pnpm-store'): CacheEntry {
  return { id, label: 'pnpm store', path: storePath, bytes: 8 * GB, note: 'hardlink target' };
}

function projectTarget(project: Project): CleanTarget {
  const artifact = project.artifacts[0];
  if (artifact === undefined) throw new Error('project has no artifact');
  return { kind: 'project', project, artifact };
}

interface Run {
  /** What `main` returned. */
  code: number;
  /** The outcome list the interface was handed — `clean`'s, plus anything refused here. */
  outcomes: CleanOutcome[];
  /** The targets that actually reached `clean`. */
  cleaned: readonly CleanTarget[];
  options: CleanOptions;
  clean: Mock;
  out: string;
}

/**
 * Drive `main` all the way to a clean: a TTY, a scan stream carrying `events`, and a stand-in
 * interface that immediately confirms `targets`. `clean` is stubbed to trash everything it is
 * given, which is the state invariant 5's failure mode needs — every selected `node_modules`
 * succeeds, so nothing but the store screen itself can refuse the prune.
 */
async function runClean(
  roots: readonly string[],
  events: readonly { kind: 'project' | 'cache' | 'done'; project?: Project; cache?: CacheEntry }[],
  targets: readonly CleanTarget[],
  overrides: Partial<MainDeps> = {},
): Promise<Run> {
  const io = fakeIO();
  const clean = vi.fn(async (given: readonly CleanTarget[], _options: CleanOptions) =>
    given.map(
      (target): CleanOutcome => ({
        target,
        label: target.kind === 'cache' ? target.cache.label : target.artifact.relPath,
        bytes: target.kind === 'cache' ? target.cache.bytes : target.artifact.bytes,
        outcome: 'trashed',
      }),
    ),
  );

  let outcomes: CleanOutcome[] = [];
  const deps: MainDeps = {
    io,
    nowMs: NOW,
    clean,
    scanStream: () =>
      (async function* () {
        for (const event of events) yield event as never;
      })(),
    categoriesFor: (preset: Preset) => new Set(CATEGORIES[preset]),
    resolveScanRoot: async (root: string) => root,
    runApp: async (options) => {
      for await (const _event of options.stream) void _event;
      outcomes = await options.onClean(targets);
      const trashedBytes = outcomes
        .filter((outcome) => outcome.outcome === 'trashed')
        .reduce((sum, outcome) => sum + outcome.bytes, 0);
      return { cleaned: true, outcomes, trashedBytes, rounds: 1, trashEmptied: false };
    },
    trash: async () => undefined,
    ...overrides,
  };

  const code = await main([...roots], deps);
  return {
    code,
    outcomes,
    cleaned: (clean.mock.calls[0]?.[0] ?? []) as readonly CleanTarget[],
    options: (clean.mock.calls[0]?.[1] ?? {}) as CleanOptions,
    clean,
    out: io.out(),
  };
}

/** A store, a scanned project, and an unscanned one — the layout of the actual defect. */
async function machine(): Promise<{
  fx: Fixture;
  store: string;
  scanned: string;
  unscanned: string;
  storeFile: string;
}> {
  const fx = await fixture({
    'work/api/node_modules/.pnpm/left-pad/index.js': 'module.exports = 1;\n',
    'work/web/node_modules/.pnpm/left-pad/placeholder': 'x',
    'caches/pnpm/store/files/aa/1111111111': 'the package payload\n',
    'caches/pnpm/store/files/bb/2222222222': 'another payload\n',
  });
  return {
    fx,
    store: fx.path('caches/pnpm/store'),
    scanned: fx.path('work/api'),
    unscanned: fx.path('work/web'),
    storeFile: fx.path('caches/pnpm/store/files/aa/1111111111'),
  };
}

describe('storeHasIncomingHardlinks', () => {
  it('is false for a store whose every file has exactly one link', async () => {
    const { fx, store } = await machine();
    try {
      expect(await storeHasIncomingHardlinks(store)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  it('is true when a file in the store is hardlinked from somewhere else', async () => {
    const { fx, store, storeFile, unscanned } = await machine();
    try {
      await link(storeFile, path.join(unscanned, 'node_modules/.pnpm/left-pad/index.js'));
      expect(await storeHasIncomingHardlinks(store)).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it('does not mistake a directory for a hardlinked file', async () => {
    // Every directory on a POSIX filesystem has `nlink >= 2` (`.`, plus one per child
    // directory). A probe that stats entries without asking whether they are files reports
    // every store on earth as referenced — and, being fail-closed, does so invisibly.
    const { fx, store } = await machine();
    try {
      await mkdir(path.join(store, 'files/cc/nested/deeper'), { recursive: true });
      await writeFile(path.join(store, 'files/cc/nested/deeper/payload'), 'p');
      expect(await storeHasIncomingHardlinks(store)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  it('is true when the store cannot be read at all', async () => {
    const { fx, store } = await machine();
    try {
      expect(await storeHasIncomingHardlinks(path.join(store, 'does-not-exist'))).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it('is true when a symlink is found rather than following it out of the store', async () => {
    // Nothing in this store is hardlinked, so `true` can only come from the symlink rule:
    // following the link would answer a question about someone else's tree, and skipping it
    // would report a store as clear on the strength of a subtree never looked at.
    const { fx, store, unscanned } = await machine();
    try {
      expect(await storeHasIncomingHardlinks(store)).toBe(false);
      await symlink(unscanned, path.join(store, 'files/elsewhere'));
      expect(await storeHasIncomingHardlinks(store)).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it('is true when a file in the store cannot be stat`ed', async () => {
    // A directory readable but not searchable (0o444) lists its entries and refuses to stat
    // them — the link count is simply unavailable, which is not the same as it being 1.
    const { fx, store } = await machine();
    const locked = path.join(store, 'files/aa');
    try {
      await chmod(locked, 0o444);
      expect(await storeHasIncomingHardlinks(store)).toBe(true);
    } finally {
      await chmod(locked, 0o755);
      await fx.cleanup();
    }
  });

  it('is true when the budget runs out before the store is cleared', async () => {
    const { fx, store } = await machine();
    try {
      // A store too large to finish is a store that cannot be proven unreferenced.
      expect(await storeHasIncomingHardlinks(store, 1)).toBe(true);
      expect(await storeHasIncomingHardlinks(store, 200)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('the store prune, against a machine the scan did not cover', () => {
  it('is refused when an unscanned project still hardlinks into the store', async () => {
    const { fx, store, scanned, unscanned, storeFile } = await machine();
    try {
      await link(storeFile, path.join(unscanned, 'node_modules/.pnpm/left-pad/index.js'));

      const project = nodeModulesProject(scanned);
      const cache = storeCache(store);
      const run = await runClean(
        [scanned],
        [
          { kind: 'project', project },
          { kind: 'cache', cache },
          { kind: 'done' },
        ],
        [projectTarget(project), { kind: 'cache', cache }],
      );

      // The mechanism that used to carry invariant 5 is satisfied here: the one project the
      // scan found was selected, and `clean` trashed it. Nothing in scan scope objects.
      expect(run.options.unselectedNodeModules).toEqual([]);

      // The store never reaches `clean` …
      expect(run.cleaned.some((target) => target.kind === 'cache')).toBe(false);
      expect(run.cleaned).toHaveLength(1);

      // … and the interface is told why, in the vocabulary invariant 5 already uses.
      const refusal = run.outcomes.find((outcome) => outcome.target.kind === 'cache');
      expect(refusal?.outcome).toBe('refused');
      expect(refusal?.refusal).toBe('store-prune-unsafe');
      expect(refusal?.detail).toMatch(/hardlink/i);
      expect(refusal?.label).toBe('pnpm store');
      expect(refusal?.bytes).toBe(8 * GB);
      // Ordering survives: a store prune is the last thing a run would have done.
      expect(run.outcomes[run.outcomes.length - 1]).toBe(refusal);
      // Refused, not trashed — and invariant 8's arithmetic follows it out to stdout: the
      // closing line counts only the 2 G that actually moved, never the 8 G the store would
      // have been. That subtraction is the assertion; a total that silently included a
      // refusal would send the user to empty a Trash expecting four times what is in it.
      //
      // The refusal's own *wording* is no longer stdout's job. The per-outcome report now
      // renders inside the interface, one round at a time, where it can be read next to the
      // list it describes — so what it says is pinned against the round summary in
      // `ui.app.test.tsx`, and what it *is* is pinned by `run.outcomes` immediately above.
      expect(run.out).toContain('2.0G');
      expect(run.out).not.toContain('8.0G');
      expect(run.out).toMatch(/empty the Trash/i);
      expect(run.code).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  it('proceeds when nothing on the machine links into the store', async () => {
    const { fx, store, scanned } = await machine();
    try {
      const project = nodeModulesProject(scanned);
      const cache = storeCache(store);
      const run = await runClean(
        [scanned],
        [
          { kind: 'project', project },
          { kind: 'cache', cache },
          { kind: 'done' },
        ],
        [projectTarget(project), { kind: 'cache', cache }],
      );

      expect(run.cleaned).toHaveLength(2);
      expect(run.cleaned.some((target) => target.kind === 'cache')).toBe(true);
      expect(run.outcomes.every((outcome) => outcome.outcome === 'trashed')).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it('recognises a store by its shape as well as by its id', async () => {
    const { fx, store, scanned, unscanned, storeFile } = await machine();
    try {
      await link(storeFile, path.join(unscanned, 'node_modules/.pnpm/left-pad/index.js'));

      // Renaming the id in `caches.ts` must not switch the guard off.
      const cache = storeCache(store, 'pnpm-store-v10');
      const run = await runClean(
        [scanned],
        [{ kind: 'cache', cache }, { kind: 'done' }],
        [{ kind: 'cache', cache }],
      );

      expect(run.cleaned).toHaveLength(0);
      expect(run.outcomes[0]?.refusal).toBe('store-prune-unsafe');
    } finally {
      await fx.cleanup();
    }
  });

  it('recognises a store by its id as well as by its shape', async () => {
    const fx = await fixture({
      'caches/pkgstore/files/aa/1111': 'payload\n',
      'work/web/node_modules/.pnpm/left-pad/placeholder': 'x',
      'work/api/package.json': '{}',
    });
    try {
      // A store the path pattern does not match: only the id says what it is.
      await link(
        fx.path('caches/pkgstore/files/aa/1111'),
        fx.path('work/web/node_modules/.pnpm/left-pad/index.js'),
      );
      const cache = storeCache(fx.path('caches/pkgstore'));
      const run = await runClean(
        [fx.path('work/api')],
        [{ kind: 'cache', cache }, { kind: 'done' }],
        [{ kind: 'cache', cache }],
      );

      expect(run.cleaned).toHaveLength(0);
      expect(run.outcomes[0]?.refusal).toBe('store-prune-unsafe');
    } finally {
      await fx.cleanup();
    }
  });

  it('leaves ordinary caches alone and never probes them', async () => {
    const { fx, scanned } = await machine();
    try {
      const cache: CacheEntry = {
        id: 'gradle',
        label: 'gradle',
        path: fx.path('caches/gradle'),
        bytes: 6 * GB,
        note: 'build cache',
      };
      const probe = vi.fn(async () => true);
      const run = await runClean(
        [scanned],
        [{ kind: 'cache', cache }, { kind: 'done' }],
        [{ kind: 'cache', cache }],
        { storeHasIncomingHardlinks: probe },
      );

      expect(probe).not.toHaveBeenCalled();
      expect(run.cleaned).toHaveLength(1);
      expect(run.outcomes[0]?.outcome).toBe('trashed');
    } finally {
      await fx.cleanup();
    }
  });

  it('refuses when the probe itself fails, rather than assuming the store is free', async () => {
    const { fx, store, scanned } = await machine();
    try {
      const cache = storeCache(store);
      const run = await runClean(
        [scanned],
        [{ kind: 'cache', cache }, { kind: 'done' }],
        [{ kind: 'cache', cache }],
        {
          storeHasIncomingHardlinks: async () => {
            throw new Error('EIO');
          },
        },
      );

      expect(run.cleaned).toHaveLength(0);
      expect(run.outcomes[0]?.refusal).toBe('store-prune-unsafe');
    } finally {
      await fx.cleanup();
    }
  });

  it('asks the real filesystem when nothing is injected', async () => {
    // The two cases above differ only in whether a hardlink exists on disk, and neither
    // injects a probe: the shipped `storeHasIncomingHardlinks` is what produced both answers.
    // This case states the pin outright — a default no test exercises is a default that can
    // be replaced with `async () => false` in silence.
    const { fx, store, scanned, unscanned, storeFile } = await machine();
    try {
      const cache = storeCache(store);
      const before = await runClean(
        [scanned],
        [{ kind: 'cache', cache }, { kind: 'done' }],
        [{ kind: 'cache', cache }],
      );
      expect(before.cleaned).toHaveLength(1);

      await link(storeFile, path.join(unscanned, 'node_modules/.pnpm/left-pad/index.js'));

      const after = await runClean(
        [scanned],
        [{ kind: 'cache', cache }, { kind: 'done' }],
        [{ kind: 'cache', cache }],
      );
      expect(after.cleaned).toHaveLength(0);
      expect(after.outcomes[0]?.refusal).toBe('store-prune-unsafe');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('the trash the shipped program deletes through', () => {
  it('is systemTrash — the real one — when nothing is injected', async () => {
    // Every other CLI test injects `deps.trash`, so nothing else in the suite would notice
    // `const trash: TrashFn = async () => {}`: the suite would stay green while the shipped
    // binary quietly deleted nothing at all. This asserts the identity of the default.
    const { fx, scanned } = await machine();
    try {
      const run = await runClean([scanned], [{ kind: 'done' }], [], { trash: undefined });

      expect(run.options.trash).toBe(systemTrash);
      // And it is the function `clean.ts` documents, not a stub that happens to be exported.
      expect(typeof run.options.trash).toBe('function');
      expect(run.options.trash.length).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  it('is the injected trash when one is given', async () => {
    const { fx, scanned } = await machine();
    try {
      const injected = vi.fn(async () => undefined);
      const run = await runClean([scanned], [{ kind: 'done' }], [], { trash: injected });

      expect(run.options.trash).toBe(injected);
      expect(run.options.trash).not.toBe(systemTrash);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('HELP_TEXT', () => {
  it('states the store rule the user would otherwise have to infer from a refusal', () => {
    expect(HELP_TEXT).toMatch(/hardlink/i);
    expect(HELP_TEXT).toMatch(/store/i);
  });
});
