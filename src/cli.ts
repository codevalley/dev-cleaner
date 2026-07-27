#!/usr/bin/env node
/**
 * The entry point: parse arguments, then either render the interface or print the report.
 *
 * Three decisions shape this file.
 *
 * **`main` returns an exit code and never calls `process.exit`.** Only the entry guard at
 * the bottom touches the process, and it sets `process.exitCode` so buffered stdout is
 * flushed before Node leaves. That is what makes the tool testable end-to-end: `main` is an
 * ordinary async function a test can call and assert on.
 *
 * **Degradation is a negative property** (spec: "Degradation"). When stdout is not a TTY
 * the tool prints the static report and returns — it does not prompt, does not render, and
 * does not clean. Piping `dev-cleaner ~/develop | less` must be as safe as `ls`.
 *
 * **Everything past argument parsing arrives through `MainDeps`.** `dev-cleaner --help`
 * should not load React, Ink and the scanning pipeline, so the heavy modules are reached by
 * dynamic `import()` at the point of use. The same seam lets the tests drive `main` without
 * touching a real filesystem, and — more usefully — lets them assert that the non-TTY path
 * never reaches the deleting one.
 */

import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { storeHasIncomingHardlinks } from './caches.js';
import { renderScreenedReport } from './report.js';
import { SafetyError } from './types.js';
import type { Category, CleanOutcome, CleanTarget, Preset, TrashFn } from './types.js';
import { screenTargets } from './clean.js';
import type { CleanOptions, ScreeningTier } from './clean.js';
import type { ScanEvent, ScanOptions, ScanResult } from './scan.js';
import type { EmptyTrashResult, TrashSummary } from './trash.js';
import type { ExitSummary, RunOptions } from './ui/App.js';
import type { DiskUsage } from './ui/diskbar.js';
import { formatBytes } from './ui/format.js';
// `ui/glyphs.js` is the one display module this file may import statically: it is the block
// font and the wordmark with no React above them, so the goodbye can be drawn in the same face
// the interface used without `--help` paying for a renderer it never mounts.
import { WORDMARK, bigBytes } from './ui/glyphs.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_SAFETY = 3;

/**
 * The scan always walks the widest category set, whatever the preset. The preset only
 * decides what is *listed and selected* (spec: "Preset selection recomputes which artifacts
 * are selected; it does not re-walk the filesystem"), and pressing `p` in the interface
 * must not restart a scan that takes minutes on a 133 GB tree.
 */
const SCAN_CATEGORIES: readonly Category[] = ['build', 'deps', 'cache'];

export const HELP_TEXT = `dev-cleaner — find regenerable build artifacts and move them to the Trash.

Usage
  dev-cleaner [roots...] [options]

Arguments
  roots                 Directories to scan. Default: the current directory.

Options
  -p, --preset <name>   recommended (build + cache) or aggressive (build + deps + cache).
                        Default: recommended.
      --no-caches       Skip the global tool caches (pnpm, gradle, cargo, Xcode, …).
  -c, --concurrency <n> Directory-sizing concurrency. Default: CPU count, clamped to 4–16.
  -h, --help            Show this help.
  -V, --version         Show the version.

Notes
  Nothing is deleted without an explicit confirmation in the interactive interface.
  When stdout is not a terminal, dev-cleaner prints a static report and exits.
  Deletions go to the system Trash, which still occupies the disk until it is emptied.
  A package store is pruned only when nothing on the machine still hardlinks into it —
  including projects outside the directories being scanned.`;

export interface CliOptions {
  roots: string[];
  preset: Preset;
  includeCaches: boolean;
  concurrency?: number;
  help: boolean;
  version: boolean;
}

/** Stdout, stderr and "is this a terminal", as one injectable surface. */
export interface CliIO {
  write(text: string): void;
  writeError(text: string): void;
  isTTY: boolean;
}

export interface MainDeps {
  io?: CliIO;
  /** Injected in tests so a report is reproducible; defaults to `Date.now()`. */
  nowMs?: number;
  cwd?: string;
  scanAll?: (options: ScanOptions) => Promise<ScanResult>;
  scanStream?: (options: ScanOptions) => AsyncIterable<ScanEvent>;
  categoriesFor?: (preset: Preset) => Set<Category>;
  resolveScanRoot?: (root: string) => Promise<string>;
  runApp?: (options: RunOptions) => Promise<ExitSummary>;
  clean?: (
    targets: readonly CleanTarget[],
    options: CleanOptions,
  ) => Promise<CleanOutcome[]>;
  trash?: TrashFn;
  /**
   * Asks the filesystem whether anything still hardlinks into a package store — see
   * `storeHasIncomingHardlinks`, which is what the shipped program uses. Injected only by
   * tests that must answer the question without building a real store on disk.
   */
  storeHasIncomingHardlinks?: (storePath: string) => Promise<boolean>;
  readDiskUsage?: (pathOnVolume: string) => Promise<DiskUsage | undefined>;
  readTrashSummary?: () => Promise<TrashSummary>;
  emptyTrash?: () => Promise<EmptyTrashResult>;
}

function processIO(): CliIO {
  return {
    write: (text: string) => {
      process.stdout.write(text);
    },
    writeError: (text: string) => {
      process.stderr.write(text);
    },
    isTTY: process.stdout.isTTY === true,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read from the installed package rather than duplicated in a constant that drifts. */
export function version(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parsePreset(value: string): Preset {
  if (value === 'recommended' || value === 'aggressive') return value;
  // `custom` exists in the type but means "per-category checkboxes", which only the
  // interface can express. Accepting it here would hand `categoriesForPreset` a preset the
  // CLI cannot then let the user edit.
  throw new Error(`Invalid --preset '${value}'. Expected 'recommended' or 'aggressive'.`);
}

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
    throw new Error(`Invalid --concurrency '${value}'. Expected an integer between 1 and 64.`);
  }
  return parsed;
}

/**
 * Unknown flags **throw** rather than being collected as roots. A typo'd `--no-cache` that
 * silently became a directory name would scan the wrong thing while looking like it worked.
 */
export function parseArgs(argv: readonly string[], cwd: string = process.cwd()): CliOptions {
  const roots: string[] = [];
  let preset: Preset = 'recommended';
  let includeCaches = true;
  let concurrency: number | undefined;
  let help = false;
  let version_ = false;
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (optionsEnded || arg === '-' || !arg.startsWith('-')) {
      roots.push(arg);
      continue;
    }
    if (arg === '--') {
      optionsEnded = true;
      continue;
    }

    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`Option ${name} requires a value.`);
      index += 1;
      return next;
    };
    const rejectValue = (): void => {
      if (inline !== undefined) throw new Error(`Option ${name} does not take a value.`);
    };

    switch (name) {
      case '-h':
      case '--help':
        rejectValue();
        help = true;
        break;
      case '-V':
      case '--version':
        rejectValue();
        version_ = true;
        break;
      case '-p':
      case '--preset':
        preset = parsePreset(takeValue());
        break;
      case '--caches':
        rejectValue();
        includeCaches = true;
        break;
      case '--no-caches':
        rejectValue();
        includeCaches = false;
        break;
      case '-c':
      case '--concurrency':
        concurrency = parseConcurrency(takeValue());
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  const options: CliOptions = {
    roots: roots.length === 0 ? [cwd] : roots,
    preset,
    includeCaches,
    help,
    version: version_,
  };
  if (concurrency !== undefined) options.concurrency = concurrency;
  return options;
}

async function loadCategoriesFor(deps: MainDeps): Promise<(preset: Preset) => Set<Category>> {
  return deps.categoriesFor ?? (await import('./artifacts.js')).categoriesForPreset;
}

/**
 * `resolveScanRoot` applies the root guards (invariant 3) and returns the *real* path.
 * Doing it here rather than leaving it to the walk matters twice over: a guarded root is
 * refused before Ink takes over the screen, and `clean.ts`'s containment check receives the
 * same realpath'd roots the walk attributes projects to — on macOS a lexical `/var/...`
 * root would otherwise fail to contain a discovered `/private/var/...` project, and every
 * delete would be refused.
 */
async function resolveRoots(roots: readonly string[], deps: MainDeps): Promise<string[]> {
  const resolve = deps.resolveScanRoot ?? (await import('./discover.js')).resolveScanRoot;
  const resolved: string[] = [];
  for (const root of roots) resolved.push(await resolve(root));
  return resolved;
}

/**
 * `presetCategories` is the *narrow* set — what the preset will actually clean — and is
 * carried alongside the widest walk set, never instead of it. The scan still finds
 * everything; the cache table needs to know which of it the run will trash, so that the
 * package store is described in terms of the preset that is running rather than one that
 * is not.
 */
function scanOptionsFor(
  options: CliOptions,
  deps: MainDeps,
  presetCategories: ReadonlySet<Category>,
): ScanOptions {
  const scan: ScanOptions = {
    roots: options.roots,
    categories: new Set(SCAN_CATEGORIES),
    includeCaches: options.includeCaches,
    nowMs: deps.nowMs ?? Date.now(),
    presetCategories,
  };
  if (options.concurrency !== undefined) scan.concurrency = options.concurrency;
  return scan;
}

/**
 * Pass the stream through, remembering every cache path it carried. `clean.ts` refuses any
 * cache target not on that allowlist (`unknown-cache`), and the caches are only known once
 * the scan has produced them — so the allowlist is built from the same events the user saw,
 * not from a second, independently computed list that could disagree.
 */
async function* recordCaches(
  source: AsyncIterable<ScanEvent>,
  into: string[],
): AsyncGenerator<ScanEvent> {
  for await (const event of source) {
    if (event.kind === 'cache') into.push(event.cache.path);
    yield event;
  }
}

/**
 * Records every `node_modules` the scan discovers, whether or not it is selected.
 *
 * Invariant 5 asks whether any hardlink source will still be on disk when the run ends.
 * `clean` can see the ones that were *selected and failed*, but not the ones that were
 * never selected — and under the default preset that is every single one, since
 * `recommended` omits the `deps` category while still selecting the pnpm store.
 */
async function* recordNodeModules(
  source: AsyncIterable<ScanEvent>,
  into: string[],
): AsyncGenerator<ScanEvent> {
  for await (const event of source) {
    if (event.kind === 'project') {
      for (const artifact of event.project.artifacts) {
        if (path.basename(artifact.path) === 'node_modules') into.push(artifact.path);
      }
    }
    yield event;
  }
}

/**
 * Which cache is a package store, i.e. the hardlink *target* of project `node_modules`.
 *
 * Matched by id *or* by shape, exactly as `clean.ts` does. The predicate is deliberately
 * duplicated rather than imported: `clean.ts` does not export it, and — as with invariant 6
 * — a guard whose failure mode is silent is worth enforcing twice, independently. The two
 * copies can only disagree by one of them refusing something the other would allow, which
 * is the fail-closed direction.
 */
const STORE_PRUNE_IDS: ReadonlySet<string> = new Set(['pnpm-store']);
const STORE_PRUNE_PATH = /[\\/]pnpm[\\/]store[\\/]?$/i;

type CacheTarget = Extract<CleanTarget, { kind: 'cache' }>;

function isStorePruneTarget(target: CleanTarget): target is CacheTarget {
  if (target.kind !== 'cache') return false;
  return STORE_PRUNE_IDS.has(target.cache.id) || STORE_PRUNE_PATH.test(target.cache.path);
}

/**
 * The probe itself now lives in `caches.ts`, where the cache table can run it *before*
 * offering the store — so the default selection, the report's total and the interface all
 * describe the same outcome this file's boundary screening would produce. Re-exported here
 * because it is part of this module's contract with its tests, and because moving a guard
 * must not quietly change what can be asserted about it. One implementation, two callers:
 * the upstream one is about honesty, the one below is about safety.
 */
export { storeHasIncomingHardlinks };

/**
 * Splits the work list into the targets `clean` may proceed with and the store prunes this
 * run refuses outright, with the refusal already written as the outcome the summary shows.
 *
 * Refusing here rather than inside `clean` keeps the machine-wide question where the
 * evidence is — `clean` is handed a list and cannot know what the scan never looked at —
 * and leaves `clean.ts`'s own invariant-5 check untouched as the second line of defence.
 */
async function screenStorePrunes(
  targets: readonly CleanTarget[],
  probe: (storePath: string) => Promise<boolean>,
): Promise<{ safe: CleanTarget[]; refused: CleanOutcome[] }> {
  const safe: CleanTarget[] = [];
  const refused: CleanOutcome[] = [];

  for (const target of targets) {
    if (!isStorePruneTarget(target)) {
      safe.push(target);
      continue;
    }

    const { cache } = target;
    let referenced = true;
    try {
      referenced = await probe(cache.path);
    } catch {
      referenced = true;
    }
    if (!referenced) {
      safe.push(target);
      continue;
    }

    refused.push({
      target,
      label: cache.label.length > 0 ? cache.label : cache.path,
      bytes: cache.bytes,
      outcome: 'refused',
      refusal: 'store-prune-unsafe',
      detail:
        `${cache.path} still contains hardlinked files (or could not be fully checked), so ` +
        'a node_modules somewhere on this machine — including outside the scanned ' +
        'directories — still links into it, and pruning the store would orphan those links',
    });
  }

  return { safe, refused };
}

async function runStaticReport(
  options: CliOptions,
  deps: MainDeps,
  io: CliIO,
): Promise<number> {
  const scanAll = deps.scanAll ?? (await import('./scan.js')).scanAll;
  const categoriesFor = await loadCategoriesFor(deps);
  // One set, computed once, handed to both the scan and the report: the note the cache
  // table writes and the categories the report narrows to cannot then describe different
  // presets.
  const categories = categoriesFor(options.preset);

  const result = await scanAll(scanOptionsFor(options, deps, categories));

  // `renderScreenedReport`, never `renderReport`: the report's total is a promise about what
  // a clean would deliver, and the only way to keep it is to ask the deletion boundary's own
  // guards first. `options.roots` are the resolved ones — `main` replaces them before either
  // path runs — which is what `clean.ts`'s containment check compares against, so a report
  // and a run agree about which projects are in scope.
  io.write(
    await renderScreenedReport({
      projects: result.projects,
      caches: result.caches,
      categories,
      preset: options.preset,
      roots: options.roots,
    }),
  );
  return EXIT_OK;
}

/**
 * Where the goodbye gets its geometry and its colour.
 *
 * Both default to the real terminal, because by this point there is nothing else to ask: Ink has
 * unmounted, the component tree is gone, and the only thing left that knows how wide the screen
 * is is `process.stdout`. Tests pass them explicitly so a rendering is reproducible on a
 * machine whose terminal is 92 columns and on a CI worker whose stdout is a pipe.
 */
export interface ClosingLineOptions {
  /** Columns available. Anything non-positive, or absent, means "no terminal to draw into". */
  width?: number | undefined;
  /** Whether ANSI colour may be emitted at all. */
  color?: boolean | undefined;
}

/** Two columns, the same indent the round summary and the confirmation draw their banners at. */
const CLOSING_INDENT = '  ';

const ANSI = {
  figure: '\u001B[1;32m',
  mark: '\u001B[1;36m',
  dim: '\u001B[2m',
  reset: '\u001B[0m',
} as const;

/**
 * Colour is a hint and never the carrier. Every line below says what it says with words and
 * glyph shapes; `paint` only ever adds emphasis on top, and adds nothing at all when stdout is
 * redirected — a log file full of escape sequences is a worse artefact than a plain one.
 */
function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/** The terminal's width, or `undefined` when there is no terminal to measure. */
function closingWidth(width: number | undefined): number | undefined {
  const columns = width ?? process.stdout.columns;
  if (typeof columns !== 'number' || !Number.isFinite(columns) || columns <= 0) return undefined;
  return Math.floor(columns);
}

/**
 * The last thing the tool says, or nothing at all.
 *
 * The full per-target report used to be printed here, after the interface had already been
 * torn off the screen — which meant the moment the user most wanted to read carefully was the
 * moment the tool switched to a wall of plain text below a shell prompt. That report now
 * renders *inside* the interface, one round at a time, where it can be read next to the list
 * it describes and where the user can act on it. What is left for stdout is the thing a
 * terminal is genuinely good at: something short and durable that survives scrollback.
 *
 * # The figure is the point
 *
 * This is the only part of the session that is still on the screen after the interface is gone,
 * and the one number in it that a person actually wants is how much they got back. So it is
 * drawn in the same block face the round summary and the confirmation use — `bigBytes`, one
 * font for all three, because a tool that renders `47.2M` in three different shapes on three
 * consecutive screens reads as three programs.
 *
 * The digits are then repeated as ordinary text on the caption line. That is not redundancy: a
 * block glyph cannot be grepped out of scrollback, copied into a commit message, or read by
 * anything that is not a pair of eyes, and the caption is what makes the number survive all
 * three.
 *
 * # What it degrades to, and when
 *
 * A single plain line — the one this function used to return, unchanged — whenever the tall
 * form cannot be drawn honestly:
 *
 * - **stdout is redirected.** No columns, no colour, no block face. `dev-cleaner … | tee log`
 *   should put one greppable sentence in the log, not nine lines and an escape sequence.
 * - **the terminal is too narrow** for the banner, or for either of the two sentences under it.
 *   A banner that wraps is not a bigger number, it is a broken one, and the same goes for a
 *   caption that folds onto a second line beneath it.
 * - **nothing actually reached the Trash** — a round in which every target was refused still
 *   counts as a round, and a five-row `0B` celebrating it would be grotesque.
 *
 * # What it may never say
 *
 * The headline is `trashedBytes`: what `applyRound` counted as *trashed*, never what was
 * refused or failed. And it carries invariant 8's disclosure, because the disclosure is the
 * point — the bytes are in the Trash, not back on the disk, until the Trash is emptied. When
 * the user emptied it from inside the interface that sentence would be false, so it is replaced
 * rather than softened.
 *
 * A session that cleaned nothing prints nothing. `dev-cleaner` used as a viewer must be as
 * quiet as `ls`.
 */
export function renderClosingLine(
  summary: ExitSummary,
  options: ClosingLineOptions = {},
): string {
  if (!summary.cleaned) return '';

  const figure = formatBytes(summary.trashedBytes);
  const rounds = summary.rounds === 1 ? '1 round' : `${summary.rounds} rounds`;
  const tail = summary.trashEmptied
    ? 'The Trash was emptied, so that space is back.'
    : 'Trashed files still occupy the disk until you empty the Trash.';
  const plain = `dev-cleaner: ${figure} moved to the Trash in ${rounds}. ${tail}\n`;

  const width = closingWidth(options.width);
  if (width === undefined || summary.trashedBytes <= 0) return plain;

  const banner = bigBytes(summary.trashedBytes, width);
  if (banner === undefined) return plain;

  // The wordmark stands in for the `dev-cleaner:` prefix the plain line uses: after a
  // full-screen interface has vanished, the scrollback still has to say which command left this
  // behind.
  const caption = `${WORDMARK} · ${figure} moved to the Trash in ${rounds}`;
  const fits = (line: string): boolean => CLOSING_INDENT.length + line.length <= width;
  if (!fits(caption) || !fits(tail)) return plain;

  const color = options.color ?? process.stdout.isTTY === true;
  return [
    '',
    ...banner.map((row) => paint(`${CLOSING_INDENT}${row}`, ANSI.figure, color)),
    '',
    `${paint(`${CLOSING_INDENT}${WORDMARK}`, ANSI.mark, color)}${caption.slice(WORDMARK.length)}`,
    paint(`${CLOSING_INDENT}${tail}`, ANSI.dim, color),
    '',
  ].join('\n');
}

async function runInteractive(options: CliOptions, deps: MainDeps, io: CliIO): Promise<number> {
  const scanStream = deps.scanStream ?? (await import('./scan.js')).scanStream;
  const categoriesFor = await loadCategoriesFor(deps);
  const runApp = deps.runApp ?? (await import('./ui/App.js')).runApp;
  const cleanTargets = deps.clean ?? (await import('./clean.js')).clean;
  const trash = deps.trash ?? (await import('./clean.js')).systemTrash;
  const hasIncomingHardlinks = deps.storeHasIncomingHardlinks ?? storeHasIncomingHardlinks;

  const allowedCachePaths: string[] = [];
  // Every `node_modules` the scan sees, selected or not. Invariant 5 needs the ones that
  // will still be on disk afterwards, and under the default `recommended` preset that is
  // *all* of them — `deps` is not in the preset, so none is ever a target.
  const nodeModulesSeen: string[] = [];
  const stream = recordCaches(
    recordNodeModules(
      scanStream(scanOptionsFor(options, deps, categoriesFor(options.preset))),
      nodeModulesSeen,
    ),
    allowedCachePaths,
  );

  /**
   * Invariant 5's input is a property of the whole run, not of one target, so it must be
   * recomputed for whichever selection is being asked about — screening a hypothetical set
   * and cleaning a real one are the same question at different times.
   */
  const unselectedFor = (targets: readonly CleanTarget[]): string[] => {
    const selected = new Set(
      targets.flatMap((t) => (t.kind === 'project' ? [t.artifact.path] : [])),
    );
    return nodeModulesSeen.filter((p) => !selected.has(p));
  };

  /**
   * The gauge, the Trash disclosure and the empty itself, each reached lazily.
   *
   * Bound as closures that `import()` on first call rather than at the top of this function,
   * so a run that never draws a bar never loads `node:fs/promises`'s `statfs` path and — much
   * more importantly — a run that never asks to empty the Trash never loads the module that
   * can. `trash.ts` has no side effects at import, but "the destructive module is only loaded
   * when the destructive path is taken" is a property worth keeping true by construction.
   *
   * The volume measured is the first scan root: it is where the artifacts are, so it is the
   * volume whose free space the user is here about. Roots are already realpath'd by `main`.
   */
  const volume = options.roots[0] ?? process.cwd();
  const readDisk = async (): Promise<DiskUsage | undefined> => {
    const read = deps.readDiskUsage ?? (await import('./ui/diskbar.js')).readDiskUsage;
    return read(volume);
  };
  const readTrash = async (): Promise<TrashSummary> => {
    const read = deps.readTrashSummary ?? (await import('./trash.js')).readTrashSummary;
    return read();
  };
  const emptyTheTrash = async (): Promise<EmptyTrashResult> => {
    const empty = deps.emptyTrash ?? (await import('./trash.js')).emptyTrash;
    return empty();
  };

  const summary = await runApp({
    stream,
    categoriesFor,
    preset: options.preset,
    nowMs: deps.nowMs ?? Date.now(),
    readDisk,
    readTrash,
    onEmptyTrash: emptyTheTrash,
    /**
     * Without this binding the whole pre-consent screening layer is dead code: `onScreen` is
     * optional, so omitting it compiles, every unit test passes, and the confirmation screen
     * silently shows an unscreened list. The interactive path is the only one that deletes,
     * which makes this the one binding that must not be forgotten — hence the test that
     * asserts `runApp` receives it.
     */
    onScreen: async (targets: readonly CleanTarget[], tier: ScreeningTier) =>
      screenTargets(
        targets,
        {
          trash,
          roots: options.roots,
          allowedCachePaths,
          unselectedNodeModules: unselectedFor(targets),
        },
        tier,
      ),
    onClean: async (targets: readonly CleanTarget[]) => {
      // Invariant 5, machine-wide. `unselectedNodeModules` below is scoped to the scan, so
      // it goes empty the moment the one scanned project is cleaned successfully — while
      // every unscanned project on the disk still hardlinks into the store. The store is
      // therefore cleared by the filesystem, not by the scan, before `clean` sees it.
      const { safe, refused } = await screenStorePrunes(targets, hasIncomingHardlinks);
      const outcomes = await cleanTargets(safe, {
        trash,
        roots: options.roots,
        allowedCachePaths,
        unselectedNodeModules: unselectedFor(targets),
      });
      // Appended, not interleaved: a store prune is the last thing `clean` would have done
      // (`orderTargets` rank 2), so the summary still reads in execution order.
      return [...outcomes, ...refused];
    },
  });

  io.write(renderClosingLine(summary));
  return EXIT_OK;
}

/**
 * Exit codes: 0 success, 1 unexpected failure, 2 usage error, 3 a refused scan root.
 * 3 is distinct because it is not a failure — it is the safety layer working.
 */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const io = deps.io ?? processIO();

  let options: CliOptions;
  try {
    options = parseArgs(argv, deps.cwd);
  } catch (error) {
    io.writeError(`${messageOf(error)}\nRun \`dev-cleaner --help\` for usage.\n`);
    return EXIT_USAGE;
  }

  if (options.help) {
    io.write(`${HELP_TEXT}\n`);
    return EXIT_OK;
  }
  if (options.version) {
    io.write(`${version()}\n`);
    return EXIT_OK;
  }

  try {
    const resolved: CliOptions = { ...options, roots: await resolveRoots(options.roots, deps) };
    return io.isTTY
      ? await runInteractive(resolved, deps, io)
      : await runStaticReport(resolved, deps, io);
  } catch (error) {
    if (error instanceof SafetyError) {
      io.writeError(`dev-cleaner refused to scan: ${messageOf(error)}\n`);
      return EXIT_SAFETY;
    }
    io.writeError(`dev-cleaner failed: ${messageOf(error)}\n`);
    return EXIT_FAILURE;
  }
}

/**
 * True only when this file is the program Node was asked to run. `realpathSync` is what
 * makes it survive installation: npm links the binary into `node_modules/.bin`, so
 * `process.argv[1]` is a symlink while `import.meta.url` is already resolved, and a naive
 * comparison leaves the installed CLI doing nothing at all.
 */
function isDirectEntry(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  // `process.exitCode`, never `process.exit`: exiting outright can truncate a report that
  // is still being flushed into a pipe.
  process.exitCode = await main(process.argv.slice(2));
}
