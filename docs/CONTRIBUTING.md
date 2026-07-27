# Contributing

Thank you for looking. Issues and pull requests are welcome — and a report of anything
dev-cleaner offered to delete that it should not have is the most valuable thing this
project can receive.

## Getting set up

```sh
git clone https://github.com/codevalley/dev-cleaner.git
cd dev-cleaner
npm install
```

Node ≥ 20. The project is ESM-only TypeScript, `strict` with `noUncheckedIndexedAccess`,
and compiles to `dist/`.

```sh
npm test             # vitest run — the whole suite
npm run typecheck    # tsc over src + tests, no emit
npm run build        # tsc -> dist/
```

Both must be clean before anything is merged. The suite is large — 43 files and a little
under a thousand cases at the time of writing — and the whole of it runs in about
15 seconds, so there is no reason not to run it.

Run a single file or a single case while you work:

```sh
npx vitest run tests/clean.safety.test.ts
npx vitest run -t 'refuses a cache whose PARENT component is a symlink'
```

Confirm the *count* of files executed, not just that the run is green. A mismatched
`include` glob silently runs a subset and still reports success.

## Layout

| Path | Holds |
| --- | --- |
| `src/detect.ts` | Marker files in a directory → set of project types |
| `src/artifacts.ts` | The artifact table (the allowlist), pattern matching, dedup |
| `src/discover.ts` | The walk: roots, roll-up, worktrees, pruning, root guards |
| `src/size.ts` | Directory sizing (`du -sk` with a Node walker fallback) |
| `src/git.ts` | Git metadata — and the only place `git` is ever invoked (see invariant 7) |
| `src/activity.ts` | Signals → dormancy score |
| `src/caches.ts` | Per-platform global cache table |
| `src/clean.ts` | The deletion boundary: guards, ordering, screening |
| `src/scan.ts` | Composes the above into an event stream |
| `src/report.ts`, `src/cli.ts` | Static report, argument parsing, entry point |
| `src/ui/*` | Ink components |
| `tests/` | Every test. None lives in `src/`. |

Dependencies flow one way. `src/types.ts` owns every shared type; a module may define types
used only inside itself, but never redeclare one from `types.ts`.

Runtime dependencies are `ink`, `react` and `trash`, and that list is not open for
expansion without a good reason. A tool that deletes files should be auditable in an
afternoon.

## Test-driven, and not as a slogan

Write the test first, run it and watch it fail for the right reason, then make it pass.
This project was built that way from the spec down, one module at a time — the
implementation plan in `docs/superpowers/plans/` literally alternates *"write the test /
run it, expected: FAIL / write the module / run it, expected: PASS"* for all thirteen
tasks.

It matters more than usual here. A test written after the code tends to describe the code,
and a guard described by its own implementation is a guard that nothing is actually
checking — see [the house rule](#the-house-rule) below.

Two conventions that matter more here than in most codebases:

**Fixtures over mocks.** Filesystem interpretation is most of what this tool *is*, so it is
tested against a real filesystem. `tests/fixture.ts` builds a real temporary tree from a
declarative spec:

```ts
const f = await fixture({
  'proj/package.json': '{}',                            // string -> file with content
  'proj/node_modules': dir(),                           // empty directory
  'proj/target/big.bin': file('x', { size: 1e6 }),      // exact byte size
  'proj/link': symlink(os.homedir()),                   // real symlink, never followed
  'proj/build': worktree('/repo/.git/worktrees/build'), // .git FILE, i.e. a worktree
});
```

Mocking `fs` here would test that the mock behaves as you imagined, which is exactly the
assumption every bug in this class is made of.

**Nothing in the suite deletes anything.** `clean.ts` takes its trash function as an
argument, and the tests inject a recorder. The shipped path and the tested path differ in
that one function and nothing else, so the real guards and the real ordering are exercised
on every run while your disk is never at risk.

## The house rule

> **Every safety guard needs a test that constructs the DANGEROUS case.**
>
> **And the way to check that a test is real is to delete the guard and confirm the test
> fails.**

A test that only builds the safe shape proves nothing. It executes the guard's line, it
turns green, it counts towards coverage — and the guard could be deleted outright without
anything noticing. That is not a gap in coverage; it is a gap in *discrimination*, and it
is the defect class that produces exactly these holes.

Concretely, before you claim a guard is tested:

1. Comment out the guard.
2. Run the suite.
3. If it still passes, your test is decorative. Go and build the input where the guard and
   its absence give different answers.
4. Put the guard back.

The fixtures have to be adversarial in the same spirit. A test whose worktree is named
`namespace-foundation` passes while the worktree-ordering invariant is broken, because that
name is not in the artifact table. The fixture has to be named `build`, `target` or `dist`
— the names an ordering slip would actually destroy. This is exactly how such a defect
survives review.

A related trick worth copying: where a fixture is supposed to be *dangerous*, add a control
test proving that it is. `tests/git.test.ts` asserts both that a hardened `git status`
leaves no sentinel file **and** that an unhardened one in the same fixture writes it.
Without the second test, the fixture could quietly stop being dangerous and the real test
would keep passing forever.

## Mutation testing

The house rule is easy to state and easy to believe you are following. Mutation testing is
how you find out.

The idea: break the code on purpose — flip a comparison, delete a condition, change a
constant — and see whether any test notices. A mutant that survives is a line the suite
executes but does not check.

It has been run against this codebase and it found real defects that a fully green suite
had missed. From one recorded sweep (at the time: 27 files, 435 tests, `tsc` clean, 123 of
150 mutants killed), five of them:

- the nested-repository scan exempted the whole `deps` **category** rather than the single
  directory name `node_modules`, so a `pip install -e git+…` clone at `.venv/src/<pkg>/.git`
  was trashed without a word under `--preset aggressive`;
- that scan's directory budget was 2,000, and exhausting it returned "no repository found"
  — so on the largest build trees on the disk the guard silently reported safe. It is now
  50,000, chosen by measuring a real 67 GB `target/` (11,423 directories at depth ≤ 4), and
  exhaustion now **refuses**;
- caches were being content-scanned, which permanently blocked `~/.pub-cache` — a cache
  that holds git clones by design — with no action the user could take to satisfy it;
- the store prune inferred safety from scan scope instead of asking the filesystem for
  incoming hardlinks;
- the confirmation transition was re-enterable, so a double-tapped `enter` could run a
  clean twice.

It also found guards that were *correct but unpinned* — see `tests/clean.pinning.test.ts`,
`tests/artifacts.pinning.test.ts`, `tests/discover.pinning.test.ts` and
`tests/git.pinning.test.ts`. Those files exist purely to build the inputs where a guard and
its broken form stop agreeing:

- containment compares against `ancestor + path.sep`; every fixture had unrelated sibling
  names, so dropping the separator answered identically. It stops answering identically the
  moment a sibling is `app-old` next to `app`.
- invariant 5 reads an artifact's real basename, never its display path; every fixture put
  `node_modules` directly at a project root, where the two are the same string. A pnpm
  workspace (`mono/packages/api/node_modules`) separates them.
- the store-prune predicate matches by cache id *or* by path shape, and the redundancy is
  deliberate; every fixture satisfied both arms at once, making each arm individually
  deletable while the suite stayed green.

The suite has grown a long way past 435 tests since that sweep, so treat the score above as
a historical record rather than a current claim. If you add or change a guard, mutate it
and see what happens before you send the PR.

## Pull requests

- One concern per PR. A safety change and a UI change in the same diff are hard to review
  and harder to revert.
- If you touch a numbered safety invariant, say which one in the commit message, and
  include the fixture that constructs the dangerous case.
- Prose in this repository is expected to be true. If a comment or a doc says a guard
  exists, the guard exists; if it says a case is out of scope, it is stated rather than
  hidden. Please keep it that way.
- Behaviour changes need a test that fails before and passes after. "Refactor, no
  behaviour change" needs the existing suite to be untouched.
- **Adding anything to the artifact table, the marker table or the cache table widens what
  the tool deletes**, and is never a patch release. Read
  [VERSIONING.md](VERSIONING.md) before you propose one, and add a `Now removes` entry to
  [CHANGELOG.md](../CHANGELOG.md) listing every directory name that becomes deletable.

## Deliberately out of scope

Some things are absent by decision, not oversight. Please don't send a PR adding them
without opening an issue first:

- **`--dry-run`.** Piping is the dry run. A flag can be forgotten; a pipe cannot. See
  [SAFETY.md](SAFETY.md).
- **Repository management of any kind.** No removing worktrees, no pruning worktree
  registrations, no deleting branches, no `git gc`. The tool deletes regenerable files and
  nothing else, and that boundary is what keeps the allowlist invariant true.
- **`--yes` / `--json` non-interactive modes.** Out of scope for v1; add if demand appears.
- **Restoring or rebuilding projects after cleaning.**

## Licence

By contributing you agree that your contributions are licensed under the MIT Licence, the
same as the rest of the project.
