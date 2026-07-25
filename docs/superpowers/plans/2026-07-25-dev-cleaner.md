# dev-cleaner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `dev-cleaner`, an interactive TUI that finds regenerable build artifacts
across a projects directory and moves them to the Trash, protecting projects that are
still under active development.

**Architecture:** A pipeline of small, independently testable modules — walk the
filesystem to find project roots, classify each by ecosystem, locate its artifact
directories, size them, score how dormant it is, then render an Ink TUI for selection and
execute an allowlisted deletion. Every module has one responsibility and a fixed
signature; `src/types.ts` is the single vocabulary and no module redeclares a type it owns.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥20, Ink 5 + React 18 for the
TUI, `trash` for deletion, Vitest with real temp-directory fixtures.

**Spec:** `docs/superpowers/specs/2026-07-25-dev-cleaner-design.md` — read it first. It is
the source of truth for behaviour; this plan is the source of truth for names and order.

## Global Constraints

- Node `>=20`. ESM only (`"type": "module"`). TypeScript `strict` with
  `noUncheckedIndexedAccess`, module/moduleResolution `NodeNext`.
- Package name `dev-cleaner`, binary `dev-cleaner`, entry `dist/cli.js`.
- Runtime deps: `ink@^5`, `react@^18`, `trash@^9`. Nothing else.
- **All** test files live in `tests/` and are named `*.test.ts` or `*.test.tsx`. The
  vitest `include` glob is `['tests/**/*.test.{ts,tsx}']`. No test lives in `src/`.
- **`src/types.ts` owns every shared type.** A module may define types used only inside
  itself; it may never redeclare one from `types.ts`.
- Every module is created by exactly **one** task. No task writes a file another task
  created.
- Filesystem tests use the single `fixture()` helper from `tests/fixture.ts`. No mocks for
  filesystem behaviour.
- Safety invariants are numbered 1–8 in the spec. Where a step enforces one, cite it by
  number in the commit message.

---

## Module Ownership

Fixed at plan time so no two tasks collide. `Task` is the sole creator of each file.

| Module | Task | Responsibility |
| --- | --- | --- |
| `src/types.ts` | 1 | Every shared type. Owned solely by Task 1. |
| `tests/fixture.ts` | 1 | The one fixture helper. |
| `src/detect.ts` | 2 | Marker files → `Set<ProjectType>` |
| `src/artifacts.ts` | 3 | Type table, pattern matching, dedup |
| `src/discover.ts` | 4 | The walk: roots, roll-up, worktrees, pruning |
| `src/size.ts` | 5 | Directory sizing |
| `src/git.ts` | 6 | Git metadata, hardened subprocess |
| `src/activity.ts` | 7 | Signals → `ActivityScore` |
| `src/caches.ts` | 8 | Global cache table |
| `src/clean.ts` | 9 | Allowlisted, ordered deletion |
| `src/scan.ts` | 10 | Composes discover+size+git+activity into a stream |
| `src/ui/*.tsx` | 11 | Ink components |
| `src/report.ts`, `src/cli.ts` | 12 | Static report, arg parsing, entry point |

## Frozen Signatures

Every cross-module signature, fixed here. Implementers copy these verbatim; a task that
needs a change must say so rather than diverge.

```ts
// src/types.ts — the whole shared vocabulary
export type ProjectType =
  | 'node' | 'rust' | 'flutter' | 'xcode'
  | 'gradle' | 'python' | 'ruby' | 'go' | 'dotnet' | 'cmake';
export type Category = 'build' | 'deps' | 'cache';
export type Preset = 'recommended' | 'aggressive' | 'custom';

export interface Artifact {
  path: string; relPath: string; category: Category; bytes: number;
}
export interface GitInfo {
  branch: string; lastCommitMs: number; hasUncommittedChanges: boolean;
  isWorktree: boolean;
  worktree?: { mainRepo: string; isMerged: boolean; isClean: boolean };
}
export interface ActivityScore {
  status: 'active' | 'dormant'; idleMs: number; reason: string;
}
export interface Project {
  root: string; name: string; types: Set<ProjectType>;
  artifacts: Artifact[]; bytes: number;
  git?: GitInfo; activity: ActivityScore;
}
/** What discover() yields: no sizes, no git, no activity yet. */
export type DiscoveredProject =
  Omit<Project, 'bytes' | 'git' | 'activity'> & { isWorktree: boolean };

export interface CacheEntry {
  id: string; label: string; path: string; bytes: number; note: string;
}
export type CleanTarget =
  | { kind: 'project'; project: Project; artifact: Artifact }
  | { kind: 'cache'; cache: CacheEntry };
export type Refusal =
  | 'not-in-artifact-table' | 'outside-project-root' | 'symlink'
  | 'guarded-path' | 'worktree-root' | 'unknown-cache' | 'store-prune-unsafe';
export interface CleanOutcome {
  target: CleanTarget; label: string; bytes: number;
  outcome: 'trashed' | 'refused' | 'failed';
  refusal?: Refusal; detail?: string;
}
export type TrashFn = (paths: readonly string[]) => Promise<void>;
export type SafetyReason =
  'root-is-filesystem-root' | 'root-is-home' | 'root-too-shallow';
export class SafetyError extends Error {
  constructor(readonly reason: SafetyReason, message: string);
}

// src/detect.ts
export function detectTypesFromNames(entryNames: readonly string[]): Set<ProjectType>;
export function detectTypes(dir: string): Promise<Set<ProjectType>>;

// src/artifacts.ts
export interface Pattern { value: string; kind: 'basename'|'relative'|'glob'; category: Category }
export const ARTIFACT_TABLE: Record<ProjectType, Record<Category, string[]>>;
export function categoriesForPreset(preset: Preset): Set<Category>;
export function isArtifactBasename(name: string): boolean;
export function matchesGlob(pattern: string, value: string): boolean;
export function artifactPatternsFor(
  types: Set<ProjectType>, categories: Set<Category>): Pattern[];
/** The ONE function that turns a directory into delete candidates. */
export function resolveArtifacts(
  root: string, declarations: ReadonlyMap<string, Set<ProjectType>>,
  categories: Set<Category>): Promise<Artifact[]>;

// src/discover.ts
export function resolveScanRoot(root: string): Promise<string>;   // realpath + invariant 3
export function isLinkedWorktree(dir: string): Promise<boolean>;  // .git is a FILE
export function discover(
  roots: readonly string[], categories: Set<Category>
): AsyncGenerator<DiscoveredProject>;

// src/size.ts
export interface SizeOptions { concurrency?: number }
export function defaultConcurrency(): number;                     // clamp(cores, 4, 16)
export function dirSize(target: string, options?: SizeOptions): Promise<number>;
export function newestMtimeMs(root: string, exclude: readonly string[]): Promise<number>;

// src/git.ts
export function readGitInfo(dir: string): Promise<GitInfo | undefined>;

// src/activity.ts
export interface ActivitySignals {
  lastCommitMs?: number; hasUncommittedChanges: boolean;
  newestSourceMs: number; newestArtifactMs: number; lockfileMs?: number;
}
export function gatherSignals(
  root: string, artifacts: readonly Artifact[], git: GitInfo | undefined
): Promise<ActivitySignals>;
/** Body authored by the repo owner. The ONE intentional TODO in this plan. */
export function scoreActivity(signals: ActivitySignals, nowMs: number): ActivityScore;

// src/caches.ts
export interface CacheEnv {
  platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv;
}
export function currentCacheEnv(): CacheEnv;
export function listCaches(env: CacheEnv): Promise<CacheEntry[]>;

// src/clean.ts
export interface CleanOptions {
  trash: TrashFn; roots: readonly string[]; allowedCachePaths: readonly string[];
}
export const systemTrash: TrashFn;                       // wraps the `trash` package
export function targetLabel(target: CleanTarget): string;
export function orderTargets(targets: readonly CleanTarget[]): CleanTarget[];
export function clean(
  targets: readonly CleanTarget[], options: CleanOptions): Promise<CleanOutcome[]>;

// src/scan.ts
export interface ScanOptions {
  roots: readonly string[]; categories: Set<Category>;
  includeCaches: boolean; nowMs: number; concurrency?: number;
}
export type ScanEvent =
  | { kind: 'project'; project: Project }
  | { kind: 'cache'; cache: CacheEntry }
  | { kind: 'done' };
export interface ScanResult { projects: Project[]; caches: CacheEntry[] }
export function scanStream(options: ScanOptions): AsyncGenerator<ScanEvent>;
export function scanAll(options: ScanOptions): Promise<ScanResult>;
```

`scanStream` is what attaches `bytes`, `git`, and `activity` to a `DiscoveredProject`,
producing a full `Project`. No consumer ever sees a project without those fields.

---

## Task 1: Scaffold, shared types, fixture helper

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`
- Create: `src/types.ts`, `tests/fixture.ts`
- Test: `tests/fixture.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in "Frozen Signatures" above under `src/types.ts`, plus
  `fixture(spec: FixtureSpec): Promise<Fixture>` where
  `Fixture = { root: string; path(...segments: string[]): string; cleanup(): Promise<void> }`
  and `FixtureSpec = Record<string, string | FixtureEntry>`. A bare string creates a file
  with that content. Entry builders: `dir()`, `file(content, {size, mtime})`,
  `symlink(target)`, `worktree(gitdir)`.

- [ ] **Step 1:** Write the four config files and `.gitignore` per Global Constraints.
      `vitest.config.ts` must use `include: ['tests/**/*.test.{ts,tsx}']`. Run
      `npm install`.
- [ ] **Step 2:** Write `tests/fixture.test.ts` asserting `fixture()` creates each entry
      kind *on disk*: a file with exact content; a file of an exact byte size; an empty
      directory; a symlink to `os.homedir()` that `lstat` reports as a symlink; a worktree
      whose `.git` is a **file** containing `gitdir: …`. Assert `fixture.root` is its own
      `realpath` (no `/var` → `/private/var` aliasing). Assert an unrecognised entry kind
      **throws** — a helper that silently creates nothing makes symlink tests pass
      vacuously.
- [ ] **Step 3:** Run `npx vitest run tests/fixture.test.ts`. Expected: FAIL, cannot
      resolve `./fixture.js`.
- [ ] **Step 4:** Write `src/types.ts` (frozen signatures, verbatim) and
      `tests/fixture.ts`.
- [ ] **Step 5:** Run the test. Expected: PASS. Run `npx tsc -p tsconfig.test.json`.
- [ ] **Step 6:** Commit — `feat: scaffold, shared types, and test fixture helper`.

## Task 2: `src/detect.ts`

**Files:** Create `src/detect.ts`; Test `tests/detect.test.ts`

**Interfaces:**
- Consumes: `ProjectType` from `src/types.js`; `fixture` from `tests/fixture.js`.
- Produces: `detectTypesFromNames`, `detectTypes` (frozen signatures).

Two functions, deliberately: the walk in Task 4 has already read the directory entries, so
it calls the pure synchronous form; `detectTypes` is a thin `readdir` wrapper for
convenience and tests. The async wrapper fails **closed** — an unreadable directory
yields an empty set, never a throw that aborts a scan.

- [ ] **Step 1:** Write `tests/detect.test.ts`: a single-type dir (`Cargo.toml` → `rust`);
      a **polyglot** dir declaring `pubspec.yaml` + `build.gradle` + `Runner.xcodeproj` +
      `Gemfile` → all four types; an empty dir → empty set; glob markers `*.xcodeproj` and
      `*.csproj`; `detectTypes` on a nonexistent dir → empty set, no throw.
- [ ] **Step 2:** Run it. Expected: FAIL, cannot resolve `../src/detect.js`.
- [ ] **Step 3:** Implement both functions with the full marker table from the spec.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit — `feat(detect): classify project types from marker files`.

## Task 3: `src/artifacts.ts`

**Files:** Create `src/artifacts.ts`; Test `tests/artifacts.test.ts`

**Interfaces:**
- Consumes: `ProjectType`, `Category`, `Artifact`, `Preset` from `src/types.js`.
- Produces: the eight exports listed under `src/artifacts.ts` in Frozen Signatures.

`resolveArtifacts` is **the one function that turns a directory into delete candidates**
(spec: "exactly one code path"). Task 4 delegates to it rather than re-walking.

- [ ] **Step 1:** Write `tests/artifacts.test.ts` covering: the three pattern kinds (bare
      basename at any depth; a path containing `/` relative to the declaring directory;
      a glob); **the dedup rule** — a directory claimed by two types with different
      categories resolves to ONE artifact with the more conservative category
      (`deps` > `build` > `cache`); `categoriesForPreset` for all three presets;
      `resolveArtifacts` never returns a symlink (invariant 2) and never descends `.git`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement, transcribing the full 10-type × 3-category table from the
      spec's matrix verbatim.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit — `feat(artifacts): artifact table with conservative dedup`.

## Task 4: `src/discover.ts` — the walk

**Files:** Create `src/discover.ts`; Test `tests/discover.test.ts`,
`tests/discover.safety.test.ts`

**Interfaces:**
- Consumes: `detectTypesFromNames` (Task 2); `resolveArtifacts`, `isArtifactBasename`
  (Task 3); `DiscoveredProject`, `SafetyError` from `src/types.js`; `fixture`.
- Produces: `resolveScanRoot`, `isLinkedWorktree`, `discover` (frozen signatures).

The hardest task. Implements roll-up, subtree-wide type collection, the worktree
exception, pruning, symlink skipping, and root guards.

**Invariant 6 is the trap:** `isLinkedWorktree(child)` MUST be tested **before**
`isArtifactBasename(name)`. Reversed, a worktree created by `git worktree add build
feature` is captured as an artifact and deleted — real source and uncommitted work.

- [ ] **Step 1:** Write `tests/discover.test.ts`: a container dir is not a root but its
      children are; a repo with nested markers rolls up to ONE project; types are
      collected across the whole subtree (a Rust root containing a nested `.xcodeproj`
      yields both); `node_modules` is never descended into.
- [ ] **Step 2:** Write `tests/discover.safety.test.ts` — the adversarial set:
      - a nested linked worktree emerges as its **own** root, not absorbed into the parent
      - its artifacts are attributed to **it**, not the parent
      - an **active** parent containing a **dormant** worktree still yields the worktree
      - **worktrees named `build`, `target`, and `dist`** are treated as roots, never as
        artifacts (invariant 6). A fixture named `namespace-foundation` passes while the
        invariant is broken — these three names are what actually test it.
      - a symlink is never followed
      - `resolveScanRoot` rejects `/`, `os.homedir()`, and **a symlink pointing at `/`**
        (invariant 3 — `path.resolve` alone passes this; `realpath` catches it)
- [ ] **Step 3:** Run both. Expected: FAIL.
- [ ] **Step 4:** Implement. `resolveScanRoot` applies all guards to `realpath(root)` and
      returns the resolved path.
- [ ] **Step 5:** Run both. Expected: PASS.
- [ ] **Step 6:** Commit — `feat(discover): walk with roll-up and worktree roots (inv 3, 6)`.

## Task 5: `src/size.ts`

**Files:** Create `src/size.ts`; Test `tests/size.test.ts`

**Interfaces:**
- Consumes: nothing beyond node builtins.
- Produces: `defaultConcurrency`, `dirSize`, `newestMtimeMs`.

`du -sk` fast path where available, concurrent Node walker fallback. Neither follows
symlinks. `newestMtimeMs` walks source files with the given paths excluded — that is how
Task 7 gets `newestSourceMs` without re-walking artifacts.

- [ ] **Step 1:** Write `tests/size.test.ts`: a fixture of known byte size; assert the
      `du` path and the walker fallback **agree**; assert neither follows a symlink to a
      large tree; `defaultConcurrency()` is within `[4, 16]`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit — `feat(size): directory sizing with du fast path`.

## Task 6: `src/git.ts`

**Files:** Create `src/git.ts`; Test `tests/git.test.ts`

**Interfaces:**
- Consumes: `GitInfo` from `src/types.js`; `fixture`.
- Produces: `readGitInfo`.

**Invariant 7 is the trap.** `readGitInfo` runs `git` with `cwd` set to directories the
walk found, which may be repositories the user merely downloaded. Every invocation is
prefixed `-c core.fsmonitor= -c core.hooksPath=/dev/null -c protocol.ext.allow=never` and
run with `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`. Without
this, `git status` executes attacker-controlled commands during a read-only survey.

- [ ] **Step 1:** Write `tests/git.test.ts` using real repos (`git init`, commit): branch
      and last-commit are read; a dirty tree sets `hasUncommittedChanges`; a real
      `git worktree add` yields `isWorktree: true` with `mainRepo`/`isMerged`/`isClean`
      populated; a non-repo yields `undefined`. **The invariant-7 test:** a fixture repo
      whose `.git/config` sets `core.fsmonitor` to a sentinel-writing script — assert no
      sentinel file appears after `readGitInfo`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with the hardened prefix and env on every invocation.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit — `feat(git): hardened git metadata reader (inv 7)`.

## Task 7: `src/activity.ts`

**Files:** Create `src/activity.ts`; Test `tests/activity.test.ts`

**Interfaces:**
- Consumes: `Artifact`, `GitInfo`, `ActivityScore` from `src/types.js`; `newestMtimeMs`
  (Task 5).
- Produces: `ActivitySignals`, `gatherSignals`, `scoreActivity`.

`gatherSignals` is fully implemented. **`scoreActivity`'s body is the one intentional TODO
in this plan** — the spec assigns it to the repository owner, because what counts as
"active" is a judgement, not a derivation. It ships as a documented, fail-closed stub
returning `status: 'active'` (protecting everything) until authored.

- [ ] **Step 1:** Write `tests/activity.test.ts` for `gatherSignals` — the three cases the
      spec names: uncommitted-but-stale; recently-built-never-committed; no-git-at-all.
      Assert on the **signals**, not on a score, so these tests pass before the body is
      authored.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `gatherSignals`. Write `scoreActivity` as a stub with a
      prominent `// TODO(owner):` block documenting: the six signals available, the
      required return shape, and that it currently returns `'active'` for everything so
      the tool protects rather than deletes while unauthored.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit — `feat(activity): signal gathering; scoring left to owner`.

## Task 8: `src/caches.ts`

**Files:** Create `src/caches.ts`; Test `tests/caches.test.ts`

**Interfaces:**
- Consumes: `CacheEntry` from `src/types.js`; `dirSize` (Task 5).
- Produces: `CacheEnv`, `currentCacheEnv`, `listCaches`.

Table keyed on `process.platform`, honouring `XDG_CACHE_HOME`, `LOCALAPPDATA`,
`CARGO_HOME`. Caches absent on the machine are **omitted**, not listed as zero. Only
`CoreSimulator/Caches`, never `CoreSimulator` itself — that holds downloaded runtimes.

- [ ] **Step 1:** Write `tests/caches.test.ts`: darwin/linux/win32 resolution with a
      synthetic `CacheEnv`; env overrides respected; a nonexistent cache is omitted;
      assert no entry's path is `CoreSimulator` itself.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit — `feat(caches): per-platform global cache table`.

## Task 9: `src/clean.ts` — deletion

**Files:** Create `src/clean.ts`; Test `tests/clean.test.ts`, `tests/clean.safety.test.ts`

**Interfaces:**
- Consumes: `CleanTarget`, `CleanOutcome`, `TrashFn`, `Refusal` from `src/types.js`;
  `isArtifactBasename`/`ARTIFACT_TABLE` (Task 3).
- Produces: `CleanOptions`, `systemTrash`, `targetLabel`, `orderTargets`, `clean`.

The safety-critical module. `clean` takes the discriminated `CleanTarget` union — carrying
the **project and artifact**, not a flattened path — because the containment and allowlist
checks are derived from them. A flattened shape makes the entire guard layer unreachable
from the only path a user can invoke, while unit tests stay green.

- [ ] **Step 1:** Write `tests/clean.test.ts`: `targetLabel` for both variants;
      `orderTargets` puts every project `node_modules` before any cache store prune;
      a successful run returns `trashed` outcomes and calls the injected `TrashFn`.
- [ ] **Step 2:** Write `tests/clean.safety.test.ts` — every case asserted explicitly:
      - a symlink pointing at `$HOME` → refused `symlink` (invariant 2)
      - a cache whose **parent component** is a symlink → refused (terminal `lstat` alone
        passes this; the whole ancestor chain must be checked)
      - a `node_modules` **outside** any project root → refused `outside-project-root`
      - a project root equal to `$HOME` → refused `guarded-path` (invariant 3)
      - a target whose `.git` is a **file** → refused `worktree-root` (invariant 6, the
        second independent enforcement)
      - **invariant 5:** a rank-0 `node_modules` target that **fails**, with a pnpm store
        target also selected → the store prune is **refused** `store-prune-unsafe`, not
        merely ordered after. Ordering is a dependency, not a sequence.
- [ ] **Step 3:** Run both. Expected: FAIL.
- [ ] **Step 4:** Implement. `systemTrash` wraps the `trash` package — the production
      `TrashFn`, so the shipped path and the tested path differ only in that function.
- [ ] **Step 5:** Run both. Expected: PASS.
- [ ] **Step 6:** Commit — `feat(clean): allowlisted ordered deletion (inv 1,2,3,5,6)`.

## Task 10: `src/scan.ts` — pipeline

**Files:** Create `src/scan.ts`; Test `tests/scan.test.ts`

**Interfaces:**
- Consumes: `discover` (4), `dirSize`/`newestMtimeMs` (5), `readGitInfo` (6),
  `gatherSignals`/`scoreActivity` (7), `listCaches` (8).
- Produces: `ScanOptions`, `ScanEvent`, `ScanResult`, `scanStream`, `scanAll`.

Attaches `bytes`, `git`, and `activity` to each `DiscoveredProject`, yielding a complete
`Project`. This is the only place enrichment happens, so no consumer can receive a project
missing `activity`.

- [ ] **Step 1:** Write `tests/scan.test.ts`: every yielded project has `bytes`, `git`
      (when a repo) and `activity` populated; caches are yielded when `includeCaches`;
      a `done` event terminates the stream; `scanAll` collects the same data.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit — `feat(scan): compose discovery, sizing, git and activity`.

## Task 11: `src/ui/*` — the TUI

**Files:** Create `src/ui/format.ts`, `src/ui/model.ts`, `src/ui/List.tsx`,
`src/ui/Detail.tsx`, `src/ui/Footer.tsx`, `src/ui/Confirm.tsx`, `src/ui/App.tsx`;
Test `tests/ui.model.test.ts`, `tests/ui.app.test.tsx`

**Interfaces:**
- Consumes: `Project`, `CacheEntry`, `Preset`, `CleanTarget`, `TrashFn` from
  `src/types.js`; `ScanEvent` (Task 10); `clean` (Task 9).
- Produces: `formatBytes`, `formatIdle`; `Row`, `Selection`, `buildRows`,
  `defaultSelection`, `toTargets`; the components; `App`.

Two panes per the spec mock. `model.ts` is pure and carries the logic — selection,
row building, target construction — so the bulk of the behaviour is testable without
rendering. `toTargets` builds the **discriminated union**, never a flattened shape.

- [ ] **Step 1:** Write `tests/ui.model.test.ts`: dormant projects selected by default,
      active ones not but still selectable; preset cycling changes categories;
      `buildRows` orders sections PROJECTS → ACTIVE → CACHES with sizes descending;
      `toTargets` emits `{kind:'project', project, artifact}`, never `{path, bytes}`.
- [ ] **Step 2:** Run. Expected: FAIL. Implement `format.ts` + `model.ts`. Run: PASS.
- [ ] **Step 3:** Write `tests/ui.app.test.tsx` with `ink-testing-library`: renders as
      soon as the first project arrives from a **slow** async generator, before `done`;
      rows re-sort as sizes fill in; `space` toggles; `q` exits without cleaning.
- [ ] **Step 4:** Run. Expected: FAIL. Implement the components. Run: PASS.
- [ ] **Step 5:** Commit — `feat(ui): two-pane Ink interface with progressive rendering`.

## Task 12: `src/report.ts` and `src/cli.ts`

**Files:** Create `src/report.ts`, `src/cli.ts`; Test `tests/report.test.ts`,
`tests/cli.test.ts`

**Interfaces:**
- Consumes: `scanAll`/`ScanResult` (10); `buildRows`/`defaultSelection` (11);
  `SafetyError` from `src/types.js`.
- Produces: `renderReport`, `renderCleanSummary`; `HELP_TEXT`, `parseArgs`, `main`.

`main` returns an exit code and never calls `process.exit`, so `tests/cli.test.ts` can
import and drive it. When `process.stdout.isTTY !== true` it prints the static report and
returns without prompting or cleaning — the spec's degradation rule.

- [ ] **Step 1:** Write `tests/report.test.ts`: report layout for projects, active section,
      caches; `renderCleanSummary` states the trashed total **and** that Trash must be
      emptied to reclaim it (invariant 8).
- [ ] **Step 2:** Write `tests/cli.test.ts`: `parseArgs` for every flag and its default;
      an unknown flag throws; `main` with a non-TTY stdout prints a report and returns 0
      **without** cleaning; a `SafetyError` returns exit code 3.
- [ ] **Step 3:** Run both. Expected: FAIL.
- [ ] **Step 4:** Implement both modules.
- [ ] **Step 5:** Run the **full** suite: `npm test` and `npx tsc -p tsconfig.test.json`.
      Expected: all PASS.
- [ ] **Step 6:** Commit — `feat(cli): entry point, arg parsing, static report (inv 8)`.

## Task 13: End-to-end verification against the real tree

**Files:** Test `tests/e2e.test.ts`

Unit tests prove modules; this proves the assembled tool. Runs against fixtures shaped
like the real `~/develop`, and once — read-only — against `~/develop` itself.

- [ ] **Step 1:** Write `tests/e2e.test.ts`: build a fixture mirroring the real tree
      (a container dir with nested projects, a Rust monorepo with a nested worktree named
      `build`, a polyglot Flutter project) and assert `scanAll` finds the right roots,
      attributes the worktree's artifacts to the worktree, and that `clean` with a
      recording `TrashFn` targets **only** artifact directories — never a source file,
      never a project root, never a worktree root.
- [ ] **Step 2:** Run. Expected: FAIL until assembled; then PASS.
- [ ] **Step 3:** Run `npm run build`, then `node dist/cli.js ~/develop` with stdout piped
      (non-TTY). Confirm the static report lists the expected projects and **deletes
      nothing**. Record the reported reclaimable total.
- [ ] **Step 4:** Commit — `test: end-to-end verification against a realistic tree`.

---

## Verification Gate

Before the tool is ever run interactively against real data, all of the following must
hold:

- `npm test` passes with every file under `tests/` executing — confirm the count, since a
  mismatched `include` glob silently runs a subset and still reports green.
- `npx tsc -p tsconfig.test.json` reports no errors.
- Every safety invariant 1–8 has a test that constructs the **dangerous** case, not merely
  the safe one.
- Task 13 Step 3 produced a report against the real tree while deleting nothing.

## Deferred

- `scoreActivity`'s body — authored by the repository owner (Task 7).
- Publishing to npm — requires `npm login`; the account is not currently authenticated.
- `--yes` / `--json` non-interactive modes — explicitly out of scope per the spec.
