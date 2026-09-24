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

  // ── Config sub-routes ───────────────────────────────────────────────────

  it('parses bare #/config as the hub (no section)', () => {
    const r = parseRoute('#/config');
    expect(r).toMatchObject({ page: 'config', params: {} });
  });

  it('parses config sub-sections', () => {
    for (const section of ['verbindung', 'datenquelle', 'messwerte', 'system']) {
      expect(parseRoute(`#/config/${section}`)).toMatchObject({
        page: 'config',
        params: { section },
      });
    }
  });

  it('does not mistake a prefix for a config route', () => {
    expect(parseRoute('#/configs').page).toBe('home');
  });

  it('keeps query params on config sub-routes', () => {
    const r = parseRoute('#/config/verbindung?foo=bar');
    expect(r.page).toBe('config');
    expect(r.params.section).toBe('verbindung');
    expect(r.query.foo).toBe('bar');
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

  it('parses the rohrverlaengerung route', () => {
    expect(parseRoute('#/rohrverlaengerung').page).toBe('rohrverlaengerung');
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
