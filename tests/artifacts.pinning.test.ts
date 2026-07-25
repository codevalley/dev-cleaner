/**
 * The two pruning rules in `resolveArtifacts`' walk, and which trees can tell them apart.
 *
 * ```ts
 * if (claims.length > 0) { …push…; continue; }   // rule 1: never descend into a claim
 * if (isArtifactBasename(name)) continue;        // rule 2: table-wide prune
 * ```
 *
 * They overlap nearly everywhere, and the overlap is why the existing fixtures score the
 * same with either one deleted. A tree separates them only when the pruned directory falls
 * in exactly one rule's territory.
 *
 * **Rule 2 alone** owns a directory whose basename is in the table but which *this*
 * project's types do not claim: `node_modules` under a python project, `build/` under a
 * rust one, `target/` under a node one. Nothing claims those, so rule 1 never fires and the
 * descent is rule 2's to stop — the difference between reporting this project's `dist/` and
 * reporting a dependency's `dist/` as this project's build output. Narrowing the prune from
 * the whole table to the project's own patterns fails these tests just as deleting it does.
 *
 * **Rule 1's `continue`** has no territory of its own *under the shipped table*: every name
 * a pattern can claim also answers `isArtifactBasename` — basenames and globs directly,
 * relative entries through their final component — so rule 2 stops every descent rule 1
 * would have stopped, and deleting rule 1 alone changes no output on any tree. The tests
 * below say so rather than pretending otherwise: the `claimed directories` group catches
 * the removal of *both* rules, and the last test pins the table property the redundancy
 * rests on. The day an entry claims a name the basename index does not recognise, rule 2
 * stops covering for rule 1 and that `continue` is all that keeps the walk out of a
 * `node_modules`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ARTIFACT_TABLE, isArtifactBasename, resolveArtifacts } from '../src/artifacts.js';
import type { Category, ProjectType } from '../src/types.js';
import { fixture, type Fixture } from './fixture.js';

const fixtures: Fixture[] = [];

async function tree(spec: Parameters<typeof fixture>[0]): Promise<Fixture> {
  const f = await fixture(spec);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const RECOMMENDED = (): Set<Category> => new Set<Category>(['build', 'cache']);
const AGGRESSIVE = (): Set<Category> => new Set<Category>(['build', 'deps', 'cache']);

/** `declarations` for the common case: one project root declaring one or more types. */
const declaring = (root: string, ...types: ProjectType[]): Map<string, Set<ProjectType>> =>
  new Map([[root, new Set<ProjectType>(types)]]);

/** Resolved candidates as sorted `/`-separated relative paths. */
async function relPathsOf(
  root: string,
  declarations: Map<string, Set<ProjectType>>,
  categories: Set<Category>,
): Promise<string[]> {
  const artifacts = await resolveArtifacts(root, declarations, categories);
  return artifacts.map((artifact) => artifact.relPath.split(/[\\/]/).join('/')).sort();
}

describe('table-wide prune (rule 2), on its own', () => {
  it("never walks node_modules to claim a dependency's dist as the project's", async () => {
    // python claims `dist`; nothing in python claims `node_modules`, so rule 1 never fires
    // on it and only the table-wide prune stops the descent — and directly below it sits a
    // directory whose basename python *does* claim.
    const f = await tree({
      'proj/pyproject.toml': '[project]\n',
      'proj/dist/app-1.0.whl': 'x',
      'proj/node_modules/bundler/package.json': '{}',
      'proj/node_modules/bundler/dist/index.js': 'x',
      'proj/node_modules/bundler/__pycache__/mod.pyc': 'x',
    });
    const root = f.path('proj');

    expect(await relPathsOf(root, declaring(root, 'python'), RECOMMENDED())).toEqual(['dist']);
    expect(await relPathsOf(root, declaring(root, 'python'), AGGRESSIVE())).toEqual(['dist']);
  });

  it('never walks a rust project into a build/ it does not claim', async () => {
    // `build` is in the table (node, flutter, xcode, gradle, python, cmake) but rust does
    // not claim it, so this project reports nothing at all — unless the prune is narrowed
    // to the project's own patterns, when `build/scripts/target` surfaces as rust output.
    const f = await tree({
      'proj/Cargo.toml': '[package]\n',
      'proj/src/main.rs': 'fn main() {}',
      'proj/build/scripts/target/tool.o': 'x',
    });
    const root = f.path('proj');

    expect(await relPathsOf(root, declaring(root, 'rust'), AGGRESSIVE())).toEqual([]);
  });

  it('never walks a node project into a target/ it does not claim', async () => {
    // The mirror image: `target` is rust's, and a node project must not mine someone
    // else's `target/debug` for its own `build` and `dist`.
    const f = await tree({
      'proj/package.json': '{}',
      'proj/target/debug/build/tool/out': 'x',
      'proj/target/debug/dist/lib.js': 'x',
    });
    const root = f.path('proj');

    expect(await relPathsOf(root, declaring(root, 'node'), AGGRESSIVE())).toEqual([]);
  });
});

describe('claimed directories are never walked through (rules 1 and 2 together)', () => {
  it("reports node_modules itself, never a nested package's dist or cache", async () => {
    // The classic shape. `node_modules` is claimed (rule 1) *and* in the table (rule 2);
    // removing either alone leaves the other holding the line. Removing both lets
    // `node_modules/pkg/dist` through as a `build` artifact, which survives the recommended
    // preset's category filter even though `node_modules` itself — `deps` — does not.
    const f = await tree({
      'proj/package.json': '{}',
      'proj/dist/index.js': 'x',
      'proj/node_modules/pkg/package.json': '{}',
      'proj/node_modules/pkg/dist/bundle.js': 'x',
      'proj/node_modules/pkg/.cache/v1': 'x',
    });
    const root = f.path('proj');

    expect(await relPathsOf(root, declaring(root, 'node'), RECOMMENDED())).toEqual(['dist']);
    expect(await relPathsOf(root, declaring(root, 'node'), AGGRESSIVE())).toEqual([
      'dist',
      'node_modules',
    ]);
  });

  it('reports target itself, never the build/ cargo writes inside it', async () => {
    // A crate that is also a node package: `target` is claimed by rust and `build` by node,
    // so with both rules gone `target/debug/build` is offered as a second candidate — a
    // path already covered by its own parent, double-counted in the total.
    const f = await tree({
      'proj/Cargo.toml': '[package]\n',
      'proj/package.json': '{}',
      'proj/target/debug/build/tool-1a2b/out': 'x',
      'proj/target/debug/deps/lib.rlib': 'x',
    });
    const root = f.path('proj');

    expect(await relPathsOf(root, declaring(root, 'node', 'rust'), AGGRESSIVE())).toEqual([
      'target',
    ]);
  });

  it('claims a relative-pattern directory without walking into it', async () => {
    // `app/build` is anchored to the declaring directory; `build` — its final component —
    // is what both rules see. Gradle output holding a `.gradle` cache must not contribute a
    // second candidate nested inside the first.
    const f = await tree({
      'proj/build.gradle': '',
      'proj/app/build/outputs/app.apk': 'x',
      'proj/app/build/.gradle/cache': 'x',
    });
    const root = f.path('proj');

    expect(await relPathsOf(root, declaring(root, 'gradle'), AGGRESSIVE())).toEqual(['app/build']);
  });

  it('stops at node_modules even when deps is not an enabled category', async () => {
    // Both rules are category-independent: `deps` is off, so `node_modules` is not
    // *reported*, but it is still not *walked*, and the `.turbo` inside a dependency never
    // becomes a cache candidate of this project's.
    const f = await tree({
      'proj/package.json': '{}',
      'proj/node_modules/left-pad/package.json': '{}',
      'proj/node_modules/left-pad/.turbo/log': 'x',
    });
    const root = f.path('proj');

    expect(await relPathsOf(root, declaring(root, 'node'), RECOMMENDED())).toEqual([]);
    expect(await relPathsOf(root, declaring(root, 'node'), AGGRESSIVE())).toEqual(['node_modules']);
  });
});

describe('the table property that makes rule 1 redundant', () => {
  it('recognises every name the table can claim as an artifact basename', async () => {
    // `resolveArtifacts` prunes a claimed directory twice over only because this holds. Let
    // a table entry claim a name `isArtifactBasename` does not recognise — a relative entry
    // whose final component is dropped from the basename index, say — and rule 2 stops
    // covering the claim, leaving rule 1's `continue` as the only thing between the walk
    // and the inside of that directory.
    const claimable: string[] = [];

    for (const row of Object.values(ARTIFACT_TABLE)) {
      for (const values of Object.values(row)) {
        for (const value of values) {
          const last = value.split('/').at(-1) ?? '';
          if (last === '') continue;
          // A glob claims names, not itself: instantiate `*` to something concrete.
          claimable.push(last.includes('*') ? last.split('*').join('sample') : last);
        }
      }
    }

    expect(claimable).toContain('bundle'); // final component of `vendor/bundle`
    expect(claimable).toContain('.symlinks'); // final component of `ios/.symlinks`
    expect(claimable).toContain('sample.egg-info'); // instantiation of `*.egg-info`
    expect(claimable.filter((name) => !isArtifactBasename(name))).toEqual([]);
  });
});
