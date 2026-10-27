import { describe, expect, it } from 'vitest';

import { hintsFor, KEY_HINTS, TRIAGE_MORE_HINTS, fitHints } from '../src/ui/Footer.js';

it('home promotes arrow move, enter, browse, and empty Trash', () => {
  expect(hintsFor('home')).toMatch(/↑↓/);
  expect(hintsFor('home')).toMatch(/enter/);
  expect(hintsFor('home')).toMatch(/\? help/);
  expect(hintsFor('home')).toMatch(/q quit/);
  expect(fitHints(hintsFor('home'), 38)).toContain('? help');
});

it('triage explains every key and keeps help discoverable at narrow widths', () => {
  const h = hintsFor('triage') + ' · ' + TRIAGE_MORE_HINTS;
  for (const action of ['space toggle', '? help', 'inspect', 'enter review', 'q quit', 'a toggle section', 'p preset', 't Trash', 'esc home']) {
    expect(h).toContain(action);
  }
  expect(fitHints(hintsFor('triage'), 38)).toContain('? help');
  expect(fitHints(hintsFor('triage'), 38)).not.toContain('…');
});

it('confirm is only enter/esc', () => {
  expect(hintsFor('confirm')).toMatch(/enter confirm/);
  expect(hintsFor('confirm')).toMatch(/esc/);
});

describe('hintsFor exact strings', () => {
  it('locks home hints', () => {
    expect(hintsFor('home')).toBe(
      '↑↓ move · enter choose · ? help · q quit',
    );
  });

  it('locks triage hints', () => {
    expect(hintsFor('triage')).toBe(
      'space toggle · ? help · →/d inspect · enter review',
    );
  });

  it('locks detail hints', () => {
    expect(hintsFor('detail')).toBe('esc back · ↑↓ scroll · ? help · q quit');
  });

  it('locks confirm hints', () => {
    expect(hintsFor('confirm')).toBe('enter confirm · esc back · q quit');
  });

  it('locks done hints', () => {
    expect(hintsFor('done')).toBe('press any key · t empty Trash · q quit');
  });

  it('locks trash-confirm hints', () => {
    expect(hintsFor('trash-confirm')).toBe('esc cancel · ctrl+c quit');
  });

  it('locks screening hints', () => {
    expect(hintsFor('screening')).toBe('esc cancel · q quit');
  });

  it('locks cleaning hints', () => {
    expect(hintsFor('cleaning')).toBe('');
  });
});

describe('KEY_HINTS alias', () => {
  it('matches triage hints', () => {
    expect(KEY_HINTS).toBe(hintsFor('triage'));
  });
});
