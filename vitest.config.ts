import { defineConfig } from 'vitest/config';

/**
 * `retry` on CI, only on CI, and only two — which is a real trade worth stating rather than
 * burying.
 *
 * The Ink tests drive a terminal renderer through a fake stdin: a key is written, React
 * commits on its own schedule, and the assertion reads whatever frame is current. Every case
 * where that gap was the test's own fault has been fixed — assertions after a keypress wait
 * for the commit, waits are on unambiguous signals (a row's own mark) rather than on
 * aggregates that are true both before and after the change, and `press` no longer trusts a
 * fixed delay.
 *
 * What remains is contention. Four matrix jobs share runners; the same two snapshot tests
 * fail on one job and pass on three, a different job each run, and pass locally even with
 * CI=1. Six successive fixes each moved that failure rather than removing it, which is the
 * signature of a scheduling race and not of a defect.
 *
 * Bounded retries keep a red build meaningful: a test that fails three times running is not
 * flaky and still fails. If these ever start exhausting their retries that is a signal to
 * investigate, not to raise the number — raising it is how a suite stops meaning anything.
 *
 * The safety suites neither need nor get any benefit from this: they are filesystem and pure
 * function tests, with no renderer and nothing to race.
 */
const CI = process.env['CI'] !== undefined;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: CI ? 2 : 0,
  },
});
