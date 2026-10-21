import { describe, it, expect, beforeEach } from 'vitest';
import { apiHealth, healthFromOutcome } from './api-health.js';

function apiError(statusCode: number): Error {
  const err = new Error(`Implenia API ${statusCode}: nope`);
  (err as Error & { statusCode: number }).statusCode = statusCode;
  return err;
}

describe('healthFromOutcome', () => {
  it('counts a success as ok', () => {
    expect(healthFromOutcome(undefined)).toBe('ok');
  });

  /*
   * The one that is easy to get backwards: a 404 from the shift-assignment
   * endpoint is a *working* platform saying there is nothing for today. Read
   * as a failure it would put „Server offline" in the header of every kiosk
   * waiting for its shift assignment to be created.
   */
  it('counts any answered status as ok, 404 included', () => {
    expect(healthFromOutcome(apiError(404))).toBe('ok');
    expect(healthFromOutcome(apiError(409))).toBe('ok');
    expect(healthFromOutcome(apiError(422))).toBe('ok');
  });

  it('separates a refused key from a backend that is not there', () => {
    expect(healthFromOutcome(apiError(401))).toBe('rejected');
    expect(healthFromOutcome(apiError(403))).toBe('rejected');
    expect(healthFromOutcome(apiError(500))).toBe('unreachable');
    expect(healthFromOutcome(apiError(503))).toBe('unreachable');
    expect(healthFromOutcome(new Error('fetch failed'))).toBe('unreachable');
  });

  it('reports a kiosk with no API configured as its own state', () => {
    expect(healthFromOutcome(new Error('Implenia API not configured'))).toBe('unconfigured');
  });
});

describe('apiHealth tracker', () => {
  beforeEach(() => apiHealth.reset());

  it('starts out claiming nothing', () => {
    expect(apiHealth.getState()).toBe('unknown');
    expect(apiHealth.ageMs()).toBe(Infinity);
  });

  it('emits only on a change, so the websocket does not repeat itself', () => {
    const seen: string[] = [];
    const onChange = (s: string) => seen.push(s);
    apiHealth.on('change', onChange);

    apiHealth.noteOutcome();
    apiHealth.noteOutcome();
    apiHealth.noteOutcome(apiError(502));
    apiHealth.noteOutcome(new Error('fetch failed'));
    apiHealth.noteOutcome();

    apiHealth.off('change', onChange);
    expect(seen).toEqual(['ok', 'unreachable', 'ok']);
  });

  // The age is what throttles the active probe, and it has to advance on an
  // unchanged observation too — otherwise a kiosk that is answering fine every
  // few seconds would still probe every tick.
  it('counts an unchanged observation as an observation', () => {
    apiHealth.noteOutcome();
    expect(apiHealth.ageMs()).toBeLessThan(1_000);
    apiHealth.noteOutcome();
    expect(apiHealth.ageMs()).toBeLessThan(1_000);
  });
});
