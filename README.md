# dev-cleaner

Finds the regenerable build output scattered across a projects directory — `target/`,
`node_modules`, `.next`, `.dart_tool`, `build/`, and the global tool caches behind them —
and moves it to the system Trash. It protects work you are still doing, refuses anything
that isn't plainly rebuildable, and shows you the list before it touches a thing.

```sh
npx @nynb/dev-cleaner ~/develop
```

Node ≥ 20. Developed and used on macOS; the per-platform cache table also covers Linux and
Windows.

> **It moves things to the Trash, it does not delete them.** The disk does not get its
> space back until the Trash is emptied. dev-cleaner says so wherever it shows you a total,
> and offers to empty it for you — see [The Trash caveat](#the-trash-caveat).

The author's first real run took `~/develop` from 133 GB to 20 GB.

---

## Pipe it first

`dev-cleaner` renders an interactive interface when stdout is a terminal, and prints a
static report when it isn't. **Piping is the dry run.**

```sh
dev-cleaner ~/develop | less
```

Real output, from a scan of a small demo tree. Nothing is edited except the directory it
lived in, rewritten to `/Users/you/projects` so the lines fit:

```
dev-cleaner
roots:  /Users/you/projects
preset: recommended (build + cache)

PROJECTS  ·  4 items  ·  1.8G
  [x] tinysync                             1.2G
      rust · dormant 8mo
      edited 8mo ago · slow rebuild · rebuilds offline
      target/                              1.2G  build
  [x] mobile                               580M
      flutter, gradle, ruby, xcode · dormant 1y
      edited 1 year ago · slow rebuild · rebuilds offline
      android/.gradle/                     150M  cache
      build/                               430M  build
  [x] api                                 53.0M
      node · dormant 6mo
      edited 6mo ago · rebuilds offline
      .turbo/                              9.0M  cache
      dist/                               44.0M  build
  [-] site                                38.0M
      node · dormant 5mo
      edited 5mo ago · rebuilds offline
      blocked: contains-repository: /Users/you/projects/site/dist is a git repository (its .git is a directory); refusing to trash history
      dist/                               38.0M  build

IN USE RECENTLY  ·  1 item  ·  210M
  [ ] portfolio                            210M
      node · active
      edited 7 days ago · rebuilds offline
      .next/                               210M  build

CACHES  ·  2 items  ·  7.6G
  [-] pnpm store                           7.5G
      hardlink target for project node_modules (2 found in this scan) — this preset does not trash node_modules, so the store stays
      blocked: node_modules elsewhere on this machine still hardlink into it (or it could not be fully checked), so pruning it would orphan those links (2 node_modules found in this scan); clean node_modules, then empty the Trash — a trashed node_modules keeps its hardlinks — and the store can be pruned on the next run
  [x] npm cache                           60.6M
      safe — packages are re-downloaded on demand

Selected by default: 4 items · 1.9G
Blocked (not safe):  2 items · 7.6G — excluded from the total above; the reason is listed with each.
Protected (active):  1 item · 210M — selectable by hand in the interactive interface.

Nothing was deleted. Run dev-cleaner in a terminal to review and clean interactively.
```

Three marks, and they are the whole report:

| Mark  | Meaning |
| ----- | ------- |
| `[x]` | Selected by default. Dormant, and the safety guards have already agreed to it. |
| `[ ]` | Found, listed, not offered — the project scored as in use recently, so it sits in its own section unselected. Selectable by hand. |
| `[-]` | **Refused.** The reason is printed beneath it, and its bytes are excluded from the total. |

Artifacts outside the current preset's categories are not listed at all, which is why no
`node_modules` appears above: the default preset does not clean them, so counting them
would be a promise the run does not keep. Run with `--preset aggressive` to see them.

`site` above is the everyday version of the interesting case: its `dist/` is a `gh-pages`
deploy clone, so trashing it would take unpushed history with it. The tool notices and
refuses, and says so rather than quietly shrinking the total.

### Why there is no `--dry-run`

Because a flag can be forgotten and a pipe cannot.

`--dry-run` is a mode you have to remember to ask for, and the failure mode of forgetting
it is the one failure this tool must not have. Making the *absence of a terminal* the
safe mode inverts that: `dev-cleaner ~/dev > report.txt`, `| less`, `| grep`, a cron job,
a CI step and an editor's shell pane are all incapable of deleting anything, because the
branch that deletes is never reached. `dev-cleaner --dry-run` is a usage error (exit 2),
deliberately.

The non-TTY branch never calls the interface or the cleaner, and the `trash` library
itself is loaded lazily inside the one function that deletes — a function that branch
never reaches. That is asserted as a set of negatives in `tests/cli.test.ts`, not just
documented here.

---

## The interface

Run it in a terminal and you get a full-screen session: **Splash → Home → Triage →
Confirm → Done**. The scan starts behind a short brand splash; once there is an honest
recommended total, you land on Home with one primary action. Browse and adjust is opt-in
(`b`). The footer shows only the keys valid in the current mode — not the full binding
list on every screen.

**Home** — default after splash (same demo tree as the piped report above):

```
 ▓▒░ DEV-CLEANER  ~/develop          ✓ scan complete · 5 projects · 2 caches · 9.7G
 ██████████████▓░░░░░░░  67%  309G used of 460G · 152G free

      █▀█ █   9.7G
      █▄█ █   in the recommended set

      enter — trash 5 items · 9.7G
      b     — browse & adjust
      t     — Trash · q quit

 enter reclaim · b browse · p preset · t Trash · q quit
```

**Triage** — full-width list; detail on demand (`d`):

```
 ▓▒░ DEV-CLEANER  triage                reclaim 9.7G
 ██████████████▓░░░░░░░  67%  309G used of 460G · 152G free

 PROJECTS 4                                          1.8G
  ◉ tinysync             edited 8mo · slow   1.2G
  ◉ mobile                edited 1y · slow   580M
 ▸◉ api                         edited 6mo  53.0M
  ◉ site                        edited 5mo  38.0M
 IN USE RECENTLY 1                                   210M
  ○ portfolio                    edited 7d   210M
 CACHES 2                                            7.6G
  ○ pnpm store                                      7.5G
  ◉ npm cache                                      60.6M

 ▸ api · node · dormant 6mo · dist 44.0M
 space · a · j/k · d detail · p · enter · esc home · t · q
```

| Key | Does |
| --- | ---- |
| `↑` `↓` / `j` `k` | Move the cursor (Triage) |
| `space` | Toggle the highlighted row (Triage) |
| `a` | Toggle everything in the current section (Triage) |
| `b` | Browse & adjust — Home → Triage |
| `d` | Full detail for the focused row (Triage); `esc` back |
| `p` | Cycle the preset (recommended ⇄ aggressive) |
| `enter` | Home or Triage: screen the selection, then ask for confirmation; Confirm: execute |
| `esc` | Triage → Home; Confirm → back; Done → Home |
| `t` | Empty the Trash (requires typing the word `empty`) |
| `q` | Quit |

The list paints as soon as the first project root is known and keeps repainting as sizes
arrive — it never blocks on a complete scan.

`enter` does not clean. It freezes your selection, runs it through the deletion boundary's
own guards, and shows you the result: what will be trashed, what was refused and why, and
the honest total. Only a second `enter` on that screen actually moves anything. The
confirmation transition is single-use, so a held or double-tapped `enter` cannot run a
round twice.

That is also why `site` is ticked in the triage list above but `[-]` in the report. The
interactive list does not screen while you browse; it screens when you press `enter`, on
the selection you actually chose, and shows you the refusal then. The piped report has no
"moment you ask", so it screens every row up front instead. Same guards, same verdict,
asked at different times.

---

## What it cleans

Ten ecosystems, three categories. A directory is a **project root** when it contains
`.git` or one of these markers; everything below it rolls up into that one entry, so a
monorepo is one row and not forty.

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

Types are a **set**, not a single value. A Flutter app is simultaneously `flutter`,
`gradle`, `xcode` and `ruby`, and it contributes all four rows' artifacts — which is why
`mobile` in the report above lists both `build/` and `android/.gradle/`. Types are also
detected across the whole rolled-up subtree, not only at the root, so a Rust monorepo with
an Xcode sub-app yields both.

Entries containing `/` match a path relative to the directory that declared the type;
entries containing `*` are globs; everything else matches a directory name at any depth
inside the project. This table is the allowlist — nothing outside it is deletable at all.

### The two presets

| Preset | Categories | What that means |
| --- | --- | --- |
| **recommended** (default) | `build` + `cache` | Rebuild from source you already have. No network needed. |
| **aggressive** | `build` + `deps` + `cache` | Also clears `node_modules`, `.venv`, `Pods`, `vendor/bundle`. Much bigger, but the next build has to re-download. |

`--preset aggressive`, or press `p` in the interface. Switching presets recomputes the
selection; it does not re-walk the filesystem.

### Global caches

Below the projects, with their own selection: pnpm store, npm cache, Gradle caches, Cargo
registry, Xcode DerivedData, CoreSimulator caches, pub cache, Yarn, CocoaPods. Paths
resolve per platform and honour `XDG_CACHE_HOME`, `LOCALAPPDATA` and `CARGO_HOME`. Caches
that don't exist on your machine aren't listed at all. `--no-caches` skips the section.

`~/Library/Developer/CoreSimulator` as a whole is never offered — it holds downloaded
runtimes and device state. Only its `Caches` subdirectory is.

---

## How it decides what to offer

Every project gets an activity score, and only **dormant** ones are selected by default.
Active ones are listed in their own section, unselected — protection is a default, not a
lock, and you can always select them by hand.

The score is built from five signals, and the interesting part is which of them counts:

| Signal | Counts as activity? |
| --- | --- |
| Last commit (`git log -1`) | Yes |
| Newest source-file edit, with artifact directories pruned from the walk | Yes |
| Newest lockfile mtime | Yes |
| Uncommitted changes (`git status --porcelain`) | Extends the threshold, see below |
| Newest **artifact** directory mtime — the last build | **No, deliberately** |

**Artifact mtimes do not count.** A watch build, a dev server, a CI checkout or an
`npm install` touches build directories without anyone deciding anything. If that counted
as activity, every project you have ever run would be permanently protected and a cleaner
would find nothing to clean. Only *authoring* counts, which is exactly why the walk that
looks for source edits prunes the artifact directories rather than filtering them
afterwards — a `target/` full of freshly written object files would otherwise make every
built project look worked-on a minute ago.

The thresholds:

- **30 days.** Below it you are still on this; above it you would not notice a rebuild.
  Thirty days spans a holiday, a sprint on something else, or a month of meetings without
  declaring the work abandoned.
- **90 days when the tree is dirty.** Uncommitted changes are not a data-loss risk here —
  artifacts are not source, and the allowlist cannot name `src/` — but they mean you
  stopped mid-thought, and clearing the build costs you your place. That is worth a longer
  benefit of the doubt, not permanent immunity: a tree left dirty three years ago is
  abandoned, not paused.
- **No dates at all → active.** A project with no repository, no readable source mtimes
  and no lockfile reports `no dates to score — protected` and idle 0. "I cannot tell" must
  never render as "eight months dormant"; a confident wrong number is worse than an
  admission of ignorance.

Every row prints the reason it was scored the way it was, so a surprising verdict is
debuggable from the report alone.

---

## The Trash caveat

**Trashing is not deleting.** The tool says so wherever it reports a total, and it is worth
saying once more here.

Moving a directory to the Trash is, on the same volume, a rename. That is why it takes the
same time for a 67 GB `target/` as for an empty one, and why you get an undo. It is also
why *the space is not back*. Until you empty the Trash, `df` will show exactly what it
showed before.

dev-cleaner therefore:

- reports what is now sitting in the Trash rather than what was "freed";
- prints the disclosure on the way out, so it survives scrollback. Redirected, that is
  exactly one greppable line:
  `dev-cleaner: <total> moved to the Trash in 1 round. Trashed files still occupy the disk until you empty the Trash.`;
- offers to empty the Trash from inside the interface (`t`), showing the whole Trash's
  size first and requiring you to type the word `empty` — emptying is irreversible and
  covers files this tool never touched;
- replaces the disclosure with "The Trash was emptied, so that space is back" when, and
  only when, you actually did.

One consequence worth knowing: **a trashed `node_modules` keeps its hardlinks into the
pnpm store.** So the store cannot be pruned in the same run that clears them — clean the
`node_modules`, empty the Trash, then run again. The tool works this out for itself, says
so in the refusal, and never prunes a store that anything still links into.

---

## Safety

This tool deletes user data, so it is built around eight numbered safety invariants that
are tested with fixtures constructing the *dangerous* case, not the safe one.

The short version:

1. **Allowlist, never blocklist.** There is no "delete everything except" code path
   anywhere. A bug therefore leaves something uncleaned rather than deleting something
   extra.
2. **Symlinks are never followed** — checked over the whole ancestor chain, not just the
   final component.
3. **Root guards run on the real path.** `/`, `$HOME`, and anything one level below the
   filesystem root are refused (exit 3), after `realpath`, so a symlink cannot smuggle one
   past.
4. **Trash, not `unlink`.**
5. **Ordering is a dependency.** A package store is never pruned while anything on the
   machine still hardlinks into it.
6. **Worktree detection runs before artifact matching.** `git worktree add build` creates
   a real checkout named `build`; matched the other way round it would be trashed as build
   output.
7. **Git subprocesses are hardened.** A downloaded repository's own `.git/config` can
   otherwise execute a command during what you believe is a read-only scan.
8. **Post-run disclosure.** The Trash still occupies the disk.

Several of these exist because the corresponding defect was found in a working
implementation during development. The long version — what each invariant prevents, and
the concrete failure that motivated it — is in **[docs/SAFETY.md](docs/SAFETY.md)**. It is
worth reading before pointing this at a disk you care about.

The tool also does **no repository management of any kind**: it never removes a worktree,
prunes a worktree registration, deletes a branch, or runs `git gc`. It deletes regenerable
files and nothing else.

---

## Usage

```
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
```

Multiple roots are fine: `dev-cleaner ~/develop ~/work ~/src`.

Unknown flags are a usage error rather than being collected as directory names — a
mistyped `--no-cache` that silently became a path would scan the wrong thing while looking
like it worked.

**Exit codes:** `0` success · `1` unexpected failure · `2` usage error · `3` a refused
scan root. `3` is distinct on purpose: it is not a failure, it is the safety layer
working.

---

## Installing

```sh
npx @nynb/dev-cleaner ~/develop   # no install
npm install -g @nynb/dev-cleaner # then: dev-cleaner ~/develop
```

The package is scoped; the command is not. npm rejects the unscoped name `dev-cleaner` as
too similar to an existing `devcleaner`, so the package lives under `@nynb`. Once installed
the binary on your PATH is plain `dev-cleaner`.

```sh
```

Requires Node ≥ 20. Runtime dependencies are `ink`, `react` and `trash`, and nothing else.

Release notes are in [CHANGELOG.md](CHANGELOG.md). Because this tool deletes things, the
versioning policy carries a rule generic SemVer does not cover: **if a directory that
version *N* left alone can be offered for deletion by version *N+1*, that release is never
a patch**, and the changelog lists every directory name that became deletable. See
[docs/VERSIONING.md](docs/VERSIONING.md).

---

## Contributing

Issues and pull requests are welcome — bug reports especially, and above all reports of
anything this tool offered to delete that it should not have.

If you are changing code, read **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** first. The
house rule that matters most: every safety guard needs a test that constructs the
dangerous case, and the way to check a test is real is to delete the guard and confirm the
test fails.

```sh
npm install
npm run build        # tsc -> dist/
npm test             # vitest run
npm run typecheck    # tsc over src + tests
```

---

## Licence and author

MIT. See [LICENSE](LICENSE).

Written by Narayan ([@codevalley](https://github.com/codevalley)).
