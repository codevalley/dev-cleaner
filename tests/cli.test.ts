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

import {
  HELP_TEXT,
  main,
  parseArgs,
  renderClosingLine,
  type CliIO,
  type MainDeps,
} from '../src/cli.js';
import { SafetyError } from '../src/types.js';
import type { CacheEntry, Category, CleanOutcome, Preset, Project } from '../src/types.js';
import { BIG_ROWS, WORDMARK, bigTextLines } from '../src/ui/glyphs.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;
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
    runApp: vi.fn(async () => ({
      cleaned: false,
      outcomes: [] as CleanOutcome[],
      trashedBytes: 0,
      rounds: 0,
      trashEmptied: false,
    })),
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

    it('also tells the scan which categories the preset will actually clean', async () => {
      // Two different sets, deliberately. The walk stays widest so pressing `p` never
      // re-walks a 133 GB tree; the cache table needs the *narrow* one to describe the
      // package store in terms of the run that is happening. Sending only the wide set is
      // what let the store's note describe `aggressive` while `recommended` was running.
      const io = fakeIO(false);
      const deps = stubDeps(io);

      await main(['/scan', '--preset', 'recommended'], deps);

      const options = deps.scanAll.mock.calls[0]?.[0] as {
        categories: Set<Category>;
        presetCategories?: ReadonlySet<Category>;
      };
      expect([...options.categories].sort()).toEqual(['build', 'cache', 'deps']);
      expect(options.presetCategories).toBeDefined();
      expect([...(options.presetCategories as ReadonlySet<Category>)].sort()).toEqual([
        'build',
        'cache',
      ]);
    });

    it('narrows the scan’s preset categories when the preset changes', async () => {
      const io = fakeIO(false);
      const deps = stubDeps(io);

      await main(['/scan', '--preset', 'aggressive'], deps);

      const options = deps.scanAll.mock.calls[0]?.[0] as {
        presetCategories?: ReadonlySet<Category>;
      };
      expect([...(options.presetCategories as ReadonlySet<Category>)].sort()).toEqual([
        'build',
        'cache',
        'deps',
      ]);
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

    it('tells the live scan the preset’s categories too, not only the report path', async () => {
      // The interactive path is the one a user actually sees the store row in, so an
      // honest note there matters more than in the piped report — and it is the path that
      // would be easiest to leave behind when wiring only `runStaticReport`.
      const io = fakeIO(true);
      const deps = stubDeps(io);

      await main(['/scan', '--preset', 'recommended'], deps);

      const options = deps.scanStream.mock.calls[0]?.[0] as {
        categories: Set<Category>;
        presetCategories?: ReadonlySet<Category>;
      };
      expect([...options.categories].sort()).toEqual(['build', 'cache', 'deps']);
      expect([...(options.presetCategories as ReadonlySet<Category>)].sort()).toEqual([
        'build',
        'cache',
      ]);
    });

    /**
     * What stdout owes the user once the interface is gone.
     *
     * The full per-outcome report now renders *inside* the interface, one round at a time,
     * where it can be read next to the list it describes. What is left here is the one thing a
     * terminal is genuinely better at than a torn-down TUI: a single durable line in the
     * scrollback. It still carries invariant 8's disclosure, because a user who does not know
     * the bytes are in the Trash rather than back on the disk will go looking for space that
     * is not there.
     */
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
          rounds: 1,
          trashEmptied: false,
        })),
      });

      expect(await main(['/scan'], cleaned)).toBe(0);
      expect(io.out()).toContain('8.0G');
      expect(io.out()).toMatch(/empty/i);

      // A goodbye, not a report: the per-target detail lives in the interface now. Asserted as
      // the absence of the outcome's own label rather than as a line count, because the shape
      // of the goodbye depends on the terminal it is printed into and this test has no terminal.
      expect(io.out()).not.toContain('pnpm store');
      expect(io.out().trimEnd().split('\n').length).toBeLessThanOrEqual(9);

      const quitIO = fakeIO(true);
      const quit = stubDeps(quitIO);
      expect(await main(['/scan'], quit)).toBe(0);
      expect(quitIO.out()).toBe('');
    });

    /**
     * The goodbye has two shapes and they are not alternatives: one is what a person reads and
     * one is what a log file keeps, and every claim either of them makes has to be true in both.
     *
     * So each fact below is asserted against `plain` (stdout redirected — no width, no colour)
     * *and* against `drawn` (a terminal with room for the block face). A property that only
     * held in the shape a test happened to pick would be a property the tool does not have.
     */
    describe('the closing line', () => {
      type Summary = Parameters<typeof renderClosingLine>[0];

      const SESSION: Summary = {
        cleaned: true,
        outcomes: [],
        trashedBytes: 8 * GB,
        rounds: 1,
        trashEmptied: false,
      };

      /** Redirected stdout: a width of zero is "there is no terminal to draw into". */
      const plain = (over: Partial<Summary> = {}): string =>
        renderClosingLine({ ...SESSION, ...over }, { width: 0, color: false });

      /** A terminal with room. Colour off by default so the text can be asserted directly. */
      const drawn = (over: Partial<Summary> = {}, width = 92): string =>
        renderClosingLine({ ...SESSION, ...over }, { width, color: false });

      /** Both shapes, for the facts that must not depend on which one is printed. */
      const both = (over: Partial<Summary> = {}): string[] => [plain(over), drawn(over)];

      const lines = (text: string): string[] => text.trimEnd().split('\n');

      it('says nothing at all when the session cleaned nothing', () => {
        // `dev-cleaner` used as a viewer must be as quiet as `ls`. Not even in a terminal wide
        // enough to draw a banner, and not even when bytes are somehow sitting in the field.
        expect(plain({ cleaned: false })).toBe('');
        expect(drawn({ cleaned: false })).toBe('');
        expect(drawn({ cleaned: false, trashedBytes: 8 * GB })).toBe('');
      });

      it('counts the session, not the round, and pluralises what it counts', () => {
        for (const text of both({ trashedBytes: 12 * GB, rounds: 3 })) {
          expect(text).toContain('12.0G');
          expect(text).toContain('3 rounds');
        }
        for (const text of both({ rounds: 1 })) {
          expect(text).toContain('1 round');
          expect(text).not.toContain('1 rounds');
        }
      });

      /**
       * The disclosure is conditional on being *true*. Once the user has emptied the Trash
       * from inside the interface, telling them the space is still occupied would send them
       * to empty an empty Trash looking for bytes they already have.
       */
      it('drops the disclosure exactly when the user has already emptied the Trash', () => {
        for (const text of both()) expect(text).toMatch(/empty the Trash/i);
        for (const text of both({ trashEmptied: true })) {
          expect(text).not.toMatch(/until you empty/i);
          expect(text).toMatch(/emptied/i);
        }
      });

      it('is a short branded block when stdout is redirected', () => {
        expect(plain()).toBe(
          `${WORDMARK}\n` +
            `Reclaimed 8.0G across 1 round · regenerable build output, off your disk's critical path.\n` +
            `Trashed files still occupy the disk until you empty the Trash.\n`,
        );
        expect(lines(plain()).length).toBeGreaterThanOrEqual(3);
      });

      it('draws the figure in the interface’s own block face when there is room for it', () => {
        // The same `bigTextLines` the round summary and the confirmation draw with — one font,
        // so `8.0G` is the same shape on the screen before this one and on this one.
        const glyphs = bigTextLines('8.0G') ?? [];
        expect(glyphs).toHaveLength(BIG_ROWS);

        const rendered = lines(drawn());
        for (const row of glyphs) expect(rendered).toContain(`  ${row}`);
        expect(rendered.filter((line) => line.includes('█')).length).toBeGreaterThanOrEqual(BIG_ROWS);
      });

      it('repeats the figure as text, because a glyph cannot be grepped or copied', () => {
        expect(drawn()).toContain('Reclaimed 8.0G across 1 round');
      });

      it('signs itself, so scrollback says which command left this behind', () => {
        expect(drawn()).toContain(WORDMARK);
        expect(plain()).toContain(WORDMARK);
      });

      /**
       * Invariant 8 in the tall shape. The disclosure is a whole line of its own there rather
       * than a clause at the end of a sentence, and a banner with no caveat under it is exactly
       * the overstatement the invariant exists to prevent.
       */
      it('keeps the Trash disclosure on its own line under the banner', () => {
        expect(lines(drawn())).toContain(
          '  Trashed files still occupy the disk until you empty the Trash.',
        );
        expect(lines(drawn({ trashEmptied: true }))).toContain(
          '  The Trash was emptied — that space is back.',
        );
      });

      /**
       * The headline is `trashedBytes` and nothing else. A session that trashed 2 G while an
       * 8 G store prune was refused must not put 10 G — or 8 G — anywhere near the figure.
       */
      it('never reads the outcomes: the headline is the trashed figure it was handed', () => {
        const withRefusal: Partial<Summary> = {
          trashedBytes: 2 * GB,
          outcomes: [
            {
              target: { kind: 'cache' as const, cache: CACHE },
              label: 'pnpm store',
              bytes: 8 * GB,
              outcome: 'refused' as const,
              refusal: 'store-prune-unsafe',
            },
          ],
        };
        for (const text of both(withRefusal)) {
          expect(text).toContain('2.0G');
          expect(text).not.toContain('8.0G');
          expect(text).not.toContain('10.0G');
          expect(text).not.toContain('pnpm store');
        }
      });

      it('falls back to a single line rather than wrap a banner in a narrow terminal', () => {
        for (const width of [1, 10, 20, 40, 60]) {
          const text = drawn({}, width);
          expect(text, `width ${width}`).not.toContain('█');
          expect(text, `width ${width}`).toMatch(/8\.0G/);
          expect(text, `width ${width}`).toMatch(/empty the Trash/i);
        }
      });

      it('falls back when a round happened but nothing reached the Trash', () => {
        // `cleaned` is `rounds > 0`, so a round in which every target was refused arrives here
        // with a zero figure. Five rows of `0B` would be a celebration of nothing.
        const nothing = drawn({ trashedBytes: 0 });
        expect(nothing).toBe(plain({ trashedBytes: 0 }));
        expect(nothing).not.toContain('█');
      });

      it('never draws a line wider than the terminal it was given', () => {
        for (const bytes of [512, 47.2 * MB, 8 * GB, 107 * GB, 3 * TB]) {
          for (let width = 20; width <= 120; width += 1) {
            for (const rounds of [1, 12]) {
              const text = drawn({ trashedBytes: bytes, rounds }, width);
              // The plain fallback is one sentence and is allowed to wrap; the tall shape is a
              // drawing, and a drawing that wraps is broken.
              if (!text.includes('█')) continue;
              for (const line of lines(text)) {
                expect(line.length, `${bytes} bytes at ${width} columns: ${line}`).toBeLessThanOrEqual(width);
              }
            }
          }
        }
      });

      it('ends with exactly one newline, so it cannot run into the shell prompt', () => {
        for (const text of [plain(), drawn()]) {
          expect(text.endsWith('\n')).toBe(true);
          expect(text.endsWith('\n\n')).toBe(false);
        }
      });

      /**
       * Colour is a hint. Strip every escape sequence and the rendering has to be identical to
       * the one a redirected stdout gets — nothing may be said in colour alone — and a
       * redirected stdout must never see an escape sequence at all.
       */
      it('adds colour only as emphasis, and only when it is allowed to', () => {
        const colored = renderClosingLine(SESSION, { width: 92, color: true });
        const stripped = colored.replace(/\u001B\[[0-9;]*m/g, '');

        expect(colored).toContain('\u001B[');
        expect(stripped).toBe(drawn());
        expect(drawn()).not.toContain('\u001B[');
        expect(plain()).not.toContain('\u001B[');
      });

      /**
       * The shipped call site passes no options at all — there is no component tree left to ask
       * by then — so the defaults are the behaviour, and they are what this asserts.
       */
      describe('when it is not told, it asks the real terminal', () => {
        const withStdout = (
          columns: number | undefined,
          isTTY: boolean | undefined,
          run: () => void,
        ): void => {
          const target = process.stdout as unknown as Record<string, unknown>;
          const saved = {
            columns: Object.getOwnPropertyDescriptor(target, 'columns'),
            isTTY: Object.getOwnPropertyDescriptor(target, 'isTTY'),
          };
          const restore = (key: 'columns' | 'isTTY'): void => {
            const descriptor = saved[key];
            if (descriptor === undefined) delete target[key];
            else Object.defineProperty(target, key, descriptor);
          };
          Object.defineProperty(target, 'columns', { value: columns, configurable: true });
          Object.defineProperty(target, 'isTTY', { value: isTTY, configurable: true });
          try {
            run();
          } finally {
            restore('columns');
            restore('isTTY');
          }
        };

        it('draws the tall shape, in colour, into a real terminal', () => {
          withStdout(100, true, () => {
            const text = renderClosingLine(SESSION);
            expect(text).toContain('█');
            expect(text).toContain('\u001B[');
          });
        });

        it('prints the one plain line into a pipe, with no escape sequences', () => {
          withStdout(undefined, undefined, () => {
            expect(renderClosingLine(SESSION)).toBe(plain());
          });
        });
      });
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
