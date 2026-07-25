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
 *
 * **The snapshot is screened before it is shown, and that is the whole point of freezing
 * it.** The list describes what is *selected*; `clean.ts` decides what is *deletable*. When
 * those two are computed by different code the tool promises space it then refuses — so the
 * moment the set stops moving is the moment to ask the boundary's own guards about it.
 * `enter` therefore opens a `screening` phase, not the question: `onScreen` (the CLI's bound
 * `screenTargets`) is run over exactly the frozen targets, first with the cheap tier and then
 * with the full one, and only then is the question rendered — with what will be trashed and
 * what will not, separately, and a headline counting only the former.
 *
 * Screening reads the filesystem and the nested-repository scan is budgeted at 50,000
 * directories per candidate, so it is visible work: the `screening` phase says so rather than
 * letting the interface freeze, and — following the precedent set by `cleaning` — no
 * keystroke can advance out of it. The two keys that *abandon* it still work, because unlike
 * a clean in flight nothing has been touched yet and leaving is always honest.
 */

import { Box, Text, render, useApp, useInput, useStdin, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Confirm, type BlockedEntry, type ConfirmEntry } from './Confirm.js';
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
// Type-only, and deliberately so: `import type` is erased at compile time, so the UI still
// never *loads* the module that can delete. The seam through which the screen is actually
// reached is the `onScreen` prop, exactly as `onClean` is for the deletion itself.
import type { Screening, ScreeningTier } from '../clean.js';
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
  /**
   * `screenTargets` from src/clean.ts, bound to its options by the CLI — the same guards
   * `onClean` will apply, asked before the user is asked.
   *
   * The tier is passed through so this component decides what it pays for: `'cheap'` for an
   * immediate partial answer, `'full'` (cheap plus the nested-repository scan) for the
   * verdict the question is rendered from. The binding must recompute
   * `unselectedNodeModules` from the targets it is handed — invariant 5 is a property of the
   * whole run, so a screen of a hypothetical selection has to be told what that selection is
   * (see `ScreeningOptions.unselectedNodeModules`).
   *
   * Optional only so that a caller which cannot vet — a test, a harness — still renders. An
   * app without it confirms exactly what it lists, which is the dishonest total this prop
   * exists to remove; `cli.ts` is expected to supply it.
   */
  onScreen?:
    | ((targets: readonly CleanTarget[], tier: ScreeningTier) => Promise<readonly Screening[]>)
    | undefined;
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
 * Modelled as a union rather than a string plus a nullable snapshot: `screening`, `confirm`
 * and `cleaning` cannot exist without the frozen list, and the type is what says so. The
 * `screening` phase carries the *unscreened* candidate — it is the state of not yet knowing
 * — while `confirm` and `cleaning` can only be built from a screened one.
 */
type Phase =
  | { kind: 'list' }
  | { kind: 'screening'; candidate: Candidate; provisional: readonly BlockedEntry[] }
  | { kind: 'confirm'; snapshot: ConfirmSnapshot }
  | { kind: 'cleaning'; snapshot: ConfirmSnapshot };

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
function screenedSnapshot(
  candidate: Candidate,
  screenings: readonly Screening[],
): ConfirmSnapshot {
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

const MIN_LIST_WIDTH = 28;
const MAX_LIST_WIDTH = 52;
/** Border, padding, title and footer, subtracted from the terminal's rows. */
const CHROME_HEIGHT = 7;

export function App({
  stream,
  categoriesFor,
  onClean,
  onScreen,
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
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

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
        setMessage(`check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [onScreen],
  );

  useInput(
    (input, key) => {
      if (phase.kind === 'cleaning') return;

      // Mid-screen, the keyboard is as inert as it is mid-clean — no key may advance to the
      // question, and none may reach the list underneath and change what is being screened.
      // The exception is leaving: nothing has been touched yet, so `q` reports the truth and
      // `esc` abandons a check whose result is then dropped by the run counter.
      if (phase.kind === 'screening') {
        if (input === 'q' || (key.ctrl && input === 'c')) {
          screenRun.current += 1;
          quit();
        } else if (key.escape) {
          screenRun.current += 1;
          setPhase({ kind: 'list' });
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
        else void beginScreening({ rows: chosen, targets, bytes: totalBytes });
      }
    },
    { isActive: isRawModeSupported },
  );

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
