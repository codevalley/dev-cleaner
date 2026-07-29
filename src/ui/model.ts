/**
 * The TUI's state, as pure functions.
 *
 * Every rule the interface promises lives here rather than in a component: which rows
 * exist and in what order, what is selected by default, what a selection turns into when
 * the user confirms. Components read this module and render; they hold no policy. That
 * split is what lets the interesting behaviour be tested without a terminal.
 *
 * Two rules are load-bearing:
 *
 * 1. **Protection is a default, not a lock.** Projects scored `active` land in their own
 *    section and start unselected, but `toggleRow` treats them exactly like any other row.
 *    The spec is explicit: "They remain manually selectable."
 *
 * 2. **`toTargets` emits the discriminated `CleanTarget` union**, carrying the whole
 *    project and the whole artifact. A flattened `{path, bytes}` would be enough to
 *    delete with, and that is the point: `clean.ts` derives its containment and allowlist
 *    checks from the project and artifact, so flattening here would make the entire guard
 *    layer unreachable from the only path a user can actually invoke.
 */

import { formatBytes } from './format.js';
import type {
  CacheEntry,
  Category,
  CleanOutcome,
  CleanTarget,
  Preset,
  Project,
} from '../types.js';

/**
 * Why a row cannot be cleaned on this run, established *before* anything is selected.
 *
 * `CacheEntry.blocked` is the same fact for the one case `caches.ts` can answer on its own
 * (a package store with incoming hardlinks); this is the general form, and it exists because
 * the general form is what a project row needs. A project row can be refused for every
 * reason `clean.ts` names — `contains-repository`, `worktree-root`, `symlink`,
 * `guarded-path`, `outside-project-root`, `not-in-artifact-table` — and none of them is
 * expressible on `Project`, which is the scan's vocabulary rather than the boundary's.
 */
export interface RowBlock {
  /** The refusal in the words the summary would use, e.g. `worktree-root: /x/build is …`. */
  reason: string;
}

/**
 * Blocks by `Row.id` — one block per row, never a list.
 *
 * A row is one thing the user can select, so it is one thing that can be blocked: keying by
 * id is what makes "listed once, explained once, subtracted once" a property of the type
 * rather than of every caller's arithmetic. Two screens speaking about the same cache — the
 * store probe in `caches.ts` and the boundary vet in `clean.ts` — therefore cannot report it
 * twice.
 */
export type RowBlocks = ReadonlyMap<string, RowBlock>;

/** Rows are grouped into three sections, always rendered in this order. */
export type Section = 'projects' | 'active' | 'caches';

export const SECTION_ORDER: readonly Section[] = ['projects', 'active', 'caches'];

/**
 * What each section is called on screen.
 *
 * The middle one used to read `ACTIVE (protected)`, and both words were doing damage.
 *
 * "Protected" describes the *tool's* posture, not the user's situation, and it implies a
 * lock that does not exist — the section is a default, and `toggleRow` has always treated
 * these rows like any other. Worse, it invites the reading that the unprotected sections are
 * dangerous, which is exactly backwards.
 *
 * "Active" asserted a judgement the code was not making. The label was written while
 * `scoreActivity` was a stub that returned `active` for everything, so the header was simply
 * false: it grouped nothing, because nothing was ever anything else. The scorer is authored
 * now (see `src/activity.ts`), so the claim is true — but a user cannot know that, and a
 * header that states a verdict without stating its ground is a header that gets distrusted.
 *
 * So the label says what dev-cleaner observed, in the tense it observed it: these projects
 * were worked on recently. `SECTION_NOTES` says what follows from that, including the part
 * the old label never said — that checking one of these boxes is safe.
 */
export const SECTION_LABELS: Record<Section, string> = {
  projects: 'PROJECTS',
  active: 'IN USE RECENTLY',
  caches: 'CACHES',
};

/**
 * Whether a section's rows start checked.
 *
 * A table rather than a condition inside `defaultSelection`, because the interface has to
 * *say* this ("not checked by default") and a sentence that restates a rule written
 * elsewhere is a sentence that goes stale. `defaultSelection` reads this table, so the copy
 * and the behaviour are one fact.
 */
export const SECTION_PRESELECTED: Record<Section, boolean> = {
  projects: true,
  active: false,
  caches: true,
};

/**
 * The one thing a user needs to know before checking any box, and the answer to "it scares
 * me to check this section".
 *
 * It is not reassurance, it is the allowlist restated: a row exists only because a pattern in
 * `ARTIFACT_TABLE` named the directory, and every one of those patterns names build output or
 * a cache. `src/` cannot be a row. `.git` cannot be a row. There is no keystroke in this
 * interface that reaches them, which is why the worst outcome of a wrong check is a rebuild.
 */
export const SAFE_TO_CHECK =
  'Only regenerable directories are ever listed — build output, dependencies, caches. ' +
  'Never source, never git history. The worst a wrong check can cost you is a rebuild.';

/** One line per section: what it is, whether it starts checked, and what checking it does. */
export const SECTION_NOTES: Record<Section, string> = {
  projects: 'No commits or edits for a while. Checked by default.',
  active:
    'Worked on recently, so these start unchecked — not locked. ' +
    'Checking one costs a rebuild, nothing else.',
  caches: 'Shared package and tool caches. They refill the next time you build.',
};

export type Row =
  | { kind: 'header'; id: string; section: Section; label: string; bytes: number; count: number }
  | {
      kind: 'project';
      id: string;
      section: 'projects' | 'active';
      label: string;
      bytes: number;
      project: Project;
    }
  | { kind: 'cache'; id: string; section: 'caches'; label: string; bytes: number; cache: CacheEntry };

/**
 * Selection is keyed by identity — project root, cache id — not by row index, so it
 * survives the re-sorting that progressive sizing causes. Index-keyed selection silently
 * re-points at a different project when a size lands and the list reorders.
 */
export interface Selection {
  readonly projects: ReadonlySet<string>;
  readonly caches: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = { projects: new Set(), caches: new Set() };

export interface RowsInput {
  projects: readonly Project[];
  caches: readonly CacheEntry[];
  /** The preset's categories. Artifacts outside them are neither counted nor cleaned. */
  categories: ReadonlySet<Category>;
}

export interface TargetsInput {
  rows: readonly Row[];
  selection: Selection;
  categories: ReadonlySet<Category>;
}

/**
 * The artifacts of a project that the current preset actually enables. The scan walks with
 * the widest category set so that changing preset never re-walks the filesystem (spec:
 * "Preset selection recomputes which artifacts are selected; it does not re-walk"), which
 * means the narrowing has to happen here.
 */
export function enabledArtifacts(
  project: Project,
  categories: ReadonlySet<Category>,
): Project['artifacts'] {
  return project.artifacts.filter((artifact) => categories.has(artifact.category));
}

/** Sum of the project's artifacts under the current preset — the number shown in the list. */
export function projectBytes(project: Project, categories: ReadonlySet<Category>): number {
  return enabledArtifacts(project, categories).reduce((sum, artifact) => sum + artifact.bytes, 0);
}

function sectionOf(project: Project): 'projects' | 'active' {
  return project.activity.status === 'active' ? 'active' : 'projects';
}

/** Largest first; ties broken by name so the order is stable as sizes fill in. */
function bySizeThenName<T extends { bytes: number; label: string }>(a: T, b: T): number {
  return b.bytes - a.bytes || a.label.localeCompare(b.label);
}

/**
 * The whole list, in render order: PROJECTS (dormant), IN USE RECENTLY, CACHES — each
 * sorted by size descending, each preceded by a header carrying the section total. Empty
 * sections are omitted entirely, header included, so a scan with no caches does not show a
 * bare `CACHES 0B`.
 *
 * A project whose artifacts are all outside the current categories is dropped: under
 * `recommended`, a project whose only artifact is `node_modules` has nothing to offer, and
 * listing it at `0B` invites the user to select something that cleans nothing.
 */
export function buildRows(input: RowsInput): Row[] {
  const { projects, caches, categories } = input;

  const projectRows: Row[] = [];
  for (const project of projects) {
    const artifacts = enabledArtifacts(project, categories);
    // Keyed on the artifact count, never on the byte total: during a progressive scan a
    // project's sizes are 0 until they are measured, and dropping 0-byte rows would hide
    // every project for exactly as long as the scan takes.
    if (artifacts.length === 0) continue;
    projectRows.push({
      kind: 'project',
      id: `project:${project.root}`,
      section: sectionOf(project),
      label: project.name,
      bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
      project,
    });
  }

  const cacheRows: Row[] = caches.map((cache) => ({
    kind: 'cache',
    id: `cache:${cache.id}`,
    section: 'caches',
    label: cache.label,
    bytes: cache.bytes,
    cache,
  }));

  const rows: Row[] = [];
  for (const section of SECTION_ORDER) {
    const members = (section === 'caches' ? cacheRows : projectRows)
      .filter((row) => row.section === section)
      .sort(bySizeThenName);
    if (members.length === 0) continue;

    rows.push({
      kind: 'header',
      id: `header:${section}`,
      section,
      label: SECTION_LABELS[section],
      bytes: members.reduce((sum, row) => sum + row.bytes, 0),
      count: members.length,
    });
    rows.push(...members);
  }
  return rows;
}

export function isSelectable(row: Row): boolean {
  return row.kind !== 'header';
}

export function isSelected(selection: Selection, row: Row): boolean {
  if (row.kind === 'project') return selection.projects.has(row.project.root);
  if (row.kind === 'cache') return selection.caches.has(row.cache.id);
  return false;
}

/**
 * Why this row cannot be cleaned, or `undefined` when nothing has objected to it.
 *
 * Two screens can speak about the same row, and this is where that is reconciled to one
 * answer. `CacheEntry.blocked` wins: it is established earlier and more cheaply, in
 * `caches.ts`, and it answers a question the boundary vet cannot even ask — whether anything
 * *elsewhere on the machine*, outside every scanned root, still hardlinks into a package
 * store. Preferring it means the user reads the specific reason rather than the general one,
 * and — because the result is one block, not two — the row is marked once, explained once
 * and subtracted from the promised total once.
 */
export function rowBlock(row: Row, blocks?: RowBlocks): RowBlock | undefined {
  if (row.kind === 'header') return undefined;
  if (row.kind === 'cache' && row.cache.blocked !== undefined) return row.cache.blocked;
  return blocks?.get(row.id);
}

/**
 * Dormant projects and caches start selected; active projects do not. Both halves matter:
 * the tool is useless if nothing is preselected, and dangerous if work in progress is.
 *
 * A row carrying a block is the third case, and it is about honesty rather than safety.
 * `clean.ts` would refuse it anyway; preselecting it would still count its bytes into the
 * total the user is shown and consents to, and then hand back a refusal for the largest line
 * in the run. Promising something and then refusing it is how a user learns that refusals
 * are noise — the same failure `clean.ts` names from the other side ("a guard nobody can
 * satisfy is a guard that gets switched off").
 *
 * `blocks` covers **project rows as well as caches**, and that is the whole reason it is a
 * parameter rather than a field read off the row. A project row can be refused for six of
 * the boundary's reasons and `Project` has no way to say so; screening only `cache.blocked`
 * left every project row promised-then-refused the moment activity scoring starts marking
 * anything dormant. Callers that have not screened pass nothing and get today's behaviour
 * for caches — the report and the interface both screen, and the empty default is what keeps
 * `defaultSelection` usable from a component that only has rows.
 *
 * Not selecting a blocked row is still only a *default*: `toggleRow` treats it like any
 * other, exactly as it does a protected active project, and the boundary refusal is what
 * makes leaving it reachable safe.
 */
export function defaultSelection(rows: readonly Row[], blocks?: RowBlocks): Selection {
  const projects = new Set<string>();
  const caches = new Set<string>();

  for (const row of rows) {
    if (rowBlock(row, blocks) !== undefined) continue;
    // Read from the same table the section note is written from, so "checked by default"
    // cannot drift away from what is actually checked.
    if (!SECTION_PRESELECTED[row.section]) continue;
    if (row.kind === 'project') projects.add(row.project.root);
    else if (row.kind === 'cache') caches.add(row.cache.id);
  }
  return { projects, caches };
}

function withProjects(selection: Selection, projects: Set<string>): Selection {
  return { projects, caches: new Set(selection.caches) };
}

function withCaches(selection: Selection, caches: Set<string>): Selection {
  return { projects: new Set(selection.projects), caches };
}

/** Never mutates: React state must change identity to re-render. */
export function toggleRow(selection: Selection, row: Row): Selection {
  if (row.kind === 'project') {
    const projects = new Set(selection.projects);
    if (!projects.delete(row.project.root)) projects.add(row.project.root);
    return withProjects(selection, projects);
  }
  if (row.kind === 'cache') {
    const caches = new Set(selection.caches);
    if (!caches.delete(row.cache.id)) caches.add(row.cache.id);
    return withCaches(selection, caches);
  }
  return selection;
}

export function setSelected(selection: Selection, row: Row, selected: boolean): Selection {
  return isSelected(selection, row) === selected ? selection : toggleRow(selection, row);
}

/**
 * `a`: select the whole section, unless it is already fully selected, in which case clear
 * it. Applies to the protected section too — bulk-selecting active projects is a decision
 * the user is allowed to make.
 */
export function toggleSection(
  selection: Selection,
  rows: readonly Row[],
  section: Section,
): Selection {
  const members = rows.filter((row) => isSelectable(row) && row.section === section);
  if (members.length === 0) return selection;

  const target = !members.every((row) => isSelected(selection, row));
  return members.reduce((acc, row) => setSelected(acc, row, target), selection);
}

export function selectedRows(rows: readonly Row[], selection: Selection): Row[] {
  return rows.filter((row) => isSelectable(row) && isSelected(selection, row));
}

export function selectedCount(rows: readonly Row[], selection: Selection): number {
  return selectedRows(rows, selection).length;
}

export function selectedBytes(rows: readonly Row[], selection: Selection): number {
  return selectedRows(rows, selection).reduce((sum, row) => sum + row.bytes, 0);
}

/**
 * `p` cycles between the two presets the keyboard can express. `custom` means per-category
 * checkboxes, which this interface does not offer, so it is a state the CLI can start in
 * and the keyboard can leave — not one it can enter.
 */
export function cyclePreset(preset: Preset): Preset {
  return preset === 'recommended' ? 'aggressive' : 'recommended';
}

export function firstSelectableId(rows: readonly Row[]): string | undefined {
  return rows.find(isSelectable)?.id;
}

/**
 * Cursor seed for Triage/Home: the largest selected reclaimable row, else the largest
 * selectable row. Headers and blocked rows are never candidates.
 */
export function firstReclaimableId(
  rows: readonly Row[],
  selection: Selection,
): string | undefined {
  const selected = rows.filter(
    (row) => isSelectable(row) && isSelected(selection, row),
  );
  const pool = selected.length > 0 ? selected : rows.filter(isSelectable);
  if (pool.length === 0) return undefined;
  return pool.reduce((best, row) => (row.bytes > best.bytes ? row : best)).id;
}

/**
 * Move by `delta` rows, skipping headers and stopping at the ends rather than wrapping.
 * Wrapping in a list that re-sorts under the cursor is disorienting; clamping is not.
 * A cursor whose row has vanished (its project changed section, or the preset dropped it)
 * lands back on the first selectable row rather than nowhere.
 */
export function moveCursor(
  rows: readonly Row[],
  id: string | undefined,
  delta: number,
): string | undefined {
  const selectable = rows.filter(isSelectable);
  if (selectable.length === 0) return undefined;

  const current = selectable.findIndex((row) => row.id === id);
  if (current === -1) return selectable[0]?.id;

  const next = Math.min(Math.max(current + delta, 0), selectable.length - 1);
  return selectable[next]?.id;
}

/**
 * Where the cursor is, as an index into `rows` — what `viewport.ts` needs and what a
 * component would otherwise compute inline.
 *
 * Its fallback is deliberately the same as `moveCursor`'s: a cursor whose row has vanished
 * reports the first selectable row, not `-1` and not "wherever that index now points". The
 * two must agree, because one drives the scroll window and the other drives the keyboard;
 * disagreeing means arrowing down from a row that is not the one highlighted.
 *
 * `0` when there is nothing to point at — a legal index into an empty window, which is what
 * `windowFor` will make of it.
 */
export function cursorIndex(rows: readonly Row[], id: string | undefined): number {
  const at = rows.findIndex((row) => row.id === id);
  if (at !== -1) return at;
  const first = rows.findIndex(isSelectable);
  return first === -1 ? 0 : first;
}

/**
 * Replace a project with the same root, or append. `scanStream` yields each project once,
 * but a re-scan or a future incremental sizing pass would yield it again, and appending a
 * duplicate would double-count its bytes in every total on screen.
 */
export function upsertProject(projects: readonly Project[], project: Project): Project[] {
  const next = [...projects];
  const at = next.findIndex((candidate) => candidate.root === project.root);
  if (at === -1) next.push(project);
  else next[at] = project;
  return next;
}

export function upsertCache(caches: readonly CacheEntry[], cache: CacheEntry): CacheEntry[] {
  const next = [...caches];
  const at = next.findIndex((candidate) => candidate.id === cache.id);
  if (at === -1) next.push(cache);
  else next[at] = cache;
  return next;
}

/**
 * The selection, as work for `clean.ts`. One target per artifact — not per project — so
 * each delete is guarded, ordered and reported individually, and a project whose
 * `node_modules` is refused still gets its `dist` trashed.
 */
export function toTargets(input: TargetsInput): CleanTarget[] {
  const { rows, selection, categories } = input;
  const targets: CleanTarget[] = [];

  for (const row of selectedRows(rows, selection)) {
    if (row.kind === 'project') {
      for (const artifact of enabledArtifacts(row.project, categories)) {
        targets.push({ kind: 'project', project: row.project, artifact });
      }
    } else if (row.kind === 'cache') {
      targets.push({ kind: 'cache', cache: row.cache });
    }
  }
  return targets;
}

/* ------------------------------------------------------------------------------------- *
 * A session: many rounds, not one shot.
 * ------------------------------------------------------------------------------------- */

/**
 * Everything a run accumulates across rounds.
 *
 * The one-shot flow — scan, select, clean, print, exit — meant the interface could keep its
 * list in a component and throw it away on the way out. A session cannot: after a clean the
 * user is still here, looking at the same list, and that list must no longer offer what was
 * just trashed. So "what has been found" and "what has been reclaimed" become state with a
 * lifetime longer than one screen, and the transition between rounds becomes a function.
 *
 * `reclaimedBytes` is a *trashed* total and nothing else — the same rule invariant 8 imposes
 * on the exit disclosure, for the same reason. A refused target is still on disk; counting it
 * here would let a session that reclaimed nothing report a triumphant figure, and the figure
 * would then contradict the disk gauge sitting next to it.
 */
export interface SessionState {
  projects: readonly Project[];
  caches: readonly CacheEntry[];
  /** Bytes moved to the Trash across every round so far. Trashed only; never refused. */
  reclaimedBytes: number;
  /** Completed rounds. `0` until the first clean actually reports something. */
  rounds: number;
}

export const EMPTY_SESSION: SessionState = {
  projects: [],
  caches: [],
  reclaimedBytes: 0,
  rounds: 0,
};

export interface RoundInput {
  session: SessionState;
  selection: Selection;
  outcomes: readonly CleanOutcome[];
}

export interface RoundResult {
  session: SessionState;
  /** The selection with everything this round touched unchecked. */
  selection: Selection;
  /** Bytes trashed in **this** round, for the "cleaned 12.4G" line the round itself shows. */
  reclaimedBytes: number;
  trashed: number;
  refused: number;
  failed: number;
}

/** A byte count from an outcome, defensively. A NaN here would poison every later total. */
function bytesOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Identity of a trashed artifact: the project it belongs to, and its absolute path. */
function artifactKey(root: string, path: string): string {
  return `${root}\0${path}`;
}

/**
 * The next session, given what a clean actually did.
 *
 * Pure, and total: the shell hands over the previous state and the outcomes and takes back
 * the whole next state, so "the list updates after a clean" is a property proved here rather
 * than a sequence of `setState` calls that happen to be in the right order.
 *
 * Four rules, each of which is a way the obvious implementation lies:
 *
 * 1. **Only `trashed` removes a row.** A refused or failed target is still on the disk. Its
 *    row stays, its bytes stay in every total, and the disk gauge keeps counting it — which
 *    is the only version of events a `df` afterwards will agree with.
 * 2. **A project loses the artifacts that went, not the project.** `bump/dist` being trashed
 *    while `bump/node_modules` was refused leaves `bump` in the list at its remaining size.
 *    A project with nothing left drops out entirely, header total and all.
 * 3. **Everything the round touched is unchecked**, refusals included. Leaving a refused row
 *    checked would re-promise it on the next round and refuse it again — the promise-then-
 *    refuse loop `defaultSelection`'s block screening exists to break.
 * 4. **An empty outcome list is not a round.** Nothing happened, so nothing is counted; a
 *    clean that was cancelled or that had every target screened out must not inflate the
 *    round counter the user reads as "how many times have I done this".
 */
export function applyRound(input: RoundInput): RoundResult {
  const { session, selection, outcomes } = input;

  const goneArtifacts = new Set<string>();
  const goneCaches = new Set<string>();
  let reclaimedBytes = 0;
  let trashed = 0;
  let refused = 0;
  let failed = 0;

  for (const outcome of outcomes) {
    if (outcome.outcome === 'refused') refused += 1;
    else if (outcome.outcome === 'failed') failed += 1;
    else if (outcome.outcome === 'trashed') {
      trashed += 1;
      reclaimedBytes += bytesOf(outcome.bytes);
      if (outcome.target.kind === 'project') {
        goneArtifacts.add(artifactKey(outcome.target.project.root, outcome.target.artifact.path));
      } else {
        goneCaches.add(outcome.target.cache.id);
      }
    }
  }

  const projects: Project[] = [];
  for (const project of session.projects) {
    const artifacts = project.artifacts.filter(
      (artifact) => !goneArtifacts.has(artifactKey(project.root, artifact.path)),
    );
    if (artifacts.length === 0) continue;
    projects.push(
      artifacts.length === project.artifacts.length
        ? project
        : {
            ...project,
            artifacts,
            bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
          },
    );
  }

  const nextProjects = new Set(selection.projects);
  const nextCaches = new Set(selection.caches);
  for (const outcome of outcomes) {
    if (outcome.target.kind === 'project') nextProjects.delete(outcome.target.project.root);
    else nextCaches.delete(outcome.target.cache.id);
  }

  return {
    session: {
      projects,
      caches: session.caches.filter((cache) => !goneCaches.has(cache.id)),
      reclaimedBytes: session.reclaimedBytes + reclaimedBytes,
      rounds: session.rounds + (outcomes.length > 0 ? 1 : 0),
    },
    selection: { projects: nextProjects, caches: nextCaches },
    reclaimedBytes,
    trashed,
    refused,
    failed,
  };
}

/**
 * What the session has done so far, or `undefined` before it has done anything.
 *
 * `undefined` rather than "0B reclaimed": on the first pass there is no session to summarise,
 * and a running total that starts at zero reads as a failure report rather than as an empty
 * ledger. The wording says "trashed", not "freed", for the reason `diskbar.ts` states at
 * length — the bytes are still on the volume until the Trash is emptied.
 */
export function sessionSummary(session: SessionState): string | undefined {
  if (session.rounds === 0) return undefined;
  const rounds = session.rounds === 1 ? '1 round' : `${session.rounds} rounds`;
  return `${formatBytes(session.reclaimedBytes)} trashed this session · ${rounds}`;
}
