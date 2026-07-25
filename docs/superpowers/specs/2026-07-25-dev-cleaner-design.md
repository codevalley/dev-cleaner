# dev-cleaner — Design

**Date:** 2026-07-25
**Status:** Approved for planning

## Problem

A developer's projects directory accumulates regenerable build artifacts that consume
substantial disk space. On the reference machine, `~/develop` holds 133 GB, of which
roughly 100 GB is regenerable output: Rust `target/` directories, `node_modules`,
`.next`, `.dart_tool`, and similar. A further ~32 GB sits in global tool caches outside
the projects directory.

Deleting these by hand is tedious and risky. The artifact directory names differ per
ecosystem, projects nest at inconsistent depths, and a single mobile project scatters
artifacts across five platform subdirectories. Crucially, some projects are under active
development and must not be touched.

## Goals

1. Discover projects under one or more roots, at any nesting depth.
2. Classify each project by ecosystem and locate its artifact directories.
3. Score how dormant each project is, so active work is protected by default.
4. Present an interactive TUI for reviewing and adjusting the selection.
5. Move selected artifacts to the system Trash, safely and in the correct order.
6. Ship as a cross-platform npm package (`dev-cleaner`).

## Non-Goals

- Restoring or rebuilding projects after cleaning.
- Continuous background monitoring or scheduling.
- Non-interactive/CI mode (`--yes`, `--json`). Deferred; add if demand appears.
- Reporting non-artifact space hogs. Out of scope for v1.

---

## Architecture

Eight modules, each independently testable, with a one-directional dependency flow.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `src/detect.ts` | Marker files in a directory → set of project types | — |
| `src/artifacts.ts` | Project types + enabled categories → artifact paths | — |
| `src/discover.ts` | Walk roots → project roots with artifact paths | `detect`, `artifacts` |
| `src/size.ts` | Concurrent directory sizing | — |
| `src/git.ts` | Git metadata for a directory | — |
| `src/activity.ts` | Signals → dormancy score | `git` |
| `src/caches.ts` | Per-platform global cache table | — |
| `src/clean.ts` | Ordered, allowlisted trash execution | — |
| `src/ui/*` | Ink components | all of the above |
| `src/cli.ts` | Entry point, argument parsing | all of the above |

**Data flow:**

```
roots
  → discover  (walk, prune, roll up)
  → detect    (types per root)
  → artifacts (deletable paths per root)
  → size + activity  (parallel enrichment)
  → Project[]
  → ui        (render, select)
  → clean     (trash, ordered)
```

### Core types

```ts
type ProjectType =
  | 'node' | 'rust' | 'flutter' | 'xcode'
  | 'gradle' | 'python' | 'ruby' | 'go' | 'dotnet' | 'cmake';

type Category = 'build' | 'deps' | 'cache';

interface Artifact {
  path: string;          // absolute
  relPath: string;       // relative to project root, for display
  category: Category;
  bytes: number;
}

interface Project {
  root: string;          // absolute
  name: string;          // path relative to scan root, e.g. "v2/gitayuga"
  types: Set<ProjectType>;
  artifacts: Artifact[];
  bytes: number;         // sum of artifact bytes
  git?: GitInfo;
  activity: ActivityScore;
}
```

---

## Discovery and the roll-up rule

A top-down walk from each scan root.

A directory is a **project root** when it contains `.git` or any type marker. Once a
directory is identified as a project root, **no descendant is treated as a separate
project root**. The walk still descends into it to locate nested artifact directories,
but those are attributed to the outer root.

This is the roll-up behaviour: the `flutter/` SDK clone (which contains 200+ nested
`pubspec.yaml` files) collapses to one entry, and `tinysync` owns the artifacts of all
twelve of its crates plus its Xcode sub-app.

Directories with no marker are containers and the walk continues through them. This is
how `v2/` and `2026/` are handled: they are not projects, but their children are.

### Pruning

The walk never descends into a directory whose basename appears in the artifact table,
nor into `.git`. Without pruning, a scan visits several hundred thousand files; with it,
a few thousand directories. This is the difference between a multi-minute scan and a
sub-second one.

### Skipped directories

Never descended into, never treated as artifacts:

- `.git`
- `.worktrees`, and any directory containing a `.git` *file* (a linked worktree). Git
  worktrees are real checkouts holding real source and possibly uncommitted work.
- `.claude` — may contain worktrees and session state.
- Any symbolic link.

---

## Type and artifact matrix

`detect.ts` returns a **set** of types, not a single type. A Flutter project is
simultaneously `flutter`, `gradle`, `xcode`, and `ruby`; a single-type model would
under-clean every mobile project. `artifacts.ts` unions the path lists of all detected
types.

| Type | Markers | `build` | `deps` | `cache` |
| --- | --- | --- | --- | --- |
| node | `package.json` | `dist` `build` `.next` `out` `.output` `.svelte-kit` `storybook-static` | `node_modules` | `.turbo` `.cache` `.parcel-cache` `.eslintcache` `.vite` |
| rust | `Cargo.toml` | `target` | — | — |
| flutter | `pubspec.yaml` | `build` | `.dart_tool` `.packages` `ios/.symlinks` | — |
| xcode | `*.xcodeproj` `Package.swift` | `build` `DerivedData` `.build` | `Pods` | — |
| gradle | `build.gradle` `build.gradle.kts` `settings.gradle*` | `build` `app/build` | — | `.gradle` `.kotlin` |
| python | `pyproject.toml` `requirements.txt` | `dist` `build` `*.egg-info` | `.venv` `venv` | `__pycache__` `.pytest_cache` `.mypy_cache` `.ruff_cache` |
| ruby | `Gemfile` `*.gemspec` | — | `vendor/bundle` | `.bundle` |
| go | `go.mod` | `bin` | — | — |
| dotnet | `*.csproj` | `bin` `obj` | — | — |
| cmake | `CMakeLists.txt` | `build` `cmake-build-*` | — | — |

Entries containing a `/` (`app/build`, `ios/.symlinks`, `vendor/bundle`) match a relative
path from the directory that declared the type. All others match a basename at any depth
within the project. Entries containing `*` are glob patterns.

**Types are detected across the whole rolled-up subtree, not only at the project root.**
`tinysync` declares `rust` at its root, but `tinysync/apps/macos-file-provider` declares
`xcode`; both contribute artifact paths to the single `tinysync` entry. Detecting only at
the root would miss the artifacts of every nested sub-project — which is most of what a
monorepo contains.

Artifact paths are **deduplicated by absolute path** after the union. Several types claim
`build` and `dist`; a project detected as both `node` and `cmake` must yield one entry per
directory, not two. Where duplicates carry different categories, the more conservative
category wins (`deps` over `build` over `cache`), so a directory is only cleaned under the
preset that most explicitly opts into it.

### Presets

- **Recommended** — `build` + `cache`
- **Aggressive** — `build` + `deps` + `cache`
- **Custom** — per-category checkboxes

Preset selection recomputes which artifacts are selected; it does not re-walk the
filesystem.

---

## Activity scoring

`activity.ts` converts signals into a score that determines default selection.

**Signals gathered:**

| Signal | Source | Cost |
| --- | --- | --- |
| `lastCommitMs` | `git log -1 --format=%ct` | cheap |
| `hasUncommittedChanges` | `git status --porcelain` (limit 1) | cheap |
| `branch` | `git rev-parse --abbrev-ref HEAD` | cheap |
| `newestSourceMs` | max mtime of source files (artifacts pruned) | moderate |
| `newestArtifactMs` | max mtime of artifact directories (last build) | cheap |
| `lockfileMs` | mtime of lockfile, if present | cheap |

**Output:**

```ts
interface ActivityScore {
  status: 'active' | 'dormant';
  idleMs: number;      // for display, e.g. "8mo"
  reason: string;      // why, e.g. "committed 3d ago"
}
```

Projects scored `active` are rendered in a protected section and are **not selected by
default**. They remain manually selectable — protection is a default, not a lock.

The scoring body itself encodes a judgement about what "active" means and is authored by
the repository owner. Signal gathering, types, and tests are scaffolded around it. Cases
the scoring must resolve explicitly:

- A project with uncommitted changes but no recent commits.
- A project built recently but never committed (a dev server may touch files).
- A project with no git repository at all.

---

## Global caches

Presented in a separate TUI section, below projects, with independent selection.

| Cache | Path (macOS) | Risk note |
| --- | --- | --- |
| pnpm store | `~/Library/pnpm/store` | hardlink target for `node_modules` |
| npm cache | `~/.npm/_cacache` | safe |
| Gradle | `~/.gradle/caches` | re-downloaded on next build |
| Cargo registry | `~/.cargo/registry` | re-downloaded on next build |
| Xcode DerivedData | `~/Library/Developer/Xcode/DerivedData` | safe |
| CoreSimulator | `~/Library/Developer/CoreSimulator/Caches` | caches subdirectory only |
| pub cache | `~/.pub-cache` | re-downloaded on next build |
| Yarn | `~/Library/Caches/Yarn` | safe |
| CocoaPods | `~/Library/Caches/CocoaPods` | safe |

Paths resolve per platform via a table keyed on `process.platform`, honouring
`XDG_CACHE_HOME`, `LOCALAPPDATA`, and `CARGO_HOME` where applicable. Caches that do not
exist on the current machine are omitted from the list rather than shown as zero.

`~/Library/Developer/CoreSimulator` as a whole is **not** offered — it holds downloaded
runtimes and device state, not build output. Only its `Caches` subdirectory is listed.

---

## Safety model

The tool performs bulk deletion, so its safety properties are stated as invariants and
tested directly.

1. **Allowlist, never blocklist.** A path is deletable only if its basename or relative
   path appears in the artifact table *and* it lies within a detected project root (or is
   an entry in the global cache table). There is no code path that deletes "everything
   except" something. A bug therefore fails closed — something goes uncleaned — rather
   than open.

2. **No symlink traversal.** Symbolic links are never followed, when sizing or when
   deleting. A symlink encountered during the walk is skipped entirely.

3. **Root guards.** The scan refuses to run when a root resolves to `/`, the user's home
   directory, or any path at depth ≤ 1 from the filesystem root.

4. **Trash, not unlink.** Deletion goes through the `trash` package, which uses the
   platform's native recycle facility. On the same volume this is a rename, so it is
   fast regardless of file count.

5. **Ordering.** Project `node_modules` are trashed *before* any pnpm store prune, so
   store hardlinks are never orphaned while projects still reference them. `clean.ts`
   enforces this by sorting the work list, not by convention.

6. **Post-run disclosure.** Trash does not reclaim space until emptied. After cleaning,
   the tool reports the total now sitting in Trash and offers to empty it.

---

## User interface

An Ink (React for terminals) full-screen application, two panes.

```
┌─ dev-cleaner ─────────────┬──────────────────────┐
│ PROJECTS          133G    │ tinysync             │
│                           │ rust · dormant 8mo   │
│ ▸◉ tinysync       67.0G   │                      │
│  ◉ v2/magicalll    3.4G   │  target/      67.0G  │
│  ◉ bump            3.3G   │  node_modules  1.1G  │
│  ○ notchpad        1.6G   │                      │
│  ○ pysa            1.5G   │  last commit:        │
│                           │    2025-11-14        │
│ CACHES             32G    │  branch: main        │
│  ◉ pnpm store      8.0G   │  uncommitted: no     │
│  ◉ gradle          6.9G   │                      │
└───────────────────────────┴──────────────────────┘
 space toggle · a all · p preset · enter clean · q quit
```

- **Left pane** — selectable list, two sections (Projects, Caches). Projects are grouped
  into dormant (selected by default) and active (protected, unselected).
- **Right pane** — detail for the highlighted row: types, per-artifact breakdown, git
  metadata, activity reason.
- **Footer** — key hints and running total of the current selection.

**Keys:** `↑`/`↓` or `j`/`k` move · `space` toggle · `a` toggle all in section ·
`p` cycle preset · `enter` confirm · `q` quit.

**Progressive rendering.** Discovery and sizing are slow enough to be visible on a
133 GB tree. The UI renders as soon as project roots are known, with sizes filling in
and rows re-sorting as results arrive. It never blocks on a complete scan.

**Confirmation.** `enter` opens a summary screen listing what will be trashed and the
total, requiring an explicit second confirmation before `clean.ts` runs.

**Degradation.** When stdout is not a TTY, the tool prints the static report and exits
without prompting, rather than attempting to render.

---

## Testing

Vitest.

- **Fixtures over mocks.** A `fixture()` helper builds real temporary directory trees.
  `detect`, `artifacts`, and `discover` are tested against an actual filesystem, since
  their entire job is filesystem interpretation.
- **Discovery cases:** nested projects (`v2/zerolist`), container directories (`v2/`),
  roll-up (a repo with nested markers collapses to one), pruning (no descent into
  `node_modules`), skipping (`.worktrees`, `.claude`, symlinks).
- **Detection cases:** polyglot projects — a Flutter tree must yield
  `{flutter, gradle, xcode, ruby}` and the union of their artifact paths.
- **Safety cases (adversarial):** a symlink pointing at `$HOME`; a `node_modules` outside
  any project root; a project root equal to `$HOME`; a scan root of `/`. Each must be
  refused.
- **`clean.ts`** is tested with an injected trash function, asserting both the allowlist
  guard and the `node_modules`-before-store ordering.
- **Activity** is tested with synthetic signal objects — no git repository required.

---

## Packaging

- **Name:** `dev-cleaner` (verified available on npm, 2026-07-25)
- **Type:** ESM, Node ≥ 20
- **Binary:** `dev-cleaner`
- **Language:** TypeScript, compiled to `dist/`
- **Runtime dependencies:** `ink`, `react`, `trash`
- **Platforms:** macOS, Linux, Windows. Developed and tested on macOS; cache path table
  covers all three.

---

## Open decisions deferred to implementation

These are performance choices to settle by measurement, not requirement gaps. Each has a
stated default, so implementation is never blocked waiting on them.

- Sizing strategy: `du -sk` where available with a concurrent Node walker fallback, versus
  a Node walker everywhere. Decide by measurement against the reference tree.
  Default: `du -sk` with fallback.
- Concurrency limit for sizing. Default: `os.availableParallelism()`, floor 4, cap 16.
- Whether to persist a scan cache between runs. Default: no.
