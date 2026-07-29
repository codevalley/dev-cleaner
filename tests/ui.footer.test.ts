import { describe, expect, it } from 'vitest';

import { hintsFor, KEY_HINTS } from '../src/ui/Footer.js';

it('home promotes enter reclaim and browse', () => {
  expect(hintsFor('home')).toMatch(/enter/);
  expect(hintsFor('home')).toMatch(/b /);
  expect(hintsFor('home')).not.toMatch(/j\/k/);
});

it('triage keeps list keys and esc home', () => {
  const h = hintsFor('triage');
  expect(h).toMatch(/space/);
  expect(h).toMatch(/esc home/);
  expect(h).toMatch(/d detail/);
});

it('confirm is only enter/esc', () => {
  expect(hintsFor('confirm')).toMatch(/enter confirm/);
  expect(hintsFor('confirm')).toMatch(/esc/);
});

describe('hintsFor exact strings', () => {
  it('locks home hints', () => {
    expect(hintsFor('home')).toBe(
      'enter reclaim · b browse · p preset · t Trash · q quit',
    );
  });

  it('locks triage hints', () => {
    expect(hintsFor('triage')).toBe(
      'space toggle · a section · j/k move · d detail · p preset · enter clean · esc home · t Trash · q quit',
    );
  });

  it('locks detail hints', () => {
    expect(hintsFor('detail')).toBe('esc back · q quit');
  });

  it('locks confirm hints', () => {
    expect(hintsFor('confirm')).toBe('enter confirm · esc back · q quit');
  });

  it('locks done hints', () => {
    expect(hintsFor('done')).toBe('esc home · t Trash · q quit');
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
