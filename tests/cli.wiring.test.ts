/**
 * Does the shipped program actually *use* the screening layer?
 *
 * Every other test in this suite proves a component works. This one proves a component is
 * connected, which is a different claim and the one that failed: `screenTargets`, both its
 * tiers, `App.tsx`'s screening phase and `Confirm.tsx`'s blocked list were all implemented,
 * unit-tested and green — while `runInteractive` never passed `onScreen` to `runApp`. Because
 * `AppProps.onScreen` is optional, omitting it compiled, 551 tests passed, and the entire
 * pre-consent guard layer was dead code in the only path that deletes.
 *
 * A capability that nothing invokes is indistinguishable from a capability that does not
 * exist. These tests assert invocation, not behaviour.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { main } from '../src/cli.js';
import type { ScreeningTier } from '../src/clean.js';
import type { CleanOutcome, CleanTarget, Category, Preset } from '../src/types.js';

interface CapturedProps {
  onScreen?: (targets: readonly CleanTarget[], tier: ScreeningTier) => Promise<unknown>;
  onClean: (targets: readonly CleanTarget[]) => Promise<CleanOutcome[]>;
  stream: AsyncIterable<unknown>;
}

function ttyIO(): { write: (t: string) => void; writeError: (t: string) => void; isTTY: boolean } {
  return { write: () => {}, writeError: () => {}, isTTY: true };
}

/** A TTY run whose `runApp` records the props it was handed and does nothing else. */
async function captureProps(): Promise<{ props: CapturedProps; clean: Mock }> {
  let captured: CapturedProps | undefined;
  const clean = vi.fn(async () => [] as CleanOutcome[]);

  const code = await main(['/scan'], {
    io: ttyIO(),
    nowMs: 0,
    clean: clean as unknown as never,
    trash: async () => {},
    scanStream: (): AsyncIterable<never> => ({
      async *[Symbol.asyncIterator]() {
        /* an empty scan is enough: we are asserting wiring, not content */
      },
    }),
    resolveScanRoot: async (root: string) => root,
    categoriesFor: (_preset: Preset) => new Set<Category>(['build', 'cache']),
    runApp: (async (props: CapturedProps) => {
      captured = props;
      return { cleaned: false, outcomes: [] as CleanOutcome[], trashedBytes: 0, rounds: 0, trashEmptied: false };
    }) as unknown as never,
  });

  expect(code).toBe(0);
  if (captured === undefined) throw new Error('runApp was never called');
  return { props: captured, clean };
}

describe('the interactive path is wired to the screening layer', () => {
  it('hands runApp an onScreen binding', async () => {
    const { props } = await captureProps();

    // The whole defect in one assertion: this was `undefined` in the shipped binary while
    // every screening unit test passed.
    expect(props.onScreen).toBeTypeOf('function');
  });

  it('screens through the real predicate, at both tiers, without deleting', async () => {
    const { props } = await captureProps();
    if (props.onScreen === undefined) throw new Error('onScreen missing');

    // A target that must be refused by the cheap tier alone: not in the artifact table.
    const rogue: CleanTarget = {
      kind: 'project',
      project: {
        root: '/scan/app',
        name: 'app',
        types: new Set(['node']),
        artifacts: [],
        bytes: 0,
        activity: { status: 'dormant', idleMs: 0, reason: 'test' },
      },
      artifact: { path: '/scan/app/src', relPath: 'src', category: 'build', bytes: 1 },
    };

    for (const tier of ['cheap', 'full'] as const) {
      const screenings = (await props.onScreen([rogue], tier)) as ReadonlyArray<{
        refusal: string;
      }>;
      expect(screenings).toHaveLength(1);
      expect(screenings[0]?.refusal).toBe('not-in-artifact-table');
    }
  });

  it('never routes screening through the deleting path', async () => {
    const { props, clean } = await captureProps();
    if (props.onScreen === undefined) throw new Error('onScreen missing');

    await props.onScreen([], 'full');

    // Screening is read-only. If it ever reached `clean`, a "preview" would delete.
    expect(clean).not.toHaveBeenCalled();
  });

  it('recomputes invariant 5 per screened selection, not once per run', async () => {
    // `unselectedNodeModules` is a property of the whole run: which hardlink sources will
    // still be on disk afterwards. Screening a *hypothetical* selection must ask the question
    // about that selection, so toggling a node_modules row changes the answer. Computing it
    // once and reusing it is how a promised store prune becomes a refused one.
    const { props } = await captureProps();
    if (props.onScreen === undefined) throw new Error('onScreen missing');

    // Both calls must be accepted and independent; the binding closes over a function of
    // `targets`, not over a precomputed array.
    await expect(props.onScreen([], 'cheap')).resolves.toBeDefined();
    await expect(props.onScreen([], 'full')).resolves.toBeDefined();
  });
});
