/**
 * `main` returns an exit code and never calls `process.exit`, which is what makes the entry
 * point testable at all: these tests import it and drive it directly.
 *
 * Every side effect `main` has — scanning, rendering, cleaning, writing — arrives through
 * `MainDeps`, so the cases below assert not just what is printed but what is *not called*.
 * The degradation rule is a negative property: on a non-TTY stdout the tool must print the
 * static report and return, having neither rendered nor deleted anything.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import { HELP_TEXT, main, parseArgs, type CliIO, type MainDeps } from '../src/cli.js';
import { SafetyError } from '../src/types.js';
import type { CacheEntry, Category, CleanOutcome, Preset, Project } from '../src/types.js';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

const CATEGORIES: Record<Preset, Set<Category>> = {
  recommended: new Set<Category>(['build', 'cache']),
  aggressive: new Set<Category>(['build', 'deps', 'cache']),
  custom: new Set<Category>(['build']),
};

interface FakeIO extends CliIO {
  out(): string;
  err(): string;
}

function fakeIO(isTTY: boolean): FakeIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    isTTY,
    write: (text: string) => void stdout.push(text),
    writeError: (text: string) => void stderr.push(text),
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

function makeProject(name: string, bytes: number, status: 'active' | 'dormant'): Project {
  const root = `/scan/${name}`;
  return {
    root,
    name,
    types: new Set(['node'] as const),
    artifacts: [{ path: `${root}/dist`, relPath: 'dist', category: 'build', bytes }],
    bytes,
    activity: { status, idleMs: 200 * DAY, reason: 'no commits' },
  };
}

const CACHE: CacheEntry = {
  id: 'pnpm-store',
  label: 'pnpm store',
  path: '/home/dev/Library/pnpm/store',
  bytes: 8 * GB,
  note: 'hardlink target',
};

const NOW = 1_700_000_000_000;

/** The four dependencies these tests assert *were not* called are always spies. */
interface StubDeps extends MainDeps {
  scanAll: Mock;
  scanStream: Mock;
  runApp: Mock;
  clean: Mock;
}

/**
 * Every dependency stubbed, so a test that reaches an unstubbed one would touch the real
 * filesystem — and fail — rather than quietly passing.
 */
function stubDeps(io: CliIO, overrides: Partial<StubDeps> = {}): StubDeps {
  const base: StubDeps = {
    io,
    nowMs: NOW,
    scanAll: vi.fn(async () => ({
      projects: [makeProject('tinysync', 67 * GB, 'dormant')],
      caches: [CACHE],
    })),
    scanStream: vi.fn(async function* () {
      yield { kind: 'cache' as const, cache: CACHE };
      yield { kind: 'done' as const };
    }),
    runApp: vi.fn(async () => ({ cleaned: false, outcomes: [] as CleanOutcome[], trashedBytes: 0 })),
    clean: vi.fn(async () => [] as CleanOutcome[]),
    categoriesFor: (preset: Preset) => new Set(CATEGORIES[preset]),
    resolveScanRoot: async (root: string) => root,
    trash: async () => undefined,
  };
  return { ...base, ...overrides };
}

describe('parseArgs', () => {
  it('defaults to the current directory, the recommended preset, and caches on', () => {
    const options = parseArgs([], '/cwd');

    expect(options.roots).toEqual(['/cwd']);
    expect(options.preset).toBe('recommended');
    expect(options.includeCaches).toBe(true);
    expect(options.help).toBe(false);
    expect(options.version).toBe(false);
    expect(options.concurrency).toBeUndefined();
  });

  it('accepts one or many positional roots', () => {
    expect(parseArgs(['~/develop'], '/cwd').roots).toEqual(['~/develop']);
    expect(parseArgs(['a', 'b', 'c'], '/cwd').roots).toEqual(['a', 'b', 'c']);
  });

  it('parses the preset in every spelling', () => {
    expect(parseArgs(['--preset', 'aggressive'], '/cwd').preset).toBe('aggressive');
    expect(parseArgs(['--preset=aggressive'], '/cwd').preset).toBe('aggressive');
    expect(parseArgs(['-p', 'aggressive'], '/cwd').preset).toBe('aggressive');
    expect(parseArgs(['-p', 'recommended'], '/cwd').preset).toBe('recommended');
  });

  it('parses --no-caches, --concurrency, --help and --version', () => {
    expect(parseArgs(['--no-caches'], '/cwd').includeCaches).toBe(false);
    expect(parseArgs(['--concurrency', '8'], '/cwd').concurrency).toBe(8);
    expect(parseArgs(['--concurrency=8'], '/cwd').concurrency).toBe(8);
    expect(parseArgs(['--help'], '/cwd').help).toBe(true);
    expect(parseArgs(['-h'], '/cwd').help).toBe(true);
    expect(parseArgs(['--version'], '/cwd').version).toBe(true);
    expect(parseArgs(['-V'], '/cwd').version).toBe(true);
  });

  it('treats arguments after -- as roots, even when they look like flags', () => {
    expect(parseArgs(['--', '--weird-dir'], '/cwd').roots).toEqual(['--weird-dir']);
  });

  it('throws on an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--yes'], '/cwd')).toThrow(/unknown option/i);
    expect(() => parseArgs(['-z'], '/cwd')).toThrow(/unknown option/i);
  });

  it('throws on a bad or missing option value', () => {
    expect(() => parseArgs(['--preset', 'yolo'], '/cwd')).toThrow(/preset/i);
    expect(() => parseArgs(['--preset'], '/cwd')).toThrow(/preset/i);
    expect(() => parseArgs(['--concurrency', 'lots'], '/cwd')).toThrow(/concurrency/i);
    expect(() => parseArgs(['--concurrency', '0'], '/cwd')).toThrow(/concurrency/i);
  });
});

describe('main', () => {
  it('never calls process.exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const io = fakeIO(false);
      await main([], stubDeps(io));
      await main(['--help'], stubDeps(io));
      await main(['--nope'], stubDeps(io));
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('prints help and scans nothing', async () => {
    const io = fakeIO(true);
    const deps = stubDeps(io);

    expect(await main(['--help'], deps)).toBe(0);
    expect(io.out()).toContain(HELP_TEXT);
    expect(io.out()).toContain('dev-cleaner');
    expect(deps.scanAll).not.toHaveBeenCalled();
    expect(deps.scanStream).not.toHaveBeenCalled();
    expect(deps.runApp).not.toHaveBeenCalled();
  });

  it('prints a version and scans nothing', async () => {
    const io = fakeIO(true);
    const deps = stubDeps(io);

    expect(await main(['--version'], deps)).toBe(0);
    expect(io.out()).toMatch(/\d+\.\d+\.\d+/);
    expect(deps.scanAll).not.toHaveBeenCalled();
  });

  describe('when stdout is not a TTY', () => {
    it('prints the static report and returns 0 without rendering or cleaning', async () => {
      const io = fakeIO(false);
      const deps = stubDeps(io);

      const code = await main(['/scan'], deps);

      expect(code).toBe(0);
      expect(io.out()).toContain('tinysync');
      expect(io.out()).toContain('67.0G');
      expect(io.out()).toMatch(/nothing was deleted/i);
      // The degradation rule, stated as the negatives it actually is.
      expect(deps.runApp).not.toHaveBeenCalled();
      expect(deps.clean).not.toHaveBeenCalled();
      expect(deps.scanStream).not.toHaveBeenCalled();
      expect(deps.scanAll).toHaveBeenCalledTimes(1);
    });

    it('scans with every category so the report can narrow to the preset', async () => {
      const io = fakeIO(false);
      const deps = stubDeps(io);

      await main(['/scan', '--preset', 'recommended'], deps);

      const options = deps.scanAll.mock.calls[0]?.[0] as { categories: Set<Category> };
      expect([...options.categories].sort()).toEqual(['build', 'cache', 'deps']);
    });

    it('passes the parsed options through to the scan', async () => {
      const io = fakeIO(false);
      const deps = stubDeps(io);

      await main(['/scan', '--no-caches', '--concurrency', '6'], deps);

      const options = deps.scanAll.mock.calls[0]?.[0] as {
        roots: string[];
        includeCaches: boolean;
        concurrency?: number;
        nowMs: number;
      };
      expect(options.roots).toEqual(['/scan']);
      expect(options.includeCaches).toBe(false);
      expect(options.concurrency).toBe(6);
      expect(options.nowMs).toBe(NOW);
    });
  });

  describe('when stdout is a TTY', () => {
    it('renders the app over a live stream and cleans through the injected clean', async () => {
      const io = fakeIO(true);
      const deps = stubDeps(io);

      const code = await main(['/scan'], deps);

      expect(code).toBe(0);
      expect(deps.runApp).toHaveBeenCalledTimes(1);
      expect(deps.scanAll).not.toHaveBeenCalled();

      const props = deps.runApp.mock.calls[0]?.[0] as {
        stream: AsyncIterable<unknown>;
        categoriesFor: (preset: Preset) => Set<Category>;
        onClean: (targets: readonly never[]) => Promise<CleanOutcome[]>;
      };
      expect(props.stream[Symbol.asyncIterator]).toBeTypeOf('function');
      expect([...props.categoriesFor('recommended')].sort()).toEqual(['build', 'cache']);

      // Draining the stream is what feeds the cache allowlist that `clean` is given.
      for await (const _event of props.stream) void _event;
      await props.onClean([]);

      const options = deps.clean.mock.calls[0]?.[1] as {
        roots: readonly string[];
        allowedCachePaths: readonly string[];
      };
      expect(options.roots).toEqual(['/scan']);
      expect(options.allowedCachePaths).toContain(CACHE.path);
    });

    it('prints the trash disclosure after a clean, and nothing after a quit', async () => {
      const io = fakeIO(true);
      const cleaned = stubDeps(io, {
        runApp: vi.fn(async () => ({
          cleaned: true,
          outcomes: [
            {
              target: { kind: 'cache' as const, cache: CACHE },
              label: 'pnpm store',
              bytes: 8 * GB,
              outcome: 'trashed' as const,
            },
          ],
          trashedBytes: 8 * GB,
        })),
      });

      expect(await main(['/scan'], cleaned)).toBe(0);
      expect(io.out()).toContain('8.0G');
      expect(io.out()).toMatch(/empty/i);

      const quitIO = fakeIO(true);
      const quit = stubDeps(quitIO);
      expect(await main(['/scan'], quit)).toBe(0);
      expect(quitIO.out()).toBe('');
    });
  });

  describe('failure modes', () => {
    it('returns 3 and explains itself when the scan refuses a guarded root', async () => {
      const io = fakeIO(false);
      const deps = stubDeps(io, {
        scanAll: vi.fn(async () => {
          throw new SafetyError('root-is-home', 'refusing to scan the home directory');
        }),
      });

      const code = await main(['/Users/dev'], deps);

      expect(code).toBe(3);
      expect(io.err()).toContain('refusing to scan the home directory');
      expect(io.out()).toBe('');
    });

    it('returns 3 when a guarded root is caught before the interface renders', async () => {
      const io = fakeIO(true);
      const deps = stubDeps(io, {
        resolveScanRoot: async () => {
          throw new SafetyError('root-is-filesystem-root', 'refusing to scan /');
        },
      });

      expect(await main(['/'], deps)).toBe(3);
      expect(deps.runApp).not.toHaveBeenCalled();
    });

    it('returns 2 on a usage error and points at --help', async () => {
      const io = fakeIO(false);
      const deps = stubDeps(io);

      const code = await main(['--yes'], deps);

      expect(code).toBe(2);
      expect(io.err()).toMatch(/unknown option/i);
      expect(io.err()).toContain('--help');
      expect(deps.scanAll).not.toHaveBeenCalled();
    });

    it('returns 1 on an unexpected failure', async () => {
      const io = fakeIO(false);
      const deps = stubDeps(io, {
        scanAll: vi.fn(async () => {
          throw new Error('disk went away');
        }),
      });

      expect(await main(['/scan'], deps)).toBe(1);
      expect(io.err()).toContain('disk went away');
    });
  });
});

describe('HELP_TEXT', () => {
  it('documents the flags parseArgs accepts and the trash disclosure', () => {
    for (const flag of ['--preset', '--no-caches', '--concurrency', '--help', '--version']) {
      expect(HELP_TEXT).toContain(flag);
    }
    expect(HELP_TEXT).toMatch(/trash/i);
  });
});
