import { describe, it, expect } from 'vitest';
import { parseRoute } from './useHashRouter';

describe('parseRoute', () => {
  it('defaults to home', () => {
    expect(parseRoute('').page).toBe('home');
    expect(parseRoute('#/').page).toBe('home');
  });

  it('parses the plain pages', () => {
    expect(parseRoute('#/config').page).toBe('config');
    expect(parseRoute('#/comments').page).toBe('comments');
  });

  it('parses an element name, decoded', () => {
    const r = parseRoute('#/element/H%2026');
    expect(r.page).toBe('element');
    expect(r.params.name).toBe('H 26');
  });

  // ── Setup routing: the wizard's step lives here now ─────────────────────

  it('treats bare /setup as the first step', () => {
    expect(parseRoute('#/setup')).toMatchObject({ page: 'setup', params: { step: 'verfahren' } });
  });

  it('carries the step through the URL', () => {
    for (const step of ['verfahren', 'transport', 'mqtt', 'serial', 'done']) {
      expect(parseRoute(`#/setup/${step}`)).toMatchObject({ page: 'setup', params: { step } });
    }
  });

  it('parses the sensor assignment route', () => {
    expect(parseRoute('#/sensors').page).toBe('sensors');
  });

  it('does not mistake a prefix for a setup route', () => {
    expect(parseRoute('#/setups').page).toBe('home');
    expect(parseRoute('#/element/setup').page).toBe('element');
  });

  it('keeps query params alongside a setup step', () => {
    const r = parseRoute('#/setup/mqtt?from=config');
    expect(r.page).toBe('setup');
    expect(r.params.step).toBe('mqtt');
    expect(r.query.from).toBe('config');
  });
});
