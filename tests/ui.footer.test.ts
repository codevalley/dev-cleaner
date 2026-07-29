import { describe, expect, it } from 'vitest';

import { hintsFor, KEY_HINTS } from '../src/ui/Footer.js';

it('home promotes arrow move, enter, browse, and empty Trash', () => {
  expect(hintsFor('home')).toMatch(/↑↓/);
  expect(hintsFor('home')).toMatch(/enter/);
  expect(hintsFor('home')).toMatch(/b browse/);
  expect(hintsFor('home')).toMatch(/empty Trash/);
  expect(hintsFor('home')).toMatch(/q quit/);
  expect(hintsFor('home').indexOf('q quit')).toBeLessThan(hintsFor('home').indexOf('empty Trash'));
});

it('triage keeps list keys with q before the long tail', () => {
  const h = hintsFor('triage');
  expect(h).toMatch(/space toggle/);
  expect(h).toMatch(/↑↓\/jk/);
  expect(h).toMatch(/\bq\b/);
  expect(h).toMatch(/enter/);
  expect(h).toMatch(/esc/);
  // q must appear before trailing a/p/t so truncation keeps quit.
  expect(h.indexOf(' q ')).toBeLessThan(h.lastIndexOf(' t'));
});

it('confirm is only enter/esc', () => {
  expect(hintsFor('confirm')).toMatch(/enter confirm/);
  expect(hintsFor('confirm')).toMatch(/esc/);
});

describe('hintsFor exact strings', () => {
  it('locks home hints', () => {
    expect(hintsFor('home')).toBe(
      '↑↓ move · enter · q quit · b browse · t empty Trash',
    );
  });

  it('locks triage hints', () => {
    expect(hintsFor('triage')).toBe(
      '↑↓/jk · space toggle · enter · d · esc · q · a · p · t',
    );
  });

  it('locks detail hints', () => {
    expect(hintsFor('detail')).toBe('esc back · q quit');
  });

  it('locks confirm hints', () => {
    expect(hintsFor('confirm')).toBe('enter confirm · esc back · q quit');
  });

  it('locks done hints', () => {
    expect(hintsFor('done')).toBe('press any key · t empty Trash · q quit');
  });

  it('locks trash-confirm hints', () => {
    expect(hintsFor('trash-confirm')).toBe('esc cancel · q quit');
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
