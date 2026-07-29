# Changelog

All notable changes to dev-cleaner are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/) as qualified by
[docs/VERSIONING.md](docs/VERSIONING.md).

One extra section type is used, and it is the important one:

> **`Now removes`** — directories that this version will offer for deletion and the previous
> version left alone. A release that widens what the tool deletes must list every new
> pattern here by name, and may never be a patch. See
> [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

### Changed

- Interactive session is now Splash → Home → Triage → Confirm → Done (lazygit-style
  full-width triage; detail on demand). Same safety model and non-TTY report.

## [0.1.1] — 2026-07-28

No functional change. Identical code to 0.1.0; cut to exercise the automated release path
end to end — a tagged push publishing through GitHub Actions with trusted publishing (OIDC),
holding no npm credential — on a version where a failure costs nothing.

### Changed

- Publishing moved from a long-lived `NPM_TOKEN` to trusted publishing. npm is retiring the
  alternative: from early August 2026 a 2FA-bypass token stops bypassing 2FA for account
  operations, and from around January 2027 such tokens cannot publish at all. The workflow
  now authenticates with a short-lived OIDC token minted per run and scoped to this
  repository and `publish.yml` specifically, and provenance is attached automatically.
- Published under the `@nynb` scope. npm rejects the unscoped name as too similar to an
  existing `devcleaner`. **The command is unchanged**: installing puts plain `dev-cleaner`
  on your PATH, because `bin` is independent of package name.

## [0.1.0] — 2026-07-27

First release.

### Added

- **Interactive terminal interface** (Ink). Scans one or more project directories, groups
  what it finds by how recently the project was worked on, and lets the user walk the list,
  inspect any row, and select or deselect individual artifacts before anything happens.
  Cleaning runs in rounds: the per-round report is drawn inside the interface, next to the
  list it describes, so a second round can act on it.
- **Project detection across ten toolchains** — node, rust, flutter, xcode, gradle, python,
  ruby, go, dotnet and cmake — with types detected across a whole rolled-up subtree rather
  than only at its root, so a monorepo's nested sub-projects contribute their artifacts to
  the entry the user actually sees.
- **Presets.** `recommended` (`build` + `cache`, the default) and `aggressive`
  (`build` + `deps` + `cache`), toggled with `p` in the interface or `--preset` on the
  command line. Switching preset re-selects; it never re-walks the filesystem.
- **Global tool caches**, matched by platform rather than by whatever happens to be on
  disk: 9 entries on macOS (pnpm store, npm cache, Gradle caches, Cargo registry, Xcode
  DerivedData, CoreSimulator caches, pub cache, Yarn cache, CocoaPods cache) and 6 on Linux
  and on Windows. Suppressed with `--no-caches`.
- **Activity scoring** decides what is offered pre-selected. A project whose last commit,
  source edit or lockfile change falls within 30 days is treated as active and withheld
  from the default selection; a project with uncommitted changes gets 90 days instead. A
  project with no datable signal at all is protected rather than guessed at. Artifact
  mtimes deliberately do not count: a watch build, a dev server or a CI checkout touches
  `dist/` without anyone deciding anything, and admitting that evidence would mark every
  project you ever ran as permanently active.
- **Disk gauge and Trash disclosure.** Free space before and after, the size of what is
  now sitting in the Trash, and an option to empty the Trash from inside the interface,
  gated behind a typed confirmation.
- **Flags:** positional `roots`, `-p`/`--preset`, `--caches`/`--no-caches`,
  `-c`/`--concurrency`, `-h`/`--help`, `-V`/`--version`, and `--` to end option parsing.
- **Exit codes:** `0` success, `1` unexpected failure, `2` usage error, `3` a refused scan
  root. `3` is distinct because a refused root is the safety layer working, not a failure.

### Safety

The tool moves user data to the Trash, so its safety properties are stated as eight
invariants in the design spec and tested directly rather than reasoned about.

- **Allowlist, never blocklist.** A directory is deletable only because a pattern in the
  artifact table names it and it sits inside a detected project (or is an entry in the
  global cache table). There is no "delete everything except" path, so a bug leaves
  something uncleaned rather than deleting something it should not have.
- **No symlink traversal, over the whole ancestor chain.** Checking only the final
  component is not enough: one symlinked parent (`~/Library/pnpm -> /`) makes a terminal
  check pass while the delete escapes the tree. Every target is validated across its entire
  path and refused when `realpath` differs from the lexical path.
- **Root guards apply to the real path.** A scan is refused when a root resolves to `/`,
  the user's home directory, or anything at depth ≤ 1 from the filesystem root — resolved,
  not merely normalised, because `~/develop/projects -> /` passes a lexical check.
- **Trash, not unlink**, through the platform's native facility.
- **Ordering as a dependency.** Project `node_modules` are trashed before any package store
  is pruned, and the store prune is *conditional* on every `node_modules` target having
  succeeded — including ones outside the directories being scanned, which is asked of the
  filesystem directly. A sorted loop that carried on after a failed delete would orphan the
  hardlinks of a project still on disk, which is exactly what the ordering exists to
  prevent.
- **Worktree detection runs before artifact matching.** `git worktree add build feature`
  creates a checkout named `build`, which a basename-first check would delete along with any
  uncommitted work in it. The check is enforced twice, independently: once in the walk and
  again at the deletion boundary.
- **Hardened git subprocesses.** A repository the user merely downloaded can execute
  arbitrary code during a read-only survey through `core.fsmonitor`, `core.hooksPath`, or
  `log.showSignature` with `gpg.program`. Every `git` invocation is prefixed with
  `-c core.fsmonitor= -c core.hooksPath=/dev/null -c protocol.ext.allow=never` and run with
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`. There is exactly one
  function in the codebase that spawns git, so there is no call site that can forget.
- **Post-run disclosure.** Trashing does not reclaim space. The closing line says how much
  is now in the Trash and that it stays on the disk until the Trash is emptied.

### Notes

- **Piping is the dry run.** When stdout is not a terminal, dev-cleaner prints a static
  report and returns; the deleting path is never loaded. There is no `--dry-run` flag
  because a flag can be forgotten and a pipe cannot.
- Requires Node ≥ 20. Published as ESM with a single binary, `dev-cleaner`.
- Developed and used on macOS. The cache table covers macOS, Linux and Windows, but only
  macOS has been exercised end to end — see the `1.0.0` criteria in
  [docs/VERSIONING.md](docs/VERSIONING.md).

[Unreleased]: https://github.com/codevalley/dev-cleaner/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/codevalley/dev-cleaner/releases/tag/v0.1.0
