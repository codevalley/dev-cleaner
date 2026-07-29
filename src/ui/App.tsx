/**
 * The Ink shell: a workspace the user returns to, not a wizard they fall out of.
 *
 * # What changed, and why it was the biggest change
 *
 * The original flow was one-shot — scan, select, confirm, clean, unmount, print, exit. Every
 * part of that is defensible in isolation and the whole is not: the interface vanishes at the
 * exact moment the user most wants it, and what replaces it is a block of plain text below a
 * shell prompt. There is no way back to the list, so a second round means re-running the
 * program and re-scanning a tree that takes minutes. The user's own words: "no way for me to
 * go back and forth, not like a UI with a home where I can do multiple select and purge."
 *
 * So a clean now *returns to the list*. `applyRound` (in `model.ts`) takes the session and the
 * outcomes and hands back the next session: cleaned rows gone, projects that lost only some
 * artifacts still there at their remaining size, everything the round touched unchecked, and a
 * running trashed-bytes total. The round reports itself in a pane inside the frame, and `q` —
 * only `q` — leaves.
 *
 * # The properties that did not change, and must not
 *
 * **Progressive rendering.** The app consumes a `ScanEvent` stream and re-renders on every
 * event; it never awaits `done` before painting. On a 133 GB tree the first project is known
 * seconds before the last. `ScanStatus` is what keeps a half-filled list honest — an animated
 * indicator with a running count, and an *unambiguous settled state*, because the absence of
 * the word "scanning" is not something an eye can read as "finished".
 *
 * **Everything the app knows how to decide lives in a pure module.** Row order, defaults,
 * totals, target construction and the round transition are `model.ts`; the scroll window is
 * `viewport.ts`; the gauge arithmetic is `diskbar.ts`. This component owns state, keys and
 * layout. None of the maths is repeated here.
 *
 * **Nothing that can delete or empty is imported.** `clean.ts` and `trash.ts` are reached
 * through props (`onClean`, `onScreen`, `onEmptyTrash`) and referenced only as `import type`,
 * which is erased at compile time. The UI is renderable and testable without a filesystem, and
 * the modules that destroy things are reached through explicit seams the CLI wires up.
 *
 * **Consent is a snapshot, frozen and single-use, and it is screened before it is shown.** The
 * scan is still delivering projects while the confirmation is on screen, and the default
 * preselects each one as it lands; read live, the confirmation would grow a work list behind a
 * question already asked. `ConfirmSnapshot` freezes rows, targets and the total; arrivals are
 * counted and disclosed and wait for the next pass. And because the list describes what is
 * *selected* while `clean.ts` decides what is *deletable*, the frozen set is put through
 * `onScreen` — the boundary's own guards — before the question is rendered, so the headline
 * and the work list are the same fact.
 *
 * **A new round takes a new snapshot.** `runClean` is handed the snapshot it is to act on;
 * nothing is reused between rounds, and the second round is screened as freshly as the first.
 * A retained snapshot would be consent given to a list that no longer exists.
 *
 * # The layout is a fixed budget, and it is one line shorter than the terminal
 *
 * The frame is sized to the terminal and the list is the only part that gives: the chrome is
 * subtracted from the rows available and whatever is left is the window `viewport.ts` is asked
 * for. That is what makes the footer *pinned* — not a flex property, but the fact that nothing
 * above it is ever allowed to be taller than the space it was given.
 *
 * The subtlety, and the bug it hid for a whole release: **the budget is `rows - 1`, not
 * `rows`.** Ink redraws by writing the frame followed by a newline and erasing that many lines
 * next time, so a frame of exactly `rows` lines occupies `rows + 1` terminal lines, the
 * emulator scrolls by one, and the erase can no longer reach what has left the screen. Ink
 * knows this and switches to a whole-screen clear at `outputHeight >= rows` — but that path
 * never updates the incremental renderer's line count, so the *next* frame that is shorter (a
 * confirmation, a round summary, the first frames of a scan) erases the wrong number of lines
 * and leaves the previous frame's header sitting above the new one. That is the duplicated
 * header the user reported, and it is why `RESERVED_ROW` exists.
 *
 * The old constants added up to exactly `rows`, so *every* list frame took the whole-screen
 * path and every transition out of the list could duplicate. The test that was supposed to
 * catch it asserted `lines().length <= rows`, which is true of the broken layout.
 */

import { Box, Text, render, useApp, useInput, useStdin, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Headline, Logo, WORDMARK } from './Banner.js';
import { Confirm, type BlockedEntry, type ConfirmEntry } from './Confirm.js';
import { Detail } from './Detail.js';
import { BAR_LEGEND, Gauge } from './Gauge.js';
import { Footer, hintsFor } from './Footer.js';
import { Home } from './Home.js';
import { List, statusLine } from './List.js';
import { RoundSummary, type ProblemEntry, type RoundReport } from './Round.js';
import { ScanStatus } from './ScanStatus.js';
import { Splash, splashReady } from './Splash.js';
import { EMPTY_TRASH_WORD, TrashConfirm, TrashResult, trashConfirmArmed } from './Trash.js';
import { formatBytes } from './format.js';
import {
  EMPTY_SELECTION,
  EMPTY_SESSION,
  applyRound,
  buildRows,
  cursorIndex,
  cyclePreset,
  defaultSelection,
  firstReclaimableId,
  firstSelectableId,
  isSelectable,
  moveCursor,
  selectedBytes,
  selectedCount,
  selectedRows,
  sessionSummary,
  toTargets,
  toggleRow,
  toggleSection,
  upsertCache,
  upsertProject,
  type Row,
  type Selection,
  type SessionState,
} from './model.js';
import { windowFor, type Viewport } from './viewport.js';
import { TRASH_CAVEAT, diskLabels, type DiskUsage } from './diskbar.js';
import type { ScanEvent } from '../scan.js';
// Type-only, and deliberately so: `import type` is erased at compile time, so the UI still
// never *loads* the modules that can delete or empty. The seams through which they are
// actually reached are the `onScreen`, `onClean` and `onEmptyTrash` props.
import type { Screening, ScreeningTier } from '../clean.js';
import type { EmptyTrashResult, TrashSummary } from '../trash.js';
import type { CacheEntry, Category, CleanOutcome, CleanTarget, Preset, Project } from '../types.js';

/**
 * What the whole session did, reported once, on the way out.
 *
 * `trashedBytes` is the session's accumulated **trashed** total and nothing else — invariant
 * 8's number. It comes from `applyRound`, which counts an outcome only when it is `trashed`,
 * because `refused` and `failed` mean the directory is still exactly where it was. A user told
 * that 10 G is waiting in the Trash when 2 G is will empty it, expect 10 G back, and get 2 G.
 */
export interface ExitSummary {
  cleaned: boolean;
  /** Every outcome from every round, in the order they happened. */
  outcomes: CleanOutcome[];
  /** Bytes now sitting in the Trash because of this session. Trashed only; never refused. */
  trashedBytes: number;
  /** Completed rounds. `0` when the user only looked. */
  rounds: number;
  /** Whether the user emptied the Trash from inside the interface. */
  trashEmptied: boolean;
}

const NOTHING_HAPPENED: ExitSummary = {
  cleaned: false,
  outcomes: [],
  trashedBytes: 0,
  rounds: 0,
  trashEmptied: false,
};

/** Surfaces that can open Confirm / Trash and expect esc to return. */
type WorkspaceKind = 'home' | 'triage';

export interface AppProps {
  /** Live scan events. Rendered as they arrive; `done` only settles the indicator. */
  stream: AsyncIterable<ScanEvent>;
  /** `categoriesForPreset` from src/artifacts.ts, injected by the CLI. */
  categoriesFor: (preset: Preset) => Set<Category>;
  /** `clean` from src/clean.ts, bound to its options by the CLI. */
  onClean: (targets: readonly CleanTarget[]) => Promise<CleanOutcome[]>;
  /**
   * `screenTargets` from src/clean.ts, bound to its options by the CLI — the same guards
   * `onClean` will apply, asked before the user is asked.
   *
   * The tier is passed through so this component decides what it pays for: `'cheap'` for an
   * immediate partial answer, `'full'` (cheap plus the nested-repository scan) for the
   * verdict the question is rendered from. The binding must recompute
   * `unselectedNodeModules` from the targets it is handed — invariant 5 is a property of the
   * whole run, so a screen of a hypothetical selection has to be told what that selection is.
   *
   * Optional only so that a caller which cannot vet — a test, a harness — still renders. An
   * app without it confirms exactly what it lists, which is the dishonest total this prop
   * exists to remove; `cli.ts` is expected to supply it.
   */
  onScreen?:
    | ((targets: readonly CleanTarget[], tier: ScreeningTier) => Promise<readonly Screening[]>)
    | undefined;
  /**
   * The volume's usage, re-read after every round and after an empty. Optional: a gauge is a
   * decoration and a tool that refused to start because it could not draw one would be absurd.
   */
  readDisk?: (() => Promise<DiskUsage | undefined>) | undefined;
  /**
   * `readTrashSummary` from src/trash.ts. Its figures — the **whole** Trash, never this run's
   * — are what the empty prompt is required to display. Absent means the offer is not made.
   */
  readTrash?: (() => Promise<TrashSummary>) | undefined;
  /** `emptyTrash` from src/trash.ts. Irreversible; reached only through the typed word. */
  onEmptyTrash?: (() => Promise<EmptyTrashResult>) | undefined;
  onExit?: ((summary: ExitSummary) => void) | undefined;
  preset?: Preset | undefined;
  nowMs?: number | undefined;
  /** Shown on Splash / Home chrome. Defaults to `.` when the CLI has not wired roots. */
  rootsLabel?: string | undefined;
  /** Terminal geometry. Defaults to stdout's, overridable for tests. */
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * What the user asked about: the selection, frozen, before the guards have had their say.
 *
 * The scan keeps running while the confirmation is up, and every project it finds is fed
 * through the same default that preselects dormant work. Read live, the confirmation would
 * therefore describe one set of directories and `clean` would receive a longer one: the
 * user consents to a screen, and the work list grows behind it. Freezing rows, targets and
 * the total at the moment the question is asked makes the answer apply to the question.
 */
interface Candidate {
  rows: readonly Row[];
  targets: readonly CleanTarget[];
  bytes: number;
}

/**
 * The candidate after screening — what the user is actually shown and consents to.
 *
 * `targets` and `bytes` are **narrowed to the deletable set**: they are what `clean` will be
 * handed and what it will trash, so the number on screen and the work list are the same
 * fact, derived from one another rather than computed twice.
 *
 * `rows` is not narrowed. It stays the full frozen selection because it is the identity the
 * arrivals disclosure compares against — a row that was on screen and turned out to be
 * blocked has still been seen, and counting it as an arrival would be a second lie.
 */
interface ConfirmSnapshot extends Candidate {
  /** Per-row lines for what will be trashed, each sized by its deletable targets only. */
  entries: readonly ConfirmEntry[];
  /** Per-target lines for what will not be, each carrying the boundary's refusal code. */
  blocked: readonly BlockedEntry[];
  blockedBytes: number;
}

/**
 * Named session modes with distinct layouts — Splash → Home → Triage → Confirm → Done —
 * rather than overlays on one two-pane workspace.
 *
 * Modelled as a union rather than a string plus a pile of nullable fields: `screening`,
 * `confirm` and `cleaning` cannot exist without the frozen list, `done` cannot exist without
 * a round to report, and `trash-confirm` cannot exist without the summary whose figures the
 * prompt is required to show. The type is what says so.
 */
type Mode =
  | { kind: 'splash' }
  | { kind: 'home' }
  | { kind: 'triage' }
  | { kind: 'detail' }
  | { kind: 'screening'; candidate: Candidate; provisional: readonly BlockedEntry[] }
  | { kind: 'confirm'; snapshot: ConfirmSnapshot }
  | { kind: 'cleaning'; snapshot: ConfirmSnapshot }
  | { kind: 'done'; report: RoundReport }
  | { kind: 'trash-reading' }
  | { kind: 'trash-confirm'; summary: TrashSummary; typed: string }
  | { kind: 'emptying' }
  | { kind: 'trash-result'; ok: boolean; detail: string | undefined; summary: TrashSummary | undefined };

/**
 * Identity of a target for matching a `Screening` back to the target it judged.
 *
 * By delete path rather than by object identity: `screenTargets` happens to return the very
 * objects it was given, but this crosses a prop boundary a caller may map over, and a
 * mismatch here would silently mark a blocked directory deletable. Artifact paths are
 * deduplicated by absolute path upstream and a cache is allowlisted by exact path, so the
 * key is unique in both arms.
 */
function targetKey(target: CleanTarget): string {
  return target.kind === 'project'
    ? `artifact:${target.artifact.path}`
    : `cache:${target.cache.path}`;
}

/** Which row a target belongs to. Mirrors the ids `buildRows` assigns. */
function rowKey(target: CleanTarget): string {
  return target.kind === 'project' ? `project:${target.project.root}` : `cache:${target.cache.id}`;
}

function targetBytes(target: CleanTarget): number {
  return target.kind === 'project' ? target.artifact.bytes : target.cache.bytes;
}

/**
 * What a blocked target is called on screen. Display data only — nothing here gates a
 * decision, which is why it can fall back to a path when a name is missing.
 */
function targetLabel(target: CleanTarget): string {
  if (target.kind === 'cache') {
    return target.cache.label.length > 0 ? target.cache.label : target.cache.path;
  }
  const { project, artifact } = target;
  const name = project.name.length > 0 ? project.name : project.root;
  const relative = artifact.relPath.length > 0 ? artifact.relPath : artifact.path;
  return `${name}/${relative}`;
}

function blockedEntriesOf(
  targets: readonly CleanTarget[],
  screenings: readonly Screening[],
): BlockedEntry[] {
  const verdicts = new Map(screenings.map((screening) => [targetKey(screening.target), screening]));
  // Driven by `targets`, not by `screenings`: the order is the one the user saw, and a
  // verdict about something that was never selected cannot smuggle a row onto the screen.
  return targets.flatMap((target) => {
    const verdict = verdicts.get(targetKey(target));
    return verdict === undefined
      ? []
      : [
          {
            id: targetKey(target),
            label: targetLabel(target),
            bytes: targetBytes(target),
            refusal: verdict.refusal,
          },
        ];
  });
}

/**
 * The candidate plus the verdicts, as the thing the user is shown.
 *
 * Everything the confirmation states is derived here from the *deletable* targets — the
 * per-row lines, the byte total, the count — so the headline cannot describe a set the work
 * list does not. Blocked targets leave the work list entirely rather than being passed to
 * `clean` for it to refuse a second time: consent is given to what will happen, and dropping
 * them is also the fail-closed direction for invariant 5, since a `node_modules` that will
 * not be trashed is then correctly counted as one still on disk when the run ends.
 */
function screenedSnapshot(candidate: Candidate, screenings: readonly Screening[]): ConfirmSnapshot {
  const blocked = blockedEntriesOf(candidate.targets, screenings);
  const blockedKeys = new Set(blocked.map((entry) => entry.id));
  const targets = candidate.targets.filter((target) => !blockedKeys.has(targetKey(target)));

  const bytesByRow = new Map<string, number>();
  for (const target of targets) {
    const key = rowKey(target);
    bytesByRow.set(key, (bytesByRow.get(key) ?? 0) + targetBytes(target));
  }

  const entries: ConfirmEntry[] = candidate.rows.flatMap((row) => {
    const bytes = bytesByRow.get(row.id);
    // A row every one of whose artifacts was blocked has nothing left to consent to; it
    // appears in the blocked list instead of as a 0B line inviting a pointless yes.
    return bytes === undefined ? [] : [{ id: row.id, label: row.label, bytes }];
  });

  return {
    rows: candidate.rows,
    targets,
    bytes: targets.reduce((sum, target) => sum + targetBytes(target), 0),
    entries,
    blocked,
    blockedBytes: blocked.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/** What was selected, consented to, and did not move — for the round summary. */
function problemsOf(outcomes: readonly CleanOutcome[]): ProblemEntry[] {
  return outcomes.flatMap((outcome) =>
    outcome.outcome === 'trashed'
      ? []
      : [
          {
            id: targetKey(outcome.target),
            label: outcome.label,
            bytes: outcome.bytes,
            outcome: outcome.outcome,
            detail: outcome.detail,
          },
        ],
  );
}

const MIN_SCAN_WIDTH = 18;

/**
 * The line the frame may not use.
 *
 * Ink writes `frame + "\n"`, so a frame of `rows` lines lands the cursor on line `rows + 1` and
 * the emulator scrolls; the erase that begins the next redraw then cannot reach the line that
 * has gone. Ink's own guard (`outputHeight >= rows` → clear the whole screen) avoids the
 * garbling but bypasses the incremental renderer's bookkeeping, so the next *shorter* frame
 * erases too few lines and the previous header stays on screen underneath it. Leaving one line
 * unspent keeps every frame on the incremental path, where the arithmetic is correct.
 *
 * It is one line, not a margin for taste. See the note at the top of this file.
 */
const RESERVED_ROW = 1;

/**
 * The fixed part of the triage frame, in lines. Everything here is drawn on every triage
 * frame, so the list gets the budget minus this and not one line more.
 *
 * - 2 header: the wordmark-and-scan line, and the one-line disk gauge.
 * - 2 headline: the selection total, in the block face, which is the number the user came for.
 * - 2 pane borders (top and bottom).
 * - 1 scroll hint, drawn *inside* the list pane by `List` whether or not it has anything to
 *   say — a line that came and went would change the frame height as the user scrolled.
 * - 1 status line under the list for the focused row.
 * - 1 footer: the key hints, with the session ledger or a message on the right.
 */
const HEADER_HEIGHT = 2;
const HEADLINE_HEIGHT = 2;
const PANE_BORDER_HEIGHT = 2;
const SCROLL_HINT_HEIGHT = 1;
const STATUS_LINE_HEIGHT = 1;
const FOOTER_HEIGHT = 1;
const CHROME_HEIGHT =
  HEADER_HEIGHT +
  HEADLINE_HEIGHT +
  PANE_BORDER_HEIGHT +
  SCROLL_HINT_HEIGHT +
  STATUS_LINE_HEIGHT +
  FOOTER_HEIGHT;

/**
 * The chrome a terminal too short for the full layout gets instead: the wordmark line, the
 * panes, status line and the footer, with the gauge and the headline dropped.
 *
 * Not a nicety. Without it the budget goes negative on a short terminal and the floor below
 * takes over, at which point the frame is taller than the screen again and the header
 * duplicates — the exact failure the reserved row exists to prevent, reached from the other
 * end. Which tier applies is a function of the terminal's height alone, so the number of lines
 * rendered is always the number the list was budgeted against.
 */
const COMPACT_CHROME_HEIGHT =
  1 + PANE_BORDER_HEIGHT + SCROLL_HINT_HEIGHT + STATUS_LINE_HEIGHT + FOOTER_HEIGHT;

/**
 * Shortest triage chrome: drop the status line too when even compact exceeds `rows - 1`.
 * The focused-row summary is useful, not load-bearing for the reserved-row invariant.
 */
const MINI_CHROME_HEIGHT = 1 + PANE_BORDER_HEIGHT + SCROLL_HINT_HEIGHT + FOOTER_HEIGHT;

/** Below this the pane is unusable anyway, and a negative window is not a window. */
const MIN_LIST_HEIGHT = 3;

/**
 * How the frame divides at a given terminal height: which chrome tier, and how many rows the
 * list may draw.
 *
 * Exported because it is the layout's whole contract in one place — `chrome + list` is what
 * will be rendered, and it is never more than `rows - RESERVED_ROW` for any `rows >= 7`. Below
 * that a terminal cannot hold the borders, the hint and the footer at all, and the floor of one
 * list row is the least-bad answer.
 */
export function frameBudget(rows: number): {
  chrome: number;
  listHeight: number;
  full: boolean;
  statusLine: boolean;
} {
  const budget = Math.max(0, (Number.isFinite(rows) ? Math.floor(rows) : 0) - RESERVED_ROW);
  const full = budget - CHROME_HEIGHT >= MIN_LIST_HEIGHT;
  let chrome = full ? CHROME_HEIGHT : COMPACT_CHROME_HEIGHT;
  if (budget - chrome < 1) chrome = MINI_CHROME_HEIGHT;
  const statusLine = chrome > MINI_CHROME_HEIGHT;
  return { chrome, listHeight: Math.max(1, budget - chrome), full, statusLine };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({
  stream,
  categoriesFor,
  onClean,
  onScreen,
  readDisk,
  readTrash,
  onEmptyTrash,
  onExit,
  preset: initialPreset,
  rootsLabel: rootsLabelProp,
  width,
  height,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Ink throws from `setRawMode` on a stdin that cannot support it. The CLI already
  // degrades to the static report when stdout is not a TTY (spec: "Degradation"); this
  // keeps a stranger pairing — piped stdin, TTY stdout — from crashing on the first frame.
  const { isRawModeSupported } = useStdin();

  /**
   * The session — what has been found and what has been reclaimed — with a ref beside it.
   *
   * The ref is not an optimisation. `runClean` awaits `onClean`, and during that await the
   * scan can deliver more projects; the state closed over when the key was pressed is
   * therefore stale by the time the round is applied, and applying the round to it would
   * silently drop every arrival. Writes go through `writeSession`, which updates both, so the
   * ref is always the current value and always synchronously so.
   */
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION);
  const sessionRef = useRef<SessionState>(EMPTY_SESSION);
  const writeSession = useCallback((next: (current: SessionState) => SessionState): void => {
    sessionRef.current = next(sessionRef.current);
    setSession(sessionRef.current);
  }, []);

  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const selectionRef = useRef<Selection>(EMPTY_SELECTION);
  const writeSelection = useCallback((next: (current: Selection) => Selection): void => {
    selectionRef.current = next(selectionRef.current);
    setSelection(selectionRef.current);
  }, []);

  const [scanning, setScanning] = useState(true);
  const [preset, setPreset] = useState<Preset>(initialPreset ?? 'recommended');
  const [cursorId, setCursorId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>({ kind: 'splash' });
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [disk, setDisk] = useState<DiskUsage | undefined>(undefined);
  const rootsLabel = rootsLabelProp ?? '.';

  /** Where screening / trash cancel and clean-failure return. */
  const returnToRef = useRef<WorkspaceKind>('home');

  /** Every outcome of every round, for the exit summary. A ref: only read on the way out. */
  const outcomesRef = useRef<CleanOutcome[]>([]);
  const trashEmptiedRef = useRef(false);

  /** Rows whose default selection has already been applied, so a user's `space` sticks. */
  const seen = useRef<Set<string>>(new Set());

  /**
   * Consent is spent, not just given.
   *
   * Ink re-subscribes `useInput` in a passive effect, so two keystrokes delivered in one
   * tick — a double-tap, or the key repeat of a held ENTER, which on a confirmation dialog
   * is entirely ordinary — both reach the *previous* render's handler while `mode` still
   * reads `confirm`. A `setMode` cannot stop the second one: state updates are asynchronous,
   * and that asynchrony is the race. Only a ref latched synchronously, before the first
   * `await`, makes the transition single-use. Trashing the same path twice is mostly
   * idempotent, but the reported summary would describe the second run, and a trash backend
   * that is not idempotent would delete twice.
   *
   * Released when the round finishes, because the *run* is what it spends, not the app: a
   * session has many rounds and each is a fresh decision over a fresh snapshot. The screen
   * that sits between two rounds refuses `enter` outright (see `Round.tsx`), which is what
   * keeps a held key from chaining one round into the next.
   */
  const cleanStarted = useRef(false);
  /** The same discipline for the one irreversible action. */
  const emptyStarted = useRef(false);

  /**
   * Which screening run owns the screen.
   *
   * A screen can take seconds (the nested scan is budgeted at 50,000 directories per
   * candidate) and the user can leave it — `esc` back to the workspace, `q` out of the app.
   * The `await` does not know that, so its result would arrive and open a confirmation for a
   * selection the user has since changed, or set state on a component that is gone. Every
   * departure bumps this counter; a result whose run is no longer the current one is
   * dropped. Freezing the set is worth nothing if a stale verdict can unfreeze it.
   */
  const screenRun = useRef(0);
  /** The same, for the Trash read, which walks `~/.Trash` and is just as abandonable. */
  const trashRun = useRef(0);
  const mounted = useRef(true);
  const splashStartedAt = useRef(Date.now());
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const columns = width ?? stdout?.columns ?? 80;
  const rowsAvailable = height ?? stdout?.rows ?? 24;
  const frameRows = Math.max(1, rowsAvailable - RESERVED_ROW);
  const { listHeight, full: fullChrome, statusLine: showStatusLine } = frameBudget(rowsAvailable);
  // Full-width triage: the list owns the terminal width (borders + padding subtracted later).
  const listWidth = columns;

  const categories = useMemo(() => categoriesFor(preset), [categoriesFor, preset]);
  const rows = useMemo(
    () => buildRows({ projects: session.projects, caches: session.caches, categories }),
    [session.projects, session.caches, categories],
  );

  // Progressive rendering: one setState per event, no buffering, no wait for `done`.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        for await (const event of stream) {
          if (cancelled) return;
          if (event.kind === 'project') {
            writeSession((current) => ({
              ...current,
              projects: upsertProject(current.projects, event.project),
            }));
          } else if (event.kind === 'cache') {
            writeSession((current) => ({
              ...current,
              caches: upsertCache(current.caches, event.cache),
            }));
          }
        }
      } catch (error) {
        if (!cancelled) setMessage(`scan failed: ${messageOf(error)}`);
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stream, writeSession]);

  // Apply the default only to rows never seen before, so arrivals do not undo a choice.
  useEffect(() => {
    const fresh = rows.filter((row) => isSelectable(row) && !seen.current.has(row.id));
    if (fresh.length === 0) return;

    for (const row of fresh) seen.current.add(row.id);
    const defaults = defaultSelection(fresh);
    writeSelection((current) => ({
      projects: new Set([...current.projects, ...defaults.projects]),
      caches: new Set([...current.caches, ...defaults.caches]),
    }));
  }, [rows, writeSelection]);

  // Keep the cursor on a row that exists — a preset change or a completed round removes rows.
  // Seed with the largest reclaimable selected row (lazygit-style triage entry).
  useEffect(() => {
    setCursorId((current) =>
      current !== undefined && rows.some((row) => row.id === current)
        ? current
        : (firstReclaimableId(rows, selectionRef.current) ?? firstSelectableId(rows)),
    );
  }, [rows]);

  /**
   * Recommended set for Home: defaults for the current preset, independent of Triage edits.
   * Scan arrivals update these figures as `rows` grow.
   */
  const recommended = useMemo(() => defaultSelection(rows), [rows]);
  const recommendedBytes = selectedBytes(rows, recommended);
  const recommendedCount = selectedCount(rows, recommended);
  const recommendedChosen = selectedRows(rows, recommended);
  const recommendedTargets = useMemo(
    () => toTargets({ rows, selection: recommended, categories }),
    [rows, recommended, categories],
  );

  const dormantCount = useMemo(
    () => rows.filter((row) => row.kind === 'project' && row.section === 'projects').length,
    [rows],
  );
  const activeCount = useMemo(
    () => rows.filter((row) => row.kind === 'project' && row.section === 'active').length,
    [rows],
  );
  const cacheCount = useMemo(
    () => rows.filter((row) => row.kind === 'cache').length,
    [rows],
  );
  const hasAnyRow = rows.some((row) => row.kind !== 'header');
  const foundBytes = rows.reduce((sum, row) => (row.kind === 'header' ? sum + row.bytes : sum), 0);

  // Splash → Home once the brand has been visible and the scan has something honest to say.
  useEffect(() => {
    if (mode.kind !== 'splash') return;
    const tick = (): void => {
      if (
        splashReady({
          dwellElapsedMs: Date.now() - splashStartedAt.current,
          scanning,
          recommendedBytes,
          hasAnyRow,
        })
      ) {
        setMode({ kind: 'home' });
      }
    };
    tick();
    const id = setInterval(tick, 50);
    return () => clearInterval(id);
  }, [mode.kind, scanning, recommendedBytes, hasAnyRow]);

  const currentRow: Row | undefined = rows.find((row) => row.id === cursorId);
  const chosen = selectedRows(rows, selection);
  const totalBytes = selectedBytes(rows, selection);
  const count = selectedCount(rows, selection);
  const targets = useMemo(
    () => toTargets({ rows, selection, categories }),
    [rows, selection, categories],
  );

  /**
   * The scroll window, carried across renders so it is *stable*: `windowFor` keeps the window
   * it is given unless the cursor would leave it, which is what stops every `j` from scrolling
   * the whole list around a cursor that never appears to move. A stale window cannot corrupt
   * the result — `windowFor` clamps its `start` into range — so a round that removed half the
   * rows simply pulls the window back to the end of the new list.
   */
  const viewRef = useRef<Viewport | undefined>(undefined);
  const view = windowFor(rows.length, cursorIndex(rows, cursorId), listHeight, viewRef.current);
  viewRef.current = view;

  const canEmptyTrash = readTrash !== undefined && onEmptyTrash !== undefined;

  const refreshDisk = useCallback(async (): Promise<void> => {
    if (readDisk === undefined) return;
    try {
      const usage = await readDisk();
      if (mounted.current) setDisk(usage);
    } catch {
      // A gauge that could not be read is a gauge that is not drawn. It is never worth a crash.
    }
  }, [readDisk]);

  useEffect(() => {
    void refreshDisk();
  }, [refreshDisk]);

  const quit = useCallback(() => {
    // Read from the refs: `quit` is called from an input handler that may have been created
    // several rounds ago, and the summary has to describe the session as it actually is.
    onExit?.({
      cleaned: sessionRef.current.rounds > 0,
      outcomes: [...outcomesRef.current],
      trashedBytes: sessionRef.current.reclaimedBytes,
      rounds: sessionRef.current.rounds,
      trashEmptied: trashEmptiedRef.current,
    });
    exit();
  }, [exit, onExit]);

  /**
   * Run the clean, then land on **Done**.
   *
   * Takes the snapshot as an argument rather than reading state: the work list handed to
   * `clean` is the one the user saw, not whatever the stream has made of it since.
   *
   * `applyRound` is handed `sessionRef.current` rather than the closed-over `session` for the
   * reason given where the ref is declared — the scan does not pause for the deletion, and a
   * round applied to a stale session drops every project that arrived during it.
   */
  const runClean = useCallback(
    async (snapshot: ConfirmSnapshot) => {
      // Latched here, synchronously: everything above the first `await` runs before the
      // caller returns, so the second keystroke of the same tick finds the latch already set.
      if (cleanStarted.current) return;
      cleanStarted.current = true;

      setMode({ kind: 'cleaning', snapshot });
      try {
        const outcomes = await onClean(snapshot.targets);
        if (!mounted.current) return;

        const round = applyRound({
          session: sessionRef.current,
          selection: selectionRef.current,
          outcomes,
        });
        writeSession(() => round.session);
        writeSelection(() => round.selection);
        outcomesRef.current = [...outcomesRef.current, ...outcomes];

        setMode({
          kind: 'done',
          report: {
            // From `applyRound`, which counts `trashed` and nothing else. Invariant 8.
            reclaimedBytes: round.reclaimedBytes,
            trashed: round.trashed,
            refused: round.refused,
            failed: round.failed,
            problems: problemsOf(outcomes),
            sessionBytes: round.session.reclaimedBytes,
            rounds: round.session.rounds,
          },
        });
        // The volume did not actually change — the bytes are in the Trash — but the *selection*
        // did, so the projection segment must be redrawn from a fresh reading rather than left
        // describing a set of rows that no longer exists.
        void refreshDisk();
      } catch (error) {
        setMode({ kind: returnToRef.current });
        setMessage(`clean failed: ${messageOf(error)}`);
      } finally {
        // The latch spends the *round*, not the app: the next one is a new decision over a new
        // snapshot, and a latch left set would make every later enter silently inert.
        cleanStarted.current = false;
      }
    },
    [onClean, refreshDisk, writeSelection, writeSession],
  );

  /**
   * Ask the boundary's own guards about the frozen set, then render the question from the
   * answer. Two passes, because they cost different orders of magnitude:
   *
   * - the **cheap** tier is a handful of `lstat`s per target and returns effectively at once,
   *   so its verdicts go straight onto the waiting screen — a user watching a 67 GB `target/`
   *   being scanned can already see that three other rows are blocked;
   * - the **full** tier repeats that work (microseconds) and adds the nested-repository scan,
   *   which is the only tier that can find a worktree *inside* a candidate, and is what the
   *   confirmation is finally built from.
   *
   * A screen that throws sends the user back to the workspace with the error rather than to
   * the question. Proceeding would mean rendering a total nobody checked, which is precisely
   * the defect this path exists to close; `clean` would still refuse at the boundary, but the
   * promise on screen would already have been made.
   */
  const beginScreening = useCallback(
    async (candidate: Candidate) => {
      const run = screenRun.current + 1;
      screenRun.current = run;
      const stale = (): boolean => !mounted.current || screenRun.current !== run;

      setMode({ kind: 'screening', candidate, provisional: [] });

      if (onScreen === undefined) {
        setMode({ kind: 'confirm', snapshot: screenedSnapshot(candidate, []) });
        return;
      }

      try {
        const cheap = await onScreen(candidate.targets, 'cheap');
        if (stale()) return;
        setMode({
          kind: 'screening',
          candidate,
          provisional: blockedEntriesOf(candidate.targets, cheap),
        });

        const full = await onScreen(candidate.targets, 'full');
        if (stale()) return;
        setMode({ kind: 'confirm', snapshot: screenedSnapshot(candidate, full) });
      } catch (error) {
        if (stale()) return;
        setMode({ kind: returnToRef.current });
        setMessage(`check failed: ${messageOf(error)}`);
      }
    },
    [onScreen],
  );

  /**
   * Read the Trash, then show what emptying it would destroy.
   *
   * The read is a directory walk and can take seconds, so it gets a mode of its own and an
   * abandonment counter, exactly like the screening. It is also the only source of the figures
   * the prompt may show: `trash.ts` is explicit that the **whole** Trash must be disclosed,
   * never this run's contribution, because emptying takes the user's holiday photos along with
   * the `node_modules`.
   */
  const beginTrash = useCallback(async () => {
    if (readTrash === undefined) return;
    const run = trashRun.current + 1;
    trashRun.current = run;
    const stale = (): boolean => !mounted.current || trashRun.current !== run;

    setMode({ kind: 'trash-reading' });
    try {
      const summary = await readTrash();
      if (stale()) return;
      setMode({ kind: 'trash-confirm', summary, typed: '' });
    } catch (error) {
      if (stale()) return;
      setMode({ kind: returnToRef.current });
      setMessage(`could not read the Trash: ${messageOf(error)}`);
    }
  }, [readTrash]);

  /**
   * Empty the Trash. Irreversible, and total — everything in it, not this run's items.
   *
   * Re-reads the summary afterwards rather than trusting the attempt's own verdict: Finder may
   * have emptied part of the Trash before erroring, and a timeout on a very large empty means
   * "still working" more often than it means "failed". Then re-reads the disk, because seeing
   * the free space actually move is the entire reason this action exists.
   */
  const runEmptyTrash = useCallback(async () => {
    if (onEmptyTrash === undefined) return;
    if (emptyStarted.current) return;
    emptyStarted.current = true;

    setMode({ kind: 'emptying' });
    try {
      const result = await onEmptyTrash();
      let after: TrashSummary | undefined;
      try {
        after = await readTrash?.();
      } catch {
        after = undefined;
      }
      if (!mounted.current) return;
      if (result.ok) trashEmptiedRef.current = true;
      setMode({ kind: 'trash-result', ok: result.ok, detail: result.detail, summary: after });
      void refreshDisk();
    } catch (error) {
      if (!mounted.current) return;
      setMode({ kind: 'trash-result', ok: false, detail: messageOf(error), summary: undefined });
    } finally {
      emptyStarted.current = false;
    }
  }, [onEmptyTrash, readTrash, refreshDisk]);

  const openTriage = useCallback(() => {
    setCursorId(
      firstReclaimableId(rows, selectionRef.current) ?? firstSelectableId(rows),
    );
    setMode({ kind: 'triage' });
    setMessage(undefined);
  }, [rows]);

  useInput(
    (input, key) => {
      // Guard: while directories are being moved, or the Trash is being destroyed, the
      // keyboard is dead. `q` is the key that proves why — let through mid-clean it reports
      // "nothing was cleaned" to the CLI while `onClean` is still working, so the invariant-8
      // disclosure is skipped entirely and the user is never told what is in their Trash.
      // `mode` is React state, and state does not commit within the tick that scheduled it.
      // Two keys delivered in one read — a double-tap, a held key, a terminal batching two
      // events — both reach the handler closure from the render BEFORE the clean started, so
      // this test still sees `confirm` and lets the second key through. The `cleanStarted`
      // ref is set synchronously inside `runClean`, so it is the only thing that is already
      // true by then; the mode test stays because the ref is cleared when a round ends and
      // the mode covers `emptying` too.
      if (mode.kind === 'cleaning' || mode.kind === 'emptying' || cleanStarted.current) return;

      // Splash waits; no keys advance it (q still quits).
      if (mode.kind === 'splash') {
        if (input === 'q' || (key.ctrl && input === 'c')) quit();
        return;
      }

      // Mid-screen, the keyboard is as inert as it is mid-clean — no key may advance to the
      // question, and none may reach the workspace underneath and change what is being screened.
      // The exception is leaving: nothing has been touched yet, so `q` reports the truth and
      // `esc` abandons a check whose result is then dropped by the run counter.
      if (mode.kind === 'screening' || mode.kind === 'trash-reading') {
        if (input === 'q' || (key.ctrl && input === 'c')) {
          screenRun.current += 1;
          trashRun.current += 1;
          quit();
        } else if (key.escape) {
          screenRun.current += 1;
          trashRun.current += 1;
          setMode({ kind: returnToRef.current });
        }
        return;
      }

      /**
       * Typing the word. Placed above the global `q` handler on purpose: while the user is
       * spelling a word, letters are text, and a `q` that quit the application mid-word would
       * be indistinguishable from a typo. Ctrl-C still leaves, because it always does.
       */
      if (mode.kind === 'trash-confirm') {
        if (key.ctrl && input === 'c') {
          quit();
        } else if (key.escape) {
          setMode({ kind: returnToRef.current });
        } else if (key.backspace || key.delete) {
          setMode({ ...mode, typed: mode.typed.slice(0, -1) });
        } else if (key.return) {
          // Exact equality, never a prefix, and only when a total was actually disclosed:
          // an empty offered without a figure is an offer the user cannot evaluate.
          if (trashConfirmArmed(mode.summary, mode.typed)) void runEmptyTrash();
        } else if (/^[a-z]+$/i.test(input)) {
          setMode({
            ...mode,
            typed: (mode.typed + input.toLowerCase()).slice(0, EMPTY_TRASH_WORD.length),
          });
        }
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        quit();
        return;
      }

      if (mode.kind === 'confirm') {
        if (key.escape) setMode({ kind: returnToRef.current });
        // Nothing deletable survived the screen, so there is nothing to say yes to: `enter`
        // would otherwise run a clean of zero targets and report "nothing was selected" to a
        // user who selected plenty and was refused all of it.
        else if (key.return && mode.snapshot.targets.length > 0) void runClean(mode.snapshot);
        return;
      }

      /**
       * Done / trash-result: the one place `enter` does nothing.
       *
       * `enter` is the commit key: it opens the confirmation and it spends consent. A held
       * `enter` — and the confirmation dialog is exactly where people hold keys — would
       * otherwise chain *dismiss → home → enter → screening → confirm → enter* and run a
       * second round nobody asked for. Dismissal is `esc` → Home (or the prior workspace for
       * trash-result).
       */
      if (mode.kind === 'done' || mode.kind === 'trash-result') {
        if (key.escape || input === ' ') {
          setMode({ kind: mode.kind === 'done' ? 'home' : returnToRef.current });
          setMessage(undefined);
        } else if (input === 't' && mode.kind === 'done' && canEmptyTrash) {
          returnToRef.current = 'home';
          void beginTrash();
        }
        return;
      }

      if (mode.kind === 'detail') {
        if (key.escape) setMode({ kind: 'triage' });
        return;
      }

      if (mode.kind === 'home') {
        setMessage(undefined);
        if (input === 'b') {
          openTriage();
        } else if (input === 'p') {
          setPreset(cyclePreset);
        } else if (input === 't') {
          if (canEmptyTrash) {
            returnToRef.current = 'home';
            void beginTrash();
          } else setMessage('Emptying the Trash is not available here');
        } else if (key.return) {
          if (recommendedCount === 0 || recommendedTargets.length === 0) {
            // Never open Confirm of zero under a celebratory number.
            return;
          }
          returnToRef.current = 'home';
          void beginScreening({
            rows: recommendedChosen,
            targets: recommendedTargets,
            bytes: recommendedBytes,
          });
        }
        return;
      }

      // Triage
      setMessage(undefined);

      if (key.escape) {
        setMode({ kind: 'home' });
        return;
      }
      if (input === 'd') {
        setMode({ kind: 'detail' });
        return;
      }
      if (key.upArrow || input === 'k') {
        setCursorId((current) => moveCursor(rows, current, -1));
      } else if (key.downArrow || input === 'j') {
        setCursorId((current) => moveCursor(rows, current, 1));
      } else if (input === ' ') {
        if (currentRow !== undefined) {
          writeSelection((current) => toggleRow(current, currentRow));
        }
      } else if (input === 'a') {
        if (currentRow !== undefined) {
          writeSelection((current) => toggleSection(current, rows, currentRow.section));
        }
      } else if (input === 'p') {
        setPreset(cyclePreset);
      } else if (input === 't') {
        if (canEmptyTrash) {
          returnToRef.current = 'triage';
          void beginTrash();
        } else setMessage('Emptying the Trash is not available here');
      } else if (key.return) {
        if (targets.length === 0) setMessage('Nothing selected');
        // A *new* snapshot, every time. Nothing is carried over from a previous round: the
        // rows, the targets and the total are read fresh and screened fresh.
        else {
          returnToRef.current = 'triage';
          void beginScreening({ rows: chosen, targets, bytes: totalBytes });
        }
      }
    },
    { isActive: isRawModeSupported },
  );

  // Wide enough for the Trash prompt's disclosure sentences to land on one line each: a
  // warning that wraps mid-clause is a warning people skim.
  const paneWidth = Math.min(columns - 4, 72);

  if (mode.kind === 'splash') {
    return (
      <Splash
        width={columns}
        height={frameRows}
        scanning={scanning}
        rootsLabel={rootsLabel}
        projects={session.projects.length}
        caches={session.caches.length}
        bytes={foundBytes}
      />
    );
  }

  if (mode.kind === 'home') {
    return (
      <Home
        width={columns}
        height={frameRows}
        rootsLabel={rootsLabel}
        scanning={scanning}
        recommendedCount={recommendedCount}
        recommendedBytes={recommendedBytes}
        dormantCount={dormantCount}
        activeCount={activeCount}
        cacheCount={cacheCount}
        disk={disk}
        session={sessionSummary(session)}
      />
    );
  }

  if (mode.kind === 'screening') {
    const { candidate, provisional } = mode;
    const checking = candidate.targets.length;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Checking what can be trashed…
        </Text>
        <Text dimColor>
          {`${checking} ${checking === 1 ? 'directory' : 'directories'} · ` +
            `${formatBytes(candidate.bytes)} · looking inside each for git repositories`}
        </Text>
        {provisional.length > 0 ? (
          <Text color="red">{`${provisional.length} blocked so far`}</Text>
        ) : null}
        <Text dimColor>{hintsFor('screening')}</Text>
      </Box>
    );
  }

  if (mode.kind === 'confirm') {
    const { snapshot } = mode;
    // Rows the scan turned up after the question was asked. They stay in the background
    // list and are offered on the next pass; what they must not do is join this run
    // unannounced. Counting them is the difference between "not included" and "hidden".
    const frozen = new Set(snapshot.rows.map((row) => row.id));
    const arrivals = chosen.filter((row) => !frozen.has(row.id)).length;

    return (
      <Box flexDirection="column">
        <Confirm
          entries={snapshot.entries}
          blocked={snapshot.blocked}
          targetCount={snapshot.targets.length}
          bytes={snapshot.bytes}
          blockedBytes={snapshot.blockedBytes}
          width={Math.min(columns - 4, 56)}
          // Minus the two rows App itself spends around this pane (a spacer and the quit
          // hint). Handing Confirm the whole terminal is how the frame came to be exactly
          // two lines too tall.
          height={rowsAvailable - 2}
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

  if (mode.kind === 'cleaning') {
    const { snapshot } = mode;
    const cleaningCount = snapshot.targets.length;
    // The one screen with the terminal to itself and a user who has nothing to do but wait, so
    // it is the one screen that can afford the tall wordmark — and the one that should have it,
    // because the wait is where a tool either feels considered or feels stalled. It is drawn
    // only when the terminal can hold it *and* the frame still fits inside `rows - 1`, which is
    // the same rule the workspace obeys and for the same reason.
    const roomForLogo = rowsAvailable - RESERVED_ROW >= 8;
    return (
      <Box flexDirection="column" paddingX={1}>
        {roomForLogo ? (
          <Box flexDirection="column">
            <Logo width={Math.max(0, columns - 2)} />
            <Text> </Text>
          </Box>
        ) : null}
        <Headline
          bytes={snapshot.bytes}
          caption={`moving to the Trash… · ${cleaningCount} ${cleaningCount === 1 ? 'directory' : 'directories'}`}
          note={TRASH_CAVEAT}
          width={Math.max(0, columns - 2)}
        />
      </Box>
    );
  }

  if (mode.kind === 'done') {
    return (
      <Box flexDirection="column">
        <RoundSummary report={mode.report} width={paneWidth} canEmptyTrash={canEmptyTrash} />
      </Box>
    );
  }

  if (mode.kind === 'trash-reading') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Reading the Trash…
        </Text>
        <Text dimColor>measuring everything in it, so you can see what emptying would destroy</Text>
        <Text dimColor>{hintsFor('screening')}</Text>
      </Box>
    );
  }

  if (mode.kind === 'trash-confirm') {
    return <TrashConfirm summary={mode.summary} typed={mode.typed} width={paneWidth} />;
  }

  if (mode.kind === 'emptying') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">
          Emptying the Trash…
        </Text>
        <Text dimColor>this can take a while for a Trash full of small files</Text>
      </Box>
    );
  }

  if (mode.kind === 'trash-result') {
    return (
      <TrashResult ok={mode.ok} detail={mode.detail} summary={mode.summary} width={paneWidth} />
    );
  }

  if (mode.kind === 'detail') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" flexDirection="column" paddingX={1} width={columns}>
          <Detail
            row={currentRow}
            categories={categories}
            width={Math.max(0, columns - 4)}
            height={Math.max(1, frameRows - PANE_BORDER_HEIGHT - FOOTER_HEIGHT)}
          />
        </Box>
        <Footer
          hints={hintsFor('detail')}
          session={sessionSummary(session)}
          message={message}
          width={columns}
        />
      </Box>
    );
  }

  // Triage: full-width list + focused-row status line + contextual footer. No Detail sibling.
  const selectable = rows.reduce((sum, row) => (row.kind === 'header' ? sum : sum + 1), 0);

  /**
   * The two lines beside the headline figure.
   *
   * The first is what the figure *is* — how much of the list it covers — and, when there is a
   * choice to project, what the volume would become. The second is the standing note: the
   * caveat while something is selected, because that is exactly when a projected free-space
   * figure could be misread as a reading; the bar's legend when nothing is, because that is
   * when the bar is least self-explanatory and the caveat has nothing to qualify.
   *
   * Both strings come from `diskbar.ts` rather than being retyped or recomputed here — the
   * projection through `diskLabels`, which owns the clamping, and `TRASH_CAVEAT` as the exported
   * constant it is — so a re-layout cannot quietly drop the sentence that keeps the projection
   * honest, and the figure beside the bar and the figure beside the headline cannot disagree.
   */
  const projected = disk === undefined ? undefined : diskLabels(disk, totalBytes).projected;
  const headlineCaption = [
    `selected ${count} of ${selectable}`,
    ...(projected === undefined ? [] : [projected]),
  ].join(' · ');
  const headlineNote = totalBytes > 0 ? TRASH_CAVEAT : BAR_LEGEND;

  /**
   * The preset is dropped from the title line before the scan indicator is squeezed.
   *
   * They are not equal claims on the space. "Is the scan finished" is the question the user has
   * to answer correctly before pressing enter, and the settled state is the only thing on
   * screen that answers it; the preset is configuration, restated by the `p` hint in the
   * footer and visible in the sizes themselves. Decided from the terminal's width rather than
   * by letting Yoga shrink both, so that at any width one of them is *readable* rather than
   * both being half-printed.
   */
  const presetText = `  preset ${preset}`;
  const showPreset = columns - 2 >= WORDMARK.length + presetText.length + MIN_SCAN_WIDTH + 2;
  const focusedStatus = statusLine(currentRow, categories, Math.max(0, columns - 2));

  return (
    <Box flexDirection="column">
      <Box paddingX={1} flexDirection="column">
        {/* Every segment shrinks. The line grows with the project count, the bytes found and
            the preset's name, and at a narrow terminal an unshrinkable piece would push the
            line past the terminal's width, wrap it, and cost the list a row — which is how the
            frame gets taller than the screen and the header starts duplicating. */}
        <Box width={Math.max(0, columns - 2)}>
          {/* flexShrink={0}: the wordmark is the one thing on this line that must not be
              eaten. Everything after it is status that degrades gracefully. */}
          <Box flexShrink={0}>
            <Text bold color="cyan">{WORDMARK}</Text>
          </Box>
          {showPreset ? (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">{presetText}</Text>
            </Box>
          ) : null}
          {/* A margin rather than trailing spaces on the text: the text is truncated when the
              line is tight, and truncation eats trailing spaces exactly when the gap is most
              needed — leaving `preset recomm…✓ scan complete` run together. */}
          <Box flexShrink={1} flexGrow={1} marginLeft={2} justifyContent="flex-end">
            <ScanStatus
              scanning={scanning}
              projects={session.projects.length}
              caches={session.caches.length}
              bytes={foundBytes}
            />
          </Box>
        </Box>
        {fullChrome ? <Gauge usage={disk} reclaiming={totalBytes} width={columns - 2} /> : null}
        {fullChrome ? (
          <Headline
            bytes={totalBytes}
            caption={headlineCaption}
            note={headlineNote}
            width={Math.max(0, columns - 2)}
          />
        ) : null}
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} width={listWidth}>
        <List
          rows={rows}
          cursorId={cursorId}
          selection={selection}
          width={Math.max(0, listWidth - 4)}
          view={view}
          // Without this the network/offline pair — 2 of the 6 chip kinds — can never
          // appear in the list, the surface they were built for. `chipsOf` drops them
          // when `categories` is undefined, because "needs network" is false under a
          // preset that does not clean node_modules and a chip that guesses is worse
          // than no chip.
          categories={categories}
        />
      </Box>
      {showStatusLine ? (
        <Box paddingX={1}>
          <Text dimColor wrap="truncate-end">
            {focusedStatus.length > 0 ? focusedStatus : ' '}
          </Text>
        </Box>
      ) : null}
      <Footer
        hints={hintsFor('triage')}
        session={sessionSummary(session)}
        message={message}
        width={columns}
      />
    </Box>
  );
}

export interface RunOptions extends AppProps {
  stdout?: NodeJS.WriteStream | undefined;
  stdin?: NodeJS.ReadStream | undefined;
}

/**
 * Mount the app and resolve once it exits, with what the whole session did.
 *
 * `cli.ts` is a `.ts` file and cannot write JSX, so the mounting lives here rather than
 * there — and with it the knowledge that the summary must be captured from `onExit`
 * before `waitUntilExit` resolves. `exitOnCtrlC` is off because Ctrl-C is handled in the
 * input handler, which routes it through the same `onExit` as `q`; left on, Ink would tear
 * the app down without ever reporting.
 */
export async function runApp(options: RunOptions): Promise<ExitSummary> {
  const { stdout, stdin, ...props } = options;
  let summary: ExitSummary = NOTHING_HAPPENED;

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
