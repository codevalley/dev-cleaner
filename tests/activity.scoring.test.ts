/**
 * The scoring thresholds themselves, which the README states as promises to the user.
 *
 * `gatherSignals` was tested from the start; `scoreActivity` was not, because it shipped as a
 * deliberate stub and its tests were written to assert on SIGNALS so they would survive the
 * body being authored. They survived it so completely that they never noticed it arrive:
 * a mutation sweep found `ACTIVE_DAYS = 30 → 400` and the removal of the entire dirty-tree
 * grace both left all 954 tests green.
 *
 * That matters more than an ordinary coverage gap. These two numbers decide what the tool
 * offers to delete by default, they are documented in the README as "30 days" and "90 days",
 * and a silent change to either would alter what a user's `enter` key does.
 */

import { describe, expect, it } from 'vitest';

import { scoreActivity, type ActivitySignals } from '../src/activity.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function signals(overrides: Partial<ActivitySignals> = {}): ActivitySignals {
  return {
    hasUncommittedChanges: false,
    newestSourceMs: NOW,
    newestArtifactMs: 0,
    ...overrides,
  };
}

const daysAgo = (days: number): number => NOW - days * DAY;

describe('the 30-day active threshold', () => {
  it('protects a project edited 29 days ago', () => {
    const score = scoreActivity(signals({ newestSourceMs: daysAgo(29) }), NOW);
    expect(score.status).toBe('active');
  });

  it('offers a project edited 31 days ago', () => {
    const score = scoreActivity(signals({ newestSourceMs: daysAgo(31) }), NOW);
    expect(score.status).toBe('dormant');
  });

  it('reports idle time as a real duration, not a status', () => {
    const score = scoreActivity(signals({ newestSourceMs: daysAgo(31) }), NOW);
    expect(score.idleMs).toBeGreaterThanOrEqual(31 * DAY);
    expect(score.idleMs).toBeLessThan(32 * DAY);
    expect(score.reason).toContain('edited');
  });
});

describe('the 90-day grace for uncommitted changes', () => {
  it('protects a dirty tree well past the ordinary threshold', () => {
    // 60 days is dormant when clean; the grace is the only thing holding it.
    const clean = scoreActivity(signals({ newestSourceMs: daysAgo(60) }), NOW);
    expect(clean.status).toBe('dormant');

    const dirty = scoreActivity(
      signals({ newestSourceMs: daysAgo(60), hasUncommittedChanges: true }),
      NOW,
    );
    expect(dirty.status).toBe('active');
    expect(dirty.reason).toContain('uncommitted');
  });

  it('stops protecting a dirty tree once the grace runs out', () => {
    // The grace is a benefit of the doubt, not immunity: a tree left dirty for years is
    // abandoned, not paused, and indefinite protection would let one forgotten stash-worth
    // of edits hold tens of gigabytes forever.
    const score = scoreActivity(
      signals({ newestSourceMs: daysAgo(120), hasUncommittedChanges: true }),
      NOW,
    );
    expect(score.status).toBe('dormant');
  });
});

describe('what does and does not count as activity', () => {
  it('does not count a recent build as recent work', () => {
    // The design decision this pins: a watch build, a dev server, a CI checkout or an
    // `npm install` touches artifacts without anyone deciding anything. Admitting that
    // signal marks every project you ever ran as permanently active — which is how a
    // cleaner ends up finding nothing to clean.
    const score = scoreActivity(
      signals({ newestSourceMs: daysAgo(200), newestArtifactMs: NOW }),
      NOW,
    );
    expect(score.status).toBe('dormant');
  });

  it('counts a commit even when the working tree is older', () => {
    const score = scoreActivity(
      signals({ newestSourceMs: daysAgo(200), lastCommitMs: daysAgo(2) }),
      NOW,
    );
    expect(score.status).toBe('active');
    expect(score.reason).toContain('committed');
  });

  it('counts a lockfile change as a deliberate act', () => {
    const score = scoreActivity(
      signals({ newestSourceMs: daysAgo(200), lockfileMs: daysAgo(3) }),
      NOW,
    );
    expect(score.status).toBe('active');
  });

  it('protects, and says so, when there is no date to score at all', () => {
    // "I cannot tell" must never render as "eight months dormant". A confident wrong number
    // is worse than an admission of ignorance, because the reason string is the user's only
    // insight into the verdict.
    const score = scoreActivity(
      signals({ newestSourceMs: 0, newestArtifactMs: 0 }),
      NOW,
    );
    expect(score.status).toBe('active');
    expect(score.idleMs).toBe(0);
    expect(score.reason).toMatch(/no dates/i);
  });
});
