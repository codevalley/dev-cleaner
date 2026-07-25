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
import { pathToFileURL } from 'node:url';

import { renderCleanSummary, renderReport } from './report.js';
import { SafetyError } from './types.js';
import type { Category, CleanOutcome, CleanTarget, Preset, TrashFn } from './types.js';
import type { CleanOptions } from './clean.js';
import type { ScanEvent, ScanOptions, ScanResult } from './scan.js';
import type { ExitSummary, RunOptions } from './ui/App.js';

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
  Deletions go to the system Trash, which still occupies the disk until it is emptied.`;

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

function scanOptionsFor(options: CliOptions, deps: MainDeps): ScanOptions {
  const scan: ScanOptions = {
    roots: options.roots,
    categories: new Set(SCAN_CATEGORIES),
    includeCaches: options.includeCaches,
    nowMs: deps.nowMs ?? Date.now(),
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

async function runStaticReport(
  options: CliOptions,
  deps: MainDeps,
  io: CliIO,
): Promise<number> {
  const scanAll = deps.scanAll ?? (await import('./scan.js')).scanAll;
  const categoriesFor = await loadCategoriesFor(deps);

  const result = await scanAll(scanOptionsFor(options, deps));

  io.write(
    renderReport({
      projects: result.projects,
      caches: result.caches,
      categories: categoriesFor(options.preset),
      preset: options.preset,
      roots: options.roots,
    }),
  );
  return EXIT_OK;
}

async function runInteractive(options: CliOptions, deps: MainDeps, io: CliIO): Promise<number> {
  const scanStream = deps.scanStream ?? (await import('./scan.js')).scanStream;
  const categoriesFor = await loadCategoriesFor(deps);
  const runApp = deps.runApp ?? (await import('./ui/App.js')).runApp;
  const cleanTargets = deps.clean ?? (await import('./clean.js')).clean;
  const trash = deps.trash ?? (await import('./clean.js')).systemTrash;

  const allowedCachePaths: string[] = [];
  const stream = recordCaches(scanStream(scanOptionsFor(options, deps)), allowedCachePaths);

  const summary = await runApp({
    stream,
    categoriesFor,
    preset: options.preset,
    nowMs: deps.nowMs ?? Date.now(),
    onClean: (targets: readonly CleanTarget[]) =>
      cleanTargets(targets, { trash, roots: options.roots, allowedCachePaths }),
  });

  // Invariant 8: the disclosure only makes sense when something was actually trashed, and
  // `renderCleanSummary` is the one place it is worded.
  if (summary.cleaned) io.write(renderCleanSummary(summary.outcomes));
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
