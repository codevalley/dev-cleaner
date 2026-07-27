# The safety model

dev-cleaner performs bulk deletion of directories it selected itself, on a disk full of
work that is not backed up as often as anyone claims. So its safety properties are written
down as numbered invariants, enforced in code, and tested with fixtures that construct the
**dangerous** case rather than the safe one.

This document explains each invariant in plain language and — the part actually worth
reading — the concrete failure it exists to prevent. Several of these are not
hypotheticals. Invariants 2, 3, 5, 6 and 7 were each found by adversarial review of a draft
that had already been written against invariants 1–4, and every one of them is a case where
a plausible implementation satisfies the *wording* of an earlier invariant while defeating
its purpose. Others were found later still, by mutation testing, in code that looked
correct and had passing tests.

Messages quoted below are the tool's real output, wrapped to fit this page where the
original prints on one line.

The general principle underneath all of them: **fail closed.** When something is unclear,
unreadable, unresolvable or unfinished, the answer is "leave it alone", never "probably
fine". The cost of a wrong refusal is disk space you didn't reclaim. The cost of a wrong
permission is work you can't get back.

---

## 1. Allowlist, never blocklist

**The rule.** A path is deletable only if its basename or relative path appears in the
artifact table *and* it lies strictly inside a detected project root *and* that root lies
inside one of the scan roots. Global caches are allowlisted by exact path, from the cache
table, and only when the scan itself produced them. There is no code path anywhere in this
tool that deletes "everything except" something.

**What it prevents.** The class of bug where a directory nobody thought about gets deleted
because it didn't match an exclusion. A blocklist has to be complete to be correct; an
allowlist has to be complete to be *useful*. So a bug in dev-cleaner fails in the direction
of leaving something uncleaned — you notice a number that is smaller than you hoped, not a
directory that is gone.

**How it holds.** The artifact table is deep-frozen at module load, because a table another
module can push onto is not an allowlist. The check is made twice: once where candidates
are produced (the walk), and again, independently, at the deletion boundary against the
paths actually about to be handed to the trash. The second check exists because the first
protects against nothing once a caller constructs a target by hand — and the interface, the
CLI and every future consumer are exactly such callers.

The deletion boundary also takes a *structured* target (a project and its artifact, or a
cache entry) rather than a flat `{path, bytes}`. A flat path would be sufficient to delete
with, and that is precisely the danger: it would make the entire guard layer unreachable
from the only code path a user can actually invoke, while unit tests that call the guards
directly stayed green.

---

## 2. No symlink traversal — over the whole path, not the last component

**The rule.** Symbolic links are never followed, when walking, when sizing, or when
deleting. Every delete target is validated across its **entire ancestor chain**, and
refused when `realpath` disagrees with the lexical path.

**The failure it exists to prevent.** Checking only the final component with `lstat` is not
enough, and the counterexample is not exotic:

```
~/Library/pnpm  ->  /
```

Now `~/Library/pnpm/store` — an entry in the global cache table — resolves to the real
`/store`. `lstat` on that final component reports an ordinary directory, not a link. A
terminal-only check passes, and the delete escapes the intended tree entirely.

**How it holds.** Every ancestor of a delete target is `lstat`ed and refused if it is a
link, and then the same question is asked a second way: the parent's `realpath` is compared
with its lexical form, so any disagreement at all means we would not be deleting what we
named. Sizing obeys the same rule — `du` is invoked without `-L`, and the fallback walker
uses `lstat` and never `stat`, so a symlink handed to the sizer measures 0 rather than
reporting the whole volume as reclaimable.

The tests build a symlink pointing at `$HOME`, a cache whose *parent* component is a
symlink, an artifact reached through a symlinked subdirectory, and a symlink cycle inside a
project.

---

## 3. Root guards operate on the real path

**The rule.** The scan refuses to run when a root resolves to `/`, to the user's home
directory, or to any path at depth ≤ 1 from the filesystem root. The guards apply to
`realpath(root)`, and the resolved value becomes the scan root. The same guards are applied
again at the deletion boundary, to both the project root and the delete target.

**The failure it exists to prevent.** `path.resolve` normalises `..` lexically but does not
follow links. So:

```
~/develop/projects  ->  /
```

presents as a comfortable depth-3 path and sails through a lexical guard. Resolving first
is the whole point.

The same trap appears at the other end. `os.homedir()` returns the *lexical* home, but
every path at the deletion boundary has been through `realpath`. On the standard
NFS/automount layout — `/home/me` a symlink to `/export/home/me` — those differ, and a
lexical-only comparison lets `$HOME` itself through. Home directories commonly hold a
dotfiles repo and a `package.json`, which is exactly enough to be discovered as a project
with a `node_modules` worth deleting.

**How it holds.** `resolveScanRoot` realpaths and guards before anything else runs — before
the interface takes over the screen — and throws a distinct error that the CLI reports with
its own exit code:

```
$ dev-cleaner ~
dev-cleaner refused to scan: /Users/you resolves to your home directory (/Users/you);
refusing to scan it. Point dev-cleaner at a projects directory inside it instead.
$ echo $?
3
```

Exit 3 is deliberately not exit 1. It is not a failure; it is the safety layer working.

Comparisons are case-insensitive on macOS and Windows, which is the fail-closed direction
for a *guard* (more refusals) — while containment checks stay case-sensitive, because there
the same choice would admit more.

---

## 4. Trash, not `unlink`

**The rule.** Deletion goes through the platform's native recycle facility (the `trash`
package), never `rm -rf`.

**What it buys.** An undo. Also speed: on the same volume, trashing is a rename, so a 67 GB
`target/` costs the same as an empty one regardless of how many hundreds of thousands of
files it contains.

**What it costs, and why the tool keeps saying so.** The space is not back. See invariant 8.

**One detail that is load-bearing.** The `trash` package globs its input by default. A
directory legitimately named `[legacy]` or `!important` would be reinterpreted as a pattern
and could match something else entirely, so dev-cleaner passes `glob: false`. Every path it
hands over is already an exact, validated, absolute path; pattern expansion could only ever
widen it.

---

## 5. Ordering, and the dependency it encodes

**The rule.** Project `node_modules` are trashed *before* any package-store prune, so store
hardlinks are never orphaned while projects still reference them. This is enforced by
sorting the work list in code, not by convention. And sorting alone is not enough: the
store prune is **conditional** on every `node_modules` having actually been dealt with, and
is refused with an explanation otherwise.

**Why sorting alone fails.** If a `node_modules` delete fails (EPERM) or is refused
(symlink, missing, not a directory), a sorted loop happily proceeds to the store prune —
orphaning the hardlinks of a project that is still sitting on disk, which is precisely what
the ordering existed to prevent. Ordering is a dependency, not merely a sequence.

**The bigger hole underneath it.** Tracking only the *failures* of selected `node_modules`
is still not enough, and the gap is the default configuration. Under the `recommended`
preset the `deps` category is off, so **no `node_modules` is ever a target at all** — while
the pnpm store, a global cache, is selected. Every hardlink source is left behind, none of
them fails, and a failure-only check sees a clean run and prunes the store. That orphans
the hardlinks of every pnpm project on the machine, in the one configuration nearly every
user runs.

So the invariant's input is "every `node_modules` that will still be on disk when this run
ends", which includes the ones that were never selected, and it is typed as a required
argument so that omitting it is a compile error rather than a silent unsafe prune.

**And even that is scoped too narrowly.** The scan only knows about the roots it walked.
A user cleaning `~/work` still has `~/side-projects` full of pnpm-linked `node_modules`
that the scan never saw. So before any store prune, dev-cleaner asks the *filesystem*
whether anything still hardlinks into the store — walking it for a file with a link count
above one — and refuses the prune if the answer is yes, or if the walk could not be
finished.

**The real incident this produced.** A first run against the real 133 GB tree offered
`pnpm store 7.5G`, preselected it, and promised `18.5G` in the total. The deletion boundary
then refused the prune, correctly, because 31 `node_modules` on the machine still
hardlinked into the store. The user was promised 18.5G and would have received about 11G.
Nothing was ever at risk — the invariant did its job. What was at risk was the user's
willingness to believe the next refusal.

That is why the same question is now asked *twice*: once before the row is offered, so the
list and the total are honest; and once at the deletion boundary, so the outcome is safe.
The first is about honesty, the second about safety, and neither is a substitute for the
other. In the README's example report, that upstream check is what produces the following
(one line in the real output, wrapped here to fit):

```
  [-] pnpm store                           7.5G
      blocked: node_modules elsewhere on this machine still hardlink into it (or it
      could not be fully checked), so pruning it would orphan those links (2 node_modules
      found in this scan); clean node_modules, then empty the Trash — a trashed
      node_modules keeps its hardlinks — and the store can be pruned on the next run
```

Note the middle clause: **a trashed `node_modules` keeps its hardlinks.** Trashing is a
rename, so the links survive in `~/.Trash`. The store therefore cannot be pruned in the
same run that clears them. That is a real constraint, not a quirk, and the refusal says
what to do about it instead of merely stating a rule.

---

## 6. Worktree detection precedes artifact matching

**The rule.** A directory is tested for being a linked git worktree *before* its basename
is tested against the artifact table. A linked worktree is identified by one `lstat`: a
main checkout's `.git` is a directory, a linked worktree's is a file.

**The failure it exists to prevent.** This one is worth stating slowly, because it is the
single most destructive thing this tool could do and it is reachable through pure ordering.

```sh
git worktree add build feature
```

That is a perfectly ordinary command. It creates a real checkout — real source, on its own
branch, possibly with uncommitted work — in a directory named `build`. `build` is a name
the artifact table claims for six of its ten ecosystems. A basename-first check captures
it as build output and trashes it: source gone, uncommitted work gone, and a phantom
`.git/worktrees/build` registration left pointing at a directory that no longer exists.

**How it holds.** Ordering bugs are easy to reintroduce, so the rule is enforced **twice**,
independently: once in the walk, where a worktree is skipped before its name is ever
matched, and again at the deletion boundary, where any candidate whose `.git` is a file is
refused outright.

**And the fixtures matter as much as the code.** A test whose worktree is named
`namespace-foundation` passes while the invariant is broken — which is exactly how this
defect survives review. The fixtures therefore include worktrees named `build`, `target`
and `dist`, plus a case driven through a real `git worktree add build feature`.

**The related case: a repository sitting where an artifact was expected.** Checking only
for the *file* form of `.git` catches worktrees and walks straight past this:

```sh
git clone -b gh-pages git@github.com:you/site.git dist
```

Now `dist/` is a full repository. It is a completely standard deploy setup, and its
unpushed commits exist nowhere else. dev-cleaner refuses any candidate whose `.git` is a
**directory** too, with `contains-repository`, and that is the refusal the `site` row shows
in the README's example report.

**And the case inside the candidate.** `git worktree add build/wip` puts the checkout one
level down, where neither direct check sees it — trashing `build` would destroy it as a
side effect, with no refusal and no mention of it. So selected candidates are also scanned
breadth-first to depth 4 for a nested `.git` in either form.

That scan has a directory budget, and the budget produced its own defect. It was originally
2,000 directories, and exhaustion was treated as an *answer*: "no repository found". On the
reference machine, one 67 GB Rust `target/` holds 8,187 directories at depth ≤ 3 alone; the
budget was spent before the walk finished depth 3, so a repository below that was invisible
and the directory was trashed in silence. A guard that fails open on the largest
directories on the disk is not a guard. The budget is now 50,000 — about 4× the 11,423
directories that same `target/` presents at depth ≤ 4 — and exhaustion now returns
"unverified", which is reported as a refusal:

```
too large to verify: read 50000 directories without ruling out a git repository inside it,
so it is refused rather than risk trashing history
```

Two narrow exemptions, each as narrow as its reasoning. `node_modules` is exempt **by
name**, because git-installed npm dependencies leave `.git` directories throughout it, all
of them reproducible by a reinstall — a guard nobody can satisfy is a guard that gets
switched off. Caches are exempt entirely, because they are allowlisted by exact path, which
is a stronger claim than "we looked inside and saw nothing", and because `~/.pub-cache`
keeps every git-sourced Dart package as a full clone by design.

The `node_modules` exemption was previously written as the whole `deps` *category*, which
is a far larger set: `.venv`, `venv`, `vendor/bundle` and `Pods` are all `deps`. And
`pip install -e git+ssh://…#egg=mylib` — the documented way to work on a dependency in
place — leaves a full clone with unpushed commits at `.venv/src/mylib/.git`. The
category-wide exemption trashed it without a word under `--preset aggressive`. Mutation
testing found that one.

**Finally: the tool never removes a worktree at all**, only its artifact directories.
Removing one would break invariant 1 (a worktree directory is not in the artifact table, so
it is the only operation that could delete a path the allowlist does not name), corrupt git
state (leaving a prunable phantom registration, where trashing only `target/` leaves a
fully valid worktree), and constitute repository management rather than disk cleanup — a
different risk class with a different undo path. Worktree status is computed and displayed
as context for your decision. It informs; it never gates deletion.

---

## 7. Git subprocesses are hardened

**The rule.** Every `git` invocation is prefixed with

```
-c core.fsmonitor= -c core.hooksPath=/dev/null -c protocol.ext.allow=never
```

and run with `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`.

**The failure it exists to prevent.** dev-cleaner runs `git` with `cwd` set to directories
the *walk discovered* — which include repositories you merely downloaded rather than wrote.
A repository's own `.git/config` can set `core.fsmonitor` to an arbitrary command, and
`git status` executes it while refreshing the index.

That is arbitrary code execution during what the user believes is a read-only disk survey,
triggered by nothing more than having cloned something once. `core.hooksPath` is a second
vector; `log.showSignature` with `gpg.program` a third. `GIT_CONFIG_NOSYSTEM` additionally
drops `/etc/gitconfig`, and the prompt/askpass settings guarantee a scan can never block on
a credential dialogue.

**How it holds.** The defence is structural rather than diligent. Exactly **one** function
in the whole codebase invokes `git`, and it is the only place the hardening prefix appears.
There is no way to add a call site that forgets it, because there is no other way to call
git at all. "Miss one call site and the hole is open" is answered by having exactly one.

**How it is tested.** With a fixture whose `.git/config` sets `core.fsmonitor` to a script
that writes a sentinel file — and, crucially, with a companion test asserting that an
*unhardened* `git status` in that same fixture **does** write the sentinel. Without that
second test, the fixture could quietly stop being dangerous and the real test would keep
passing forever.

**Residual, stated rather than hidden.** `git status` can still run a repository's
`filter.<driver>.clean` when `.gitattributes` names one. Disabling that needs a wildcard
config override git does not offer. The three vectors above are closed; this one is known
and out of scope.

Everything else in the git layer fails closed in the direction that deletes less: an
uninterrogable repository yields no metadata rather than fabricated metadata, and a
`git status` that cannot be read reports *uncommitted changes* rather than a clean tree —
because "dirty" is what protects a project from being selected.

---

## 8. Post-run disclosure

**The rule.** Trashing does not reclaim space until the Trash is emptied, so the tool
reports what is now *in the Trash* rather than what was "freed", and offers to empty it.

**What it prevents.** A summary reading "freed 75G" is simply false, and the user who
believes it goes looking for space that is still sitting in `~/.Trash`, concludes the tool
lied, and stops trusting the rest of it. The disclosure is not a nicety — it is the only
thing that makes the reported number mean what it appears to mean.

**How it holds.** The disclosure sentence is part of the summary, not an appendix to it. It
is replaced — not softened — when the user has actually emptied the Trash from inside the
interface, because then it would be false in the other direction. A session that cleaned
nothing prints nothing at all: `dev-cleaner` used as a viewer is as quiet as `ls`.

Emptying the Trash is irreversible and covers files this tool never touched, so it sits
behind the whole Trash's size being displayed first and the user typing the word `empty` —
exact equality, never a prefix, and only when a total was actually disclosed, because an
empty offered without a figure is an offer the user cannot evaluate.

---

## Two properties that are not numbered, but are load-bearing

### Piping cannot delete

When stdout is not a terminal, dev-cleaner prints a static report and returns. It does not
prompt, does not render, and does not clean. There is deliberately **no `--dry-run` flag**:
a flag can be forgotten, a pipe cannot, and the failure mode of forgetting is the one this
tool must not have.

The branch that deletes is never entered, and the `trash` library itself is loaded lazily
inside the single function that performs a deletion — a function that branch never reaches.
This is asserted as a set of negatives (`runApp` not called, `clean` not called,
`scanStream` not called) rather than described in a comment.

### The list you see is the list the guards agreed to

The report shows what is *selected*; the deletion boundary decides what is *deletable*. If
those two are computed by different code, the tool promises space it then refuses — which
is what happened with the pnpm store, and is corrosive even when nothing is at risk.

So both the static report and the interactive confirmation run the selection through the
deletion boundary's **own** guard functions before consent is asked for — the report over
every row it prints, the interface over the set you chose the moment you press `enter`. It
is literally the same code, exported as a read-only predicate: the screen and the boundary are
two thin loops over one decision function, so a screen that says "fine" cannot be paired
with a boundary that refuses.

There is exactly one direction in which they can differ, and it is stated rather than
papered over: no read-only check can know whether trashing will *fail* at the moment of
deletion (EPERM, a vanished directory, a full trash). A `node_modules` that fails that way
makes a later store prune unsafe, so the run can produce one refusal no screen predicted.
Reality can only add refusals, never remove them, and that is the safe direction.

Screening is also a snapshot. A symlink created between the screen and the run is caught by
the run — which is exactly why the boundary keeps its own checks rather than trusting the
screen's.

---

## How these are tested

Every invariant has fixtures that build the dangerous shape on a real filesystem, not a
mock — filesystem interpretation is most of what this tool *is*, so mocking it would test
the wrong thing. A representative sample of what is actually constructed:

- a symlink pointing at `$HOME`, a cache with a symlinked parent component, an artifact
  reached through a symlinked subdirectory, a symlink cycle;
- a project root equal to `$HOME`, a scan root of `/`, a `$HOME` reachable only because
  `os.homedir()` and its realpath differ;
- linked worktrees named `build`, `target` and `dist`; a worktree nested inside another
  worktree; a *dormant* worktree inside an *active* parent;
- a `dist/` that is a git clone; a repository nested inside a candidate;
- a `.git/config` that executes a sentinel-writing command, plus a control proving the
  fixture is genuinely dangerous;
- a store prune attempted after a `node_modules` that failed, after one that was refused,
  and after one that was never selected at all.

`clean.ts` is tested with an injected trash function, so the suite exercises the real guard
code and the real ordering while nothing is ever actually deleted. The only difference
between the shipped path and the tested path is that one function.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the house rule that keeps these tests honest.

---

## Reporting a safety problem

If dev-cleaner ever offers to delete something it should not have — or refuses to explain
why it refused something — that is the most valuable bug report this project can receive.
Please open an issue at <https://github.com/codevalley/dev-cleaner/issues> with the row it
showed, the refusal text if there was one, and the shape of the directory involved.
