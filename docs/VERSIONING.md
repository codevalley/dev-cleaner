# Versioning policy

dev-cleaner follows [Semantic Versioning](https://semver.org/), with one rule that generic
SemVer advice does not cover and that matters more here than everything else on this page.

---

## The rule that is specific to this tool

**If a directory that version *N* left alone can be offered for deletion by version *N+1*,
that release is never a patch.**

The rule is about the *outcome*, not about which file changed. All of these widen what the
tool can delete, and all of them are covered:

- adding a pattern to the artifact table in `src/artifacts.ts` (`zig-out`, `.nuxt`, …);
- adding a marker to an existing project type, so directories that were not detected as
  that type now are — adding `Cargo.lock` as a rust marker makes `target/` deletable in
  every directory that has a lockfile and no `Cargo.toml`;
- adding a whole project type;
- adding an entry to the global cache table in `src/caches.ts`;
- moving an existing pattern to a less conservative category. `recommended` is
  `build + cache`, so moving anything out of `deps` and into `build` makes it deletable
  under the **default** preset, which is a wider change than adding a new `deps` entry;
- loosening activity scoring, so projects that were previously withheld are now offered
  pre-selected.

### Where such a change belongs

| | |
| --- | --- |
| **While the version is `0.x`** | Minor: `0.1.0` → `0.2.0`. Never a patch. |
| **From `1.0.0` onward** | Major: `1.4.2` → `2.0.0`. |

The 0.x rule is not a softer version of the 1.x rule; under npm's range semantics it is the
*same* rule. `^0.1.0` accepts `0.1.x` and refuses `0.2.0`, exactly as `^1.4.2` accepts
`1.x` and refuses `2.0.0`. In 0.x the minor slot **is** the breaking slot, so a table
addition gets the strongest signal the numbering can carry, in both eras.

### Why "breaking", and not merely "a feature"

The honest case for calling this breaking is that the tool's entire contract with its user
is *which directories it will remove*. A user who reads the artifact table and concludes
"my `.cache-foo` is safe" has read the interface. Widening the table falsifies that reading.
Nothing else this program does is more central than that, so if a widened table is not
breaking, nothing is.

The honest case *against* pretending the version number solves it is just as important, and
it is the reason the rule below exists:

**A version number protects nobody who runs `npx dev-cleaner`.** `npx` fetches the latest
published version every time. Major, minor, patch — the user gets the new table either way,
and no range specifier stands between them and it. Version numbers only gate the small
minority of users who pin dev-cleaner as a devDependency.

So the numbering rule is necessary but not sufficient, and the actual protection is in the
product, not in the number:

1. **Nothing is deleted without an explicit confirmation** in the interactive interface, on
   a list the user can see, item by item, with sizes.
2. **Piping is the dry run.** When stdout is not a TTY the deleting path is never even
   loaded — so `dev-cleaner ~/develop | less` shows the new table's effect on a real
   machine without any possibility of acting on it.
3. **The changelog names the directories.** Every release that widens the table carries a
   `### Now removes` section listing each newly deletable pattern by name — see
   [CHANGELOG.md](../CHANGELOG.md). That is the artifact a cautious user can actually diff
   before upgrading; the version number only tells them to go and read it.

A release that widens the table and does not carry a `### Now removes` section is a
defective release, whatever number is on it.

### The reverse direction is not breaking

Removing an entry from the table, tightening a marker, or making activity scoring more
protective all mean the tool deletes **less**. That fails closed, surprises nobody, and can
ship in a patch. Safety changes should never be held back by a version-number argument.

---

## What `0.x` means here, and what earns `1.0.0`

`0.x` is not modesty. It is a specific claim about which parts of this tool are still
learning:

- The **safety invariants** are not provisional. There are eight of them, they are stated
  in the design spec, and they are covered by the `*.safety.test.ts` and `*.pinning.test.ts`
  files. Changing one of those is a design decision, not tuning, and it is breaking at any
  version number.
- The **artifact matrix and the activity heuristics** *are* provisional. They are the part
  most likely to need to grow, because the only way to learn that a toolchain leaves
  regenerable junk in a directory nobody thought of is for someone to run the tool on a
  machine that has it.
- The evidence base is one machine. dev-cleaner has been run to completion on the author's
  macOS laptop, where it took `~/develop` from 133 GB to 20 GB — 107 GB reclaimed. That is
  a real result and it is also a sample size of one, on one operating system, with one
  person's set of toolchains.

`1.0.0` is earned when the provisional parts stop moving and the claims are backed by
something other than the author's own disk:

1. The tool has been run to completion by people other than the author, on machines other
   than the author's — including at least one Linux machine, since the cache table makes
   claims about three platforms and only one of them has been exercised end to end. The CI
   matrix carries an explicitly non-required Linux job for exactly this reason.
2. At least one full release cycle passes with no report of the tool *offering* something
   that was not regenerable. A false positive on this tool is the only bug class that
   matters; a missed artifact is a smaller version of the problem it exists to solve.
3. The non-TTY report is deliberately frozen, or a stable machine-readable output mode is
   added alongside it. At `1.0` people will be parsing that text, and it should stop being
   accidental before it becomes load-bearing.
4. Each of the eight invariants has a test that demonstrably fails when the invariant is
   removed — not merely a test that passes while it holds.

Until then, expect the minor number to move, and expect each move to be explained in the
changelog.

---

## What is breaking for this CLI

The interface is the command line, the exit status, and the text on stdout when stdout is
not a terminal. Concretely, a change to any of the following is breaking:

- **Flags.** Removing or renaming `-p`/`--preset`, `--caches`, `--no-caches`,
  `-c`/`--concurrency`, `-h`/`--help`, `-V`/`--version`, positional `roots`, or the `--`
  end-of-options convention. So is narrowing an accepted value, such as dropping
  `--preset aggressive`.
- **The default preset.** It is `recommended` (`build` + `cache`). Changing that default,
  or changing which categories a preset name maps to, is breaking — a user who types no
  flags is relying on it.
- **Exit codes.** `0` success, `1` unexpected failure, `2` usage error, `3` a refused scan
  root. Renumbering any of these, or reusing one for a different meaning, breaks every
  script that branches on them. `3` is deliberately distinct from `1` because a refused
  root is the safety layer working, not a failure, and that distinction is part of the
  contract.
- **What is selected by default.** The activity score decides which rows arrive pre-ticked.
  A user who reviews the list and presses the confirm key is trusting the scoring, not
  reading every path. Loosening it is breaking under the table rule above.
- **The non-TTY report.** Piping is the dry run, which guarantees the report will be
  grepped, diffed and pasted into scripts. The header lines (`dev-cleaner`, `roots:`,
  `preset:`), the group headings, the per-row shape, and the trailing
  `Selected by default:` / `Protected` / `Nothing was deleted.` lines are all interface.
- **Deleting without a TTY, or adding any flag that deletes without interactive
  confirmation.** This is worse than breaking; it is a reversal of the design. There is no
  `--dry-run` flag precisely because a flag can be forgotten and a pipe cannot, and a
  `--yes` flag would reintroduce the failure mode the whole shape of the tool avoids.
- **Raising the `engines.node` floor** above the current `>=20`.

## What is not breaking

- **How the interface looks.** Colours, box drawing, spacing, chip wording, key hints, the
  banner, the disk gauge, the ordering of rows on screen. The TUI is for a human reading it
  live; it is allowed to improve.
- **Wording.** Help text prose, refusal messages, labels — as long as the flags they
  describe and the decisions they explain are unchanged.
- **The internal module layout.** Nothing is exported as a library. `files` ships the
  compiled `dist` (JavaScript and source maps, no `.d.ts`), `CHANGELOG.md` and the
  documents in `docs/`; `exports` deliberately publishes only `./package.json`, so
  `import 'dev-cleaner'` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` by design. Every module
  under `src/` may be renamed, split or deleted in a patch release.
- **Performance and internals.** The `du`-versus-walker sizing strategy, the default sizing
  concurrency, caching, the order in which the filesystem is walked.
- **Adding a new flag** whose absence changes nothing — a minor.
- **Dependency bumps** that do not change observable behaviour.

---

## Release procedure

Four commands. It is written down so that it is repeatable rather than remembered.

```sh
# 1. Move the Unreleased section of CHANGELOG.md into a new version heading with today's
#    date. If this release widens what the tool deletes, it MUST carry a `### Now removes`
#    section naming each newly deletable directory. Commit that edit.
git commit -am "docs: changelog for 0.2.0"

# 2. Bump, commit and tag in one step. Use `minor` for anything that widens the table (see
#    the top of this file), `patch` only for fixes that delete the same set or less.
npm version minor -m "release: v%s"

# 3. Push the commit and the tag together.
git push origin main --follow-tags
```

That is the whole manual part. Pushing a `v*` tag then triggers
`.github/workflows/publish.yml`, which:

1. checks out the tag and installs with `npm ci`;
2. runs the typechecker, the build and the full test suite — a red suite means no publish;
3. refuses to continue unless the tag name matches `version` in `package.json`, so a
   mistyped tag cannot publish a different version than it names;
4. runs `npm publish --access public`, which rebuilds `dist` through the `prepack` script
   and attaches a signed provenance statement linking the tarball to this repository and
   this workflow run.

The workflow publishes on tags only. It does not run on pushes to a branch, and it does not
run on pull requests.

### Authentication: trusted publishing, not a token

The workflow holds no npm credential. It authenticates with a short-lived OIDC token GitHub
mints for that specific repository, workflow and run, which npm checks against a trusted
publisher configured once on the package page:

> npmjs.com → **dev-cleaner** → Settings → Trusted publishers → GitHub Actions
> organization `codevalley`, repository `dev-cleaner`, workflow `publish.yml`

Nothing is stored in repository secrets and nothing needs rotating. Provenance is attached
automatically under trusted publishing, which is why `--provenance` is not passed — the flag
is not merely redundant there, it fails a laptop publish that has no OIDC to attest with.

This is not only hygiene. npm is retiring the alternative: from **early August 2026** a
2FA-bypass token stops bypassing 2FA for account operations, and from **around January 2027**
such tokens cannot publish at all, becoming read-and-staging only
([changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).
A publish token added to repository secrets today is a credential that expires by policy,
can be stolen while it works, and never rotates itself.

**The first release is the exception.** A trusted publisher is configured *on* a package, so
the package must already exist. Publish `0.1.0` once from a laptop with `npm login` and 2FA,
configure the trusted publisher, and every release after that is hands-off.

To verify afterwards:

```sh
npm view dev-cleaner version
```
