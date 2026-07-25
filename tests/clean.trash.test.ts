/**
 * `systemTrash` — the one function in dev-cleaner that is *not* exercised by the rest of
 * the suite, because every other test injects a recording `TrashFn` instead.
 *
 * That seam is deliberate (nothing in CI may delete), but it leaves the shipped deletion
 * call itself unpinned, and one of its two arguments is load-bearing:
 *
 * `trash@9` defaults to `glob: true` and runs its input through globby before deleting.
 * Under that default a directory legitimately named `[legacy]-app` is not a path at all,
 * it is a character class matching `l-app`, `e-app`, `g-app`, `a-app`, `c-app`, `y-app`;
 * `!important` is a negation; `dist/{a,b}` is a brace expansion. The path handed to the
 * platform's trash would then be a *different* directory from the one the entire guard
 * layer in `clean.ts` just validated — containment, allowlist, symlink chain, worktree
 * check, all performed on a string that is no longer the string being deleted. It is the
 * single way the deletion can diverge from the decision.
 *
 * So these tests mock `trash` itself (the import in `systemTrash` is dynamic, which is why
 * a module mock is enough) and assert the two things that make the deletion mean what the
 * guards decided: the options object carries `glob: false`, and the path arrives
 * byte-for-byte as it was passed in.
 *
 * Nothing here deletes anything: the mock records and returns.
 */

import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clean, systemTrash } from '../src/clean.js';
import type { CleanOptions } from '../src/clean.js';
import type { ActivityScore, Artifact, CleanTarget, Project, ProjectType } from '../src/types.js';
import { dir, fixture, type Fixture } from './fixture.js';

interface TrashOptions {
  glob?: boolean;
}

interface TrashCall {
  input: string | readonly string[];
  options: TrashOptions | undefined;
  /** How many arguments `systemTrash` actually supplied. Omitting options is `glob: true`. */
  argc: number;
}

/**
 * Hoisted so the `vi.mock` factory — which vitest lifts above the imports — can close over
 * it. The recorder stands in for the real `trash` default export.
 */
const recorder = vi.hoisted(() => {
  const calls: Array<{
    input: string | readonly string[];
    options: { glob?: boolean } | undefined;
    argc: number;
  }> = [];
  return {
    calls,
    async trash(
      input: string | readonly string[],
      ...rest: [options?: { glob?: boolean }]
    ): Promise<void> {
      calls.push({ input, options: rest[0], argc: rest.length + 1 });
    },
  };
});

// Delegating rather than `default: recorder.trash`, so that the module's default export
// stays a live view of `recorder.trash` and a spy installed later is actually seen.
vi.mock('trash', () => ({
  default: async (
    input: string | readonly string[],
    ...rest: [options?: TrashOptions]
  ): Promise<void> => recorder.trash(input, ...rest),
}));

/** The recorded call, with an assertion that there was exactly one. */
function onlyCall(): TrashCall {
  expect(recorder.calls).toHaveLength(1);
  const call = recorder.calls[0];
  if (call === undefined) throw new Error('unreachable: length asserted above');
  return call;
}

/** `trash` accepts a string or an array; `systemTrash` must always hand it the array form. */
function pathsOf(call: TrashCall): readonly string[] {
  expect(Array.isArray(call.input)).toBe(true);
  return call.input as readonly string[];
}

beforeEach(() => {
  recorder.calls.length = 0;
});

describe('systemTrash', () => {
  it('disables globbing, so trash treats its input as paths and not as patterns', async () => {
    await systemTrash(['/tmp/dev/app/node_modules']);

    const call = onlyCall();
    // Passing no options at all is `glob: true` by default, so the option must be present
    // *and* false — `undefined` is the unsafe value spelled differently.
    expect(call.argc).toBe(2);
    expect(call.options).toBeDefined();
    expect(call.options?.glob).toBe(false);
  });

  it('passes a path full of glob metacharacters through byte-for-byte', async () => {
    // Every one of these is meaningful to globby: [] is a character class, ! a negation,
    // * and ? wildcards, {} a brace expansion, () an extglob group, \ an escape.
    const literal = '/tmp/dev/[legacy]-app/!important/{a,b}/we(ird)?*/+(x)/back\\slash/node_modules';

    await systemTrash([literal]);

    const call = onlyCall();
    const paths = pathsOf(call);
    expect(paths).toHaveLength(1);
    // toBe on strings is exact-character equality: no expansion, no escaping, no rewriting.
    expect(paths[0]).toBe(literal);
    expect(call.options?.glob).toBe(false);
  });

  it('preserves the order and multiplicity of a batch, and globs none of it', async () => {
    const batch = [
      '/tmp/dev/[a]/node_modules',
      '/tmp/dev/b/dist',
      '/tmp/dev/[a]/node_modules', // a duplicate must stay a duplicate, not be deduped
      '/tmp/dev/!c/target',
    ];

    await systemTrash(batch);

    const call = onlyCall();
    expect(pathsOf(call)).toEqual(batch);
    expect(call.options?.glob).toBe(false);
  });

  it('does not reach for trash at all when there is nothing to delete', async () => {
    await expect(systemTrash([])).resolves.toBeUndefined();
    expect(recorder.calls).toEqual([]);
  });

  it('propagates a failure from trash rather than reporting a phantom deletion', async () => {
    const boom = new Error('trash refused');
    const failing = vi.spyOn(recorder, 'trash').mockRejectedValueOnce(boom);
    try {
      await expect(systemTrash(['/tmp/dev/app/dist'])).rejects.toThrow('trash refused');
    } finally {
      failing.mockRestore();
    }
  });
});

/**
 * The same assertion made on the live path: `clean()` validates a target, then hands the
 * path it validated to `systemTrash`. This is the only test in the suite where the
 * production `TrashFn` is the one `clean` calls — the mock sits one layer lower, at the
 * `trash` package — so it is the only place the guarded path and the deleted path can be
 * compared end to end.
 */
describe('clean() through the production systemTrash', () => {
  const DORMANT: ActivityScore = { status: 'dormant', idleMs: 0, reason: 'test fixture' };
  const PROJECT_DIR = '[legacy]-app';

  let fx: Fixture;
  let project: Project;
  let artifact: Artifact;
  let options: CleanOptions;

  beforeAll(async () => {
    // A real directory whose real name is a glob pattern. Under `glob: true` the string
    // below would resolve against the filesystem instead of being taken literally.
    fx = await fixture({
      [`${PROJECT_DIR}/package.json`]: '{"name":"legacy-app"}',
      [`${PROJECT_DIR}/node_modules/left-pad/index.js`]: 'module.exports = 0;\n',
      // A sibling the character class `[legacy]-app` would match if globbing were on.
      'l-app/package.json': '{"name":"l-app"}',
      'l-app/node_modules': dir(),
    });

    const root = fx.path(PROJECT_DIR);
    artifact = {
      path: path.join(root, 'node_modules'),
      relPath: 'node_modules',
      category: 'deps',
      bytes: 4096,
    };
    project = {
      root,
      name: PROJECT_DIR,
      types: new Set<ProjectType>(['node']),
      artifacts: [artifact],
      bytes: artifact.bytes,
      activity: DORMANT,
    };
    options = {
      trash: systemTrash,
      roots: [fx.root],
      allowedCachePaths: [],
      unselectedNodeModules: [],
    };
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('hands trash the exact path the guards approved, with globbing off', async () => {
    // Fail closed. This is the one test that points the production `TrashFn` at a real
    // directory, so before that happens, prove the module mock is actually in place: a
    // recorded call for a path that does not exist is something only the mock can produce.
    await systemTrash([fx.path('mock-probe-does-not-exist')]);
    expect(recorder.calls).toHaveLength(1);
    recorder.calls.length = 0;

    const target: CleanTarget = { kind: 'project', project, artifact };

    const outcomes = await clean([target], options);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['trashed']);

    const call = onlyCall();
    const paths = pathsOf(call);
    // The literal path of the artifact that was validated — not a pattern, and in
    // particular not the sibling `l-app/node_modules` that `[legacy]-app` also matches.
    expect(paths).toEqual([artifact.path]);
    expect(paths[0]).toContain(`${path.sep}${PROJECT_DIR}${path.sep}`);
    expect(paths[0]).not.toContain(`${path.sep}l-app${path.sep}`);
    expect(call.options?.glob).toBe(false);
  });
});
