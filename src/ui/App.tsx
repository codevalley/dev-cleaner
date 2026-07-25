/**
 * The two-pane interface.
 *
 * Four properties are worth stating, because each one is a decision rather than a detail.
 *
 * **Progressive rendering.** The app consumes a `ScanEvent` stream and re-renders on every
 * event. It never awaits `done` before painting: on a 133 GB tree the first project is
 * known seconds before the last, and a UI that waits looks broken for the whole scan. The
 * scan indicator in the footer is what keeps a half-filled list honest.
 *
 * **Everything the app knows how to decide lives in `model.ts`.** This component owns
 * state and keys; row order, defaults, totals and target construction are pure functions
 * tested without a terminal.
 *
 * **Nothing is imported from `artifacts.ts` or `clean.ts`.** The preset→category policy
 * and the deletion itself arrive as props (`categoriesFor`, `onClean`), wired by `cli.ts`
 * to `categoriesForPreset` and `clean`. The UI is therefore renderable — and testable —
 * without touching a filesystem, and the module that can delete is reached through exactly
 * one, explicit seam.
 *
 * **Consent is a snapshot, and it is the collision between the two properties above.**
 * Progressive rendering means the scan is still delivering projects while the confirmation
 * is on screen, and the default selection preselects each one as it lands. Read live, the
 * confirmation screen would grow a work list behind a question the user has already been
 * asked. `ConfirmSnapshot` freezes what was shown; arrivals are counted and disclosed, and
 * wait for the next pass.
 */

import { Box, Text, render, useApp, useInput, useStdin, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Confirm } from './Confirm.js';
import { Detail } from './Detail.js';
import { Footer } from './Footer.js';
import { List } from './List.js';
import { formatBytes } from './format.js';
import {
  EMPTY_SELECTION,
  buildRows,
  cyclePreset,
  defaultSelection,
  firstSelectableId,
  isSelectable,
  moveCursor,
  selectedBytes,
  selectedCount,
  selectedRows,
  toTargets,
  toggleRow,
  toggleSection,
  upsertCache,
  upsertProject,
  type Row,
  type Selection,
} from './model.js';
import type { ScanEvent } from '../scan.js';
import type { CacheEntry, Category, CleanOutcome, CleanTarget, Preset, Project } from '../types.js';

export interface ExitSummary {
  cleaned: boolean;
  outcomes: CleanOutcome[];
  /** Bytes now sitting in the Trash — the number invariant 8 requires be disclosed. */
  trashedBytes: number;
}

export interface AppProps {
  /** Live scan events. Rendered as they arrive; `done` only stops the indicator. */
  stream: AsyncIterable<ScanEvent>;
  /** `categoriesForPreset` from src/artifacts.ts, injected by the CLI. */
  categoriesFor: (preset: Preset) => Set<Category>;
  /** `clean` from src/clean.ts, bound to its options by the CLI. */
  onClean: (targets: readonly CleanTarget[]) => Promise<CleanOutcome[]>;
  onExit?: ((summary: ExitSummary) => void) | undefined;
  preset?: Preset | undefined;
  nowMs?: number | undefined;
  /** Terminal geometry. Defaults to stdout's, overridable for tests. */
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * What the user was actually shown when they asked to confirm.
 *
 * The scan keeps running while the confirmation is up, and every project it finds is fed
 * through the same default that preselects dormant work. Read live, the confirmation would
 * therefore describe one set of directories and `clean` would receive a longer one: the
 * user consents to a screen, and the work list grows behind it. Freezing rows, targets and
 * the total at the moment the question is asked makes the answer apply to the question.
 */
interface ConfirmSnapshot {
  rows: readonly Row[];
  targets: readonly CleanTarget[];
  bytes: number;
}

/**
 * Modelled as a union rather than a string plus a nullable snapshot: `confirm` and
 * `cleaning` cannot exist without the frozen list, and the type is what says so.
 */
type Phase =
  | { kind: 'list' }
  | { kind: 'confirm'; snapshot: ConfirmSnapshot }
  | { kind: 'cleaning'; snapshot: ConfirmSnapshot };

const MIN_LIST_WIDTH = 28;
const MAX_LIST_WIDTH = 52;
/** Border, padding, title and footer, subtracted from the terminal's rows. */
const CHROME_HEIGHT = 7;

export function App({
  stream,
  categoriesFor,
  onClean,
  onExit,
  preset: initialPreset,
  width,
  height,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Ink throws from `setRawMode` on a stdin that cannot support it. The CLI already
  // degrades to the static report when stdout is not a TTY (spec: "Degradation"); this
  // keeps a stranger pairing — piped stdin, TTY stdout — from crashing on the first frame.
  const { isRawModeSupported } = useStdin();

  const [projects, setProjects] = useState<Project[]>([]);
  const [caches, setCaches] = useState<CacheEntry[]>([]);
  const [scanning, setScanning] = useState(true);
  const [preset, setPreset] = useState<Preset>(initialPreset ?? 'recommended');
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [cursorId, setCursorId] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: 'list' });
  const [message, setMessage] = useState<string | undefined>(undefined);

  /** Rows whose default selection has already been applied, so a user's `space` sticks. */
  const seen = useRef<Set<string>>(new Set());

  /**
   * Consent is spent, not just given.
   *
   * Ink re-subscribes `useInput` in a passive effect, so two keystrokes delivered in one
   * tick — a double-tap, or the key repeat of a held ENTER, which on a confirmation dialog
   * is entirely ordinary — both reach the *previous* render's handler while `phase` still
   * reads `confirm`. A `setPhase` cannot stop the second one: state updates are asynchronous,
   * and that asynchrony is the race. Only a ref latched synchronously, before the first
   * `await`, makes the transition single-use. Trashing the same path twice is mostly
   * idempotent, but the reported summary would describe the second run, and a trash backend
   * that is not idempotent would delete twice.
   */
  const cleanStarted = useRef(false);

  const columns = width ?? stdout?.columns ?? 80;
  const listWidth = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.floor(columns * 0.55)));
  const detailWidth = Math.max(MIN_LIST_WIDTH, columns - listWidth);
  const listHeight = Math.max(5, (height ?? stdout?.rows ?? 24) - CHROME_HEIGHT);

  const categories = useMemo(() => categoriesFor(preset), [categoriesFor, preset]);
  const rows = useMemo(
    () => buildRows({ projects, caches, categories }),
    [projects, caches, categories],
  );

  // Progressive rendering: one setState per event, no buffering, no wait for `done`.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        for await (const event of stream) {
          if (cancelled) return;
          if (event.kind === 'project') {
            setProjects((current) => upsertProject(current, event.project));
          } else if (event.kind === 'cache') {
            setCaches((current) => upsertCache(current, event.cache));
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stream]);

  // Apply the default only to rows never seen before, so arrivals do not undo a choice.
  useEffect(() => {
    const fresh = rows.filter((row) => isSelectable(row) && !seen.current.has(row.id));
    if (fresh.length === 0) return;

    for (const row of fresh) seen.current.add(row.id);
    const defaults = defaultSelection(fresh);
    setSelection((current) => ({
      projects: new Set([...current.projects, ...defaults.projects]),
      caches: new Set([...current.caches, ...defaults.caches]),
    }));
  }, [rows]);

  // Keep the cursor on a row that exists — a preset change can remove the one it was on.
  useEffect(() => {
    setCursorId((current) =>
      current !== undefined && rows.some((row) => row.id === current)
        ? current
        : firstSelectableId(rows),
    );
  }, [rows]);

  const currentRow: Row | undefined = rows.find((row) => row.id === cursorId);
  const chosen = selectedRows(rows, selection);
  const totalBytes = selectedBytes(rows, selection);
  const count = selectedCount(rows, selection);
  const targets = useMemo(
    () => toTargets({ rows, selection, categories }),
    [rows, selection, categories],
  );

  const quit = useCallback(() => {
    onExit?.({ cleaned: false, outcomes: [], trashedBytes: 0 });
    exit();
  }, [exit, onExit]);

  // Takes the snapshot as an argument rather than reading state: the work list handed to
  // `clean` is the one the user saw, not whatever the stream has made of it since.
  const runClean = useCallback(
    async (snapshot: ConfirmSnapshot) => {
      // Latched here, synchronously: everything above the first `await` runs before the
      // caller returns, so the second keystroke of the same tick finds the latch already set.
      if (cleanStarted.current) return;
      cleanStarted.current = true;

      setPhase({ kind: 'cleaning', snapshot });
      try {
        const result = await onClean(snapshot.targets);
        const trashedBytes = result
          .filter((outcome) => outcome.outcome === 'trashed')
          .reduce((sum, outcome) => sum + outcome.bytes, 0);
        onExit?.({ cleaned: true, outcomes: result, trashedBytes });
        exit();
      } catch (error) {
        // The run is over and nothing was reported, so the next one is a new decision:
        // release the latch or a failed clean would leave the app unable to retry.
        cleanStarted.current = false;
        setPhase({ kind: 'list' });
        setMessage(`clean failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [exit, onClean, onExit],
  );

  useInput(
    (input, key) => {
      if (phase.kind === 'cleaning') return;

      if (input === 'q' || (key.ctrl && input === 'c')) {
        quit();
        return;
      }

      if (phase.kind === 'confirm') {
        if (key.escape) setPhase({ kind: 'list' });
        else if (key.return) void runClean(phase.snapshot);
        return;
      }

      setMessage(undefined);

      if (key.upArrow || input === 'k') {
        setCursorId((current) => moveCursor(rows, current, -1));
      } else if (key.downArrow || input === 'j') {
        setCursorId((current) => moveCursor(rows, current, 1));
      } else if (input === ' ') {
        if (currentRow !== undefined) {
          setSelection((current) => toggleRow(current, currentRow));
        }
      } else if (input === 'a') {
        if (currentRow !== undefined) {
          setSelection((current) => toggleSection(current, rows, currentRow.section));
        }
      } else if (input === 'p') {
        setPreset(cyclePreset);
      } else if (key.return) {
        if (targets.length === 0) setMessage('Nothing selected');
        else setPhase({ kind: 'confirm', snapshot: { rows: chosen, targets, bytes: totalBytes } });
      }
    },
    { isActive: isRawModeSupported },
  );

  if (phase.kind === 'confirm') {
    const { snapshot } = phase;
    // Rows the scan turned up after the question was asked. They stay in the background
    // list and are offered on the next pass; what they must not do is join this run
    // unannounced. Counting them is the difference between "not included" and "hidden".
    const frozen = new Set(snapshot.rows.map((row) => row.id));
    const arrivals = chosen.filter((row) => !frozen.has(row.id)).length;

    return (
      <Box flexDirection="column">
        <Confirm
          rows={snapshot.rows}
          targetCount={snapshot.targets.length}
          bytes={snapshot.bytes}
          width={Math.min(columns - 4, 56)}
        />
        {arrivals > 0 ? (
          <Box paddingX={1}>
            <Text dimColor>
              {`${arrivals} more found while confirming · not in this run, esc to review`}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (phase.kind === 'cleaning') {
    const { snapshot } = phase;
    const cleaningCount = snapshot.targets.length;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="yellow">
          {`Moving ${formatBytes(snapshot.bytes)} to the Trash…`}
        </Text>
        <Text dimColor>{`${cleaningCount} ${cleaningCount === 1 ? 'directory' : 'directories'}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Box borderStyle="round" flexDirection="column" paddingX={1} width={listWidth}>
          <Text bold>dev-cleaner</Text>
          <List
            rows={rows}
            cursorId={cursorId}
            selection={selection}
            width={listWidth - 4}
            height={listHeight}
          />
        </Box>
        <Box borderStyle="round" flexDirection="column" paddingX={1} width={detailWidth}>
          <Detail row={currentRow} categories={categories} width={detailWidth - 4} />
        </Box>
      </Box>
      <Footer
        preset={preset}
        selectedCount={count}
        selectedBytes={totalBytes}
        scanning={scanning}
        message={message}
      />
    </Box>
  );
}

export interface RunOptions extends AppProps {
  stdout?: NodeJS.WriteStream | undefined;
  stdin?: NodeJS.ReadStream | undefined;
}

/**
 * Mount the app and resolve once it exits, with what happened.
 *
 * `cli.ts` is a `.ts` file and cannot write JSX, so the mounting lives here rather than
 * there — and with it the knowledge that the summary must be captured from `onExit`
 * before `waitUntilExit` resolves. `exitOnCtrlC` is off because Ctrl-C is handled in the
 * input handler, which routes it through the same `onExit` as `q`; left on, Ink would tear
 * the app down without ever reporting.
 */
export async function runApp(options: RunOptions): Promise<ExitSummary> {
  const { stdout, stdin, ...props } = options;
  let summary: ExitSummary = { cleaned: false, outcomes: [], trashedBytes: 0 };

  const instance = render(
    React.createElement(App, {
      ...props,
      onExit: (result: ExitSummary) => {
        summary = result;
        props.onExit?.(result);
      },
    }),
    {
      ...(stdout === undefined ? {} : { stdout }),
      ...(stdin === undefined ? {} : { stdin }),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await instance.waitUntilExit();
  return summary;
}
