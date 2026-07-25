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

import type { CacheEntry, Category, CleanTarget, Preset, Project } from '../types.js';

/** Rows are grouped into three sections, always rendered in this order. */
export type Section = 'projects' | 'active' | 'caches';

export const SECTION_ORDER: readonly Section[] = ['projects', 'active', 'caches'];

export const SECTION_LABELS: Record<Section, string> = {
  projects: 'PROJECTS',
  active: 'ACTIVE (protected)',
  caches: 'CACHES',
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
 * The whole list, in render order: PROJECTS (dormant), ACTIVE (protected), CACHES — each
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
 * Dormant projects and caches start selected; active projects do not. Both halves matter:
 * the tool is useless if nothing is preselected, and dangerous if work in progress is.
 */
export function defaultSelection(rows: readonly Row[]): Selection {
  const projects = new Set<string>();
  const caches = new Set<string>();

  for (const row of rows) {
    if (row.kind === 'project' && row.section === 'projects') projects.add(row.project.root);
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
