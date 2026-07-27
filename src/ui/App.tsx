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
 * # The layout is a fixed budget
 *
 * The frame is exactly as tall as the terminal, and the list is the only part that gives. The
 * header (three lines), the section note (one), the pane borders (two), the list's own scroll
 * hint (one) and the footer (two) are subtracted from the terminal's rows and whatever is left
 * is the window `viewport.ts` is asked for. That is what makes the footer *pinned*: it is not
 * pinned by a flex property, it is pinned because nothing above it is ever allowed to be
 * taller than the space it was given.
 */

import { Box, Text, render, useApp, useInput, useStdin, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Confirm, type BlockedEntry, type ConfirmEntry } from './Confirm.js';
import { Detail } from './Detail.js';
import { Gauge } from './Gauge.js';
import { Footer } from './Footer.js';
import { List } from './List.js';
import { RoundSummary, type ProblemEntry, type RoundReport } from './Round.js';
import { ScanStatus } from './ScanStatus.js';
import { EMPTY_TRASH_WORD, TrashConfirm, TrashResult, trashConfirmArmed } from './Trash.js';
import { formatBytes, truncateLabel } from './format.js';
import {
  EMPTY_SELECTION,
  EMPTY_SESSION,
  SECTION_NOTES,
  applyRound,
  buildRows,
  cursorIndex,
  cyclePreset,
  defaultSelection,
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
import type { DiskUsage } from './diskbar.js';
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
 * Modelled as a union rather than a string plus a pile of nullable fields: `screening`,
 * `confirm` and `cleaning` cannot exist without the frozen list, `result` cannot exist without
 * a round to report, and `trash-confirm` cannot exist without the summary whose figures the
 * prompt is required to show. The type is what says so.
 */
type Phase =
  | { kind: 'list' }
  | { kind: 'screening'; candidate: Candidate; provisional: readonly BlockedEntry[] }
  | { kind: 'confirm'; snapshot: ConfirmSnapshot }
  | { kind: 'cleaning'; snapshot: ConfirmSnapshot }
  | { kind: 'result'; report: RoundReport }
  | { kind: 'trash-check' }
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

const MIN_LIST_WIDTH = 28;
const MAX_LIST_WIDTH = 52;

/**
 * The fixed part of the frame, in lines. Everything here is drawn on every list frame, so the
 * list gets the terminal's rows minus this and not one line more.
 *
 * - 3 header: the title-and-scan line, and the two lines of the disk gauge.
 * - 1 section note.
 * - 2 pane borders (top and bottom).
 * - 1 scroll hint, drawn *inside* the list pane by `List` whether or not it has anything to
 *   say — a line that came and went would change the frame height as the user scrolled.
 * - 2 footer: the key hints and the status line.
 */
const HEADER_HEIGHT = 3;
const NOTE_HEIGHT = 1;
const PANE_BORDER_HEIGHT = 2;
const SCROLL_HINT_HEIGHT = 1;
const FOOTER_HEIGHT = 2;
const CHROME_HEIGHT =
  HEADER_HEIGHT + NOTE_HEIGHT + PANE_BORDER_HEIGHT + SCROLL_HINT_HEIGHT + FOOTER_HEIGHT;

/** Below this the pane is unusable anyway, and a negative window is not a window. */
const MIN_LIST_HEIGHT = 3;

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
  const [phase, setPhase] = useState<Phase>({ kind: 'list' });
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [disk, setDisk] = useState<DiskUsage | undefined>(undefined);

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
   * is entirely ordinary — both reach the *previous* render's handler while `phase` still
   * reads `confirm`. A `setPhase` cannot stop the second one: state updates are asynchronous,
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
   * candidate) and the user can leave it — `esc` back to the list, `q` out of the app. The
   * `await` does not know that, so its result would arrive and open a confirmation for a
   * selection the user has since changed, or set state on a component that is gone. Every
   * departure bumps this counter; a result whose run is no longer the current one is
   * dropped. Freezing the set is worth nothing if a stale verdict can unfreeze it.
   */
  const screenRun = useRef(0);
  /** The same, for the Trash read, which walks `~/.Trash` and is just as abandonable. */
  const trashRun = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const columns = width ?? stdout?.columns ?? 80;
  // Two panes only fit when both can meet their minimum. Below that, one pane takes the
  // full width and the detail is dropped rather than squeezed.
  //
  // The previous form clamped each pane independently — `min(52, max(28, columns*0.55))`
  // for the list and `max(28, columns - listWidth)` for the detail — so between 40 and 60
  // columns the second clamp fired and the two widths summed to MORE than the terminal.
  // Yoga then wrapped every row, and the frame rendered ~1.7x the declared height, which
  // defeats the pinned footer the viewport work exists to guarantee.
  const twoPane = columns >= MIN_LIST_WIDTH * 2;
  const listWidth = twoPane
    ? Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, columns - MIN_LIST_WIDTH))
    : columns;
  const detailWidth = twoPane ? columns - listWidth : 0;
  const rowsAvailable = height ?? stdout?.rows ?? 24;
  const listHeight = Math.max(MIN_LIST_HEIGHT, rowsAvailable - CHROME_HEIGHT);

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
   * Run the clean, then **return to the list**.
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

      setPhase({ kind: 'cleaning', snapshot });
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

        setPhase({
          kind: 'result',
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
        setPhase({ kind: 'list' });
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
   * A screen that throws sends the user back to the list with the error rather than to the
   * question. Proceeding would mean rendering a total nobody checked, which is precisely the
   * defect this path exists to close; `clean` would still refuse at the boundary, but the
   * promise on screen would already have been made.
   */
  const beginScreening = useCallback(
    async (candidate: Candidate) => {
      const run = screenRun.current + 1;
      screenRun.current = run;
      const stale = (): boolean => !mounted.current || screenRun.current !== run;

      setPhase({ kind: 'screening', candidate, provisional: [] });

      if (onScreen === undefined) {
        setPhase({ kind: 'confirm', snapshot: screenedSnapshot(candidate, []) });
        return;
      }

      try {
        const cheap = await onScreen(candidate.targets, 'cheap');
        if (stale()) return;
        setPhase({
          kind: 'screening',
          candidate,
          provisional: blockedEntriesOf(candidate.targets, cheap),
        });

        const full = await onScreen(candidate.targets, 'full');
        if (stale()) return;
        setPhase({ kind: 'confirm', snapshot: screenedSnapshot(candidate, full) });
      } catch (error) {
        if (stale()) return;
        setPhase({ kind: 'list' });
        setMessage(`check failed: ${messageOf(error)}`);
      }
    },
    [onScreen],
  );

  /**
   * Read the Trash, then show what emptying it would destroy.
   *
   * The read is a directory walk and can take seconds, so it gets a phase of its own and an
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

    setPhase({ kind: 'trash-check' });
    try {
      const summary = await readTrash();
      if (stale()) return;
      setPhase({ kind: 'trash-confirm', summary, typed: '' });
    } catch (error) {
      if (stale()) return;
      setPhase({ kind: 'list' });
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

    setPhase({ kind: 'emptying' });
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
      setPhase({ kind: 'trash-result', ok: result.ok, detail: result.detail, summary: after });
      void refreshDisk();
    } catch (error) {
      if (!mounted.current) return;
      setPhase({ kind: 'trash-result', ok: false, detail: messageOf(error), summary: undefined });
    } finally {
      emptyStarted.current = false;
    }
  }, [onEmptyTrash, readTrash, refreshDisk]);

  useInput(
    (input, key) => {
      // Guard: while directories are being moved, or the Trash is being destroyed, the
      // keyboard is dead. `q` is the key that proves why — let through mid-clean it reports
      // "nothing was cleaned" to the CLI while `onClean` is still working, so the invariant-8
      // disclosure is skipped entirely and the user is never told what is in their Trash.
      // `phase` is React state, and state does not commit within the tick that scheduled it.
      // Two keys delivered in one read — a double-tap, a held key, a terminal batching two
      // events — both reach the handler closure from the render BEFORE the clean started, so
      // this test still sees `confirm` and lets the second key through. The `cleanStarted`
      // ref is set synchronously inside `runClean`, so it is the only thing that is already
      // true by then; the phase test stays because the ref is cleared when a round ends and
      // the phase covers `emptying` too.
      if (phase.kind === 'cleaning' || phase.kind === 'emptying' || cleanStarted.current) return;

      // Mid-screen, the keyboard is as inert as it is mid-clean — no key may advance to the
      // question, and none may reach the list underneath and change what is being screened.
      // The exception is leaving: nothing has been touched yet, so `q` reports the truth and
      // `esc` abandons a check whose result is then dropped by the run counter.
      if (phase.kind === 'screening' || phase.kind === 'trash-check') {
        if (input === 'q' || (key.ctrl && input === 'c')) {
          screenRun.current += 1;
          trashRun.current += 1;
          quit();
        } else if (key.escape) {
          screenRun.current += 1;
          trashRun.current += 1;
          setPhase({ kind: 'list' });
        }
        return;
      }

      /**
       * Typing the word. Placed above the global `q` handler on purpose: while the user is
       * spelling a word, letters are text, and a `q` that quit the application mid-word would
       * be indistinguishable from a typo. Ctrl-C still leaves, because it always does.
       */
      if (phase.kind === 'trash-confirm') {
        if (key.ctrl && input === 'c') {
          quit();
        } else if (key.escape) {
          setPhase({ kind: 'list' });
        } else if (key.backspace || key.delete) {
          setPhase({ ...phase, typed: phase.typed.slice(0, -1) });
        } else if (key.return) {
          // Exact equality, never a prefix, and only when a total was actually disclosed:
          // an empty offered without a figure is an offer the user cannot evaluate.
          if (trashConfirmArmed(phase.summary, phase.typed)) void runEmptyTrash();
        } else if (/^[a-z]+$/i.test(input)) {
          setPhase({
            ...phase,
            typed: (phase.typed + input.toLowerCase()).slice(0, EMPTY_TRASH_WORD.length),
          });
        }
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        quit();
        return;
      }

      if (phase.kind === 'confirm') {
        if (key.escape) setPhase({ kind: 'list' });
        // Nothing deletable survived the screen, so there is nothing to say yes to: `enter`
        // would otherwise run a clean of zero targets and report "nothing was selected" to a
        // user who selected plenty and was refused all of it.
        else if (key.return && phase.snapshot.targets.length > 0) void runClean(phase.snapshot);
        return;
      }

      /**
       * The round summary, and the one screen in this application where `enter` does nothing.
       *
       * `enter` is the commit key: it opens the confirmation and it spends consent. A held
       * `enter` — and the confirmation dialog is exactly where people hold keys — would
       * otherwise chain *dismiss → list → enter → screening → confirm → enter* and run a
       * second round nobody asked for. The screen that sits between two rounds therefore
       * refuses the key that starts them.
       */
      if (phase.kind === 'result' || phase.kind === 'trash-result') {
        if (key.escape || input === ' ') {
          setPhase({ kind: 'list' });
          setMessage(undefined);
        } else if (input === 't' && phase.kind === 'result' && canEmptyTrash) {
          void beginTrash();
        }
        return;
      }

      setMessage(undefined);

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
        if (canEmptyTrash) void beginTrash();
        else setMessage('Emptying the Trash is not available here');
      } else if (key.return) {
        if (targets.length === 0) setMessage('Nothing selected');
        // A *new* snapshot, every time. Nothing is carried over from a previous round: the
        // rows, the targets and the total are read fresh and screened fresh.
        else void beginScreening({ rows: chosen, targets, bytes: totalBytes });
      }
    },
    { isActive: isRawModeSupported },
  );

  // Wide enough for the Trash prompt's disclosure sentences to land on one line each: a
  // warning that wraps mid-clause is a warning people skim.
  const paneWidth = Math.min(columns - 4, 72);

  if (phase.kind === 'screening') {
    const { candidate, provisional } = phase;
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
        <Text dimColor>esc cancel · q quit</Text>
      </Box>
    );
  }

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
          entries={snapshot.entries}
          blocked={snapshot.blocked}
          targetCount={snapshot.targets.length}
          bytes={snapshot.bytes}
          blockedBytes={snapshot.blockedBytes}
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

  if (phase.kind === 'result') {
    return <RoundSummary report={phase.report} width={paneWidth} canEmptyTrash={canEmptyTrash} />;
  }

  if (phase.kind === 'trash-check') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Reading the Trash…
        </Text>
        <Text dimColor>measuring everything in it, so you can see what emptying would destroy</Text>
        <Text dimColor>esc cancel · q quit</Text>
      </Box>
    );
  }

  if (phase.kind === 'trash-confirm') {
    return <TrashConfirm summary={phase.summary} typed={phase.typed} width={paneWidth} />;
  }

  if (phase.kind === 'emptying') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">
          Emptying the Trash…
        </Text>
        <Text dimColor>this can take a while for a Trash full of small files</Text>
      </Box>
    );
  }

  if (phase.kind === 'trash-result') {
    return (
      <TrashResult ok={phase.ok} detail={phase.detail} summary={phase.summary} width={paneWidth} />
    );
  }

  const foundBytes = rows.reduce((sum, row) => (row.kind === 'header' ? sum + row.bytes : sum), 0);
  const note = currentRow === undefined ? ' ' : SECTION_NOTES[currentRow.section];

  return (
    <Box flexDirection="column">
      <Box paddingX={1} flexDirection="column">
        {/* Truncated like every other full-width line: the status grows with the project
            count and the bytes found, and at a narrow terminal it wraps to two lines and
            pushes the whole frame past the height budget. */}
        <Box width={Math.max(0, columns - 2)}>
          {/* flexShrink={0}: the product name is the one thing on this line that must not
              be eaten. Everything after it is a status that degrades gracefully. */}
          <Box flexShrink={0}>
            <Text bold>dev-cleaner </Text>
          </Box>
          <ScanStatus
            scanning={scanning}
            projects={session.projects.length}
            caches={session.caches.length}
            bytes={foundBytes}
          />
        </Box>
        <Gauge usage={disk} reclaiming={totalBytes} width={columns - 2} />
      </Box>
      <Box>
        <Box borderStyle="round" flexDirection="column" paddingX={1} width={listWidth}>
          <List
            rows={rows}
            cursorId={cursorId}
            selection={selection}
            width={listWidth - 4}
            view={view}
            // Without this the network/offline pair — 2 of the 6 chip kinds — can never
            // appear in the list, the surface they were built for. `chipsOf` drops them
            // when `categories` is undefined, because "needs network" is false under a
            // preset that does not clean node_modules and a chip that guesses is worse
            // than no chip. The value was already computed and already handed to Detail.
            categories={categories}
          />
        </Box>
        {/* Narrow terminals get the list at full width rather than two squeezed panes.
            A detail pane below ~28 columns wraps every line it holds, which costs more
            rows than the information is worth. */}
        {twoPane ? (
          <Box borderStyle="round" flexDirection="column" paddingX={1} width={detailWidth}>
            <Detail
              row={currentRow}
              categories={categories}
              width={detailWidth - 4}
              height={listHeight + SCROLL_HINT_HEIGHT}
            />
          </Box>
        ) : null}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{truncateLabel(note, Math.max(0, columns - 2))}</Text>
      </Box>
      <Footer
        preset={preset}
        selectedCount={count}
        selectedBytes={totalBytes}
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
