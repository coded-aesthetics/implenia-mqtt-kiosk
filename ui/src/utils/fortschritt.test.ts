import { describe, it, expect } from 'vitest';
import { fortschrittText } from './fortschritt';

describe('what an element tile says about a pillar already recorded here', () => {
  it('states the depth reached, in German', () => {
    expect(fortschrittText(6.2)).toBe('bis 6,20 m');
    expect(fortschrittText(12)).toBe('bis 12,00 m');
    expect(fortschrittText(1234.5678)).toBe('bis 1.234,57 m');
  });

  it('says "begonnen" rather than a depth of zero', () => {
    // Both a session that drilled nothing and one whose depth has not been
    // computed yet arrive as 0, and „0,00 m" would read as a measurement.
    expect(fortschrittText(0)).toBe('begonnen');
  });

  it('says "begonnen" for anything that is not a usable depth', () => {
    expect(fortschrittText(NaN)).toBe('begonnen');
    expect(fortschrittText(-1)).toBe('begonnen');
    expect(fortschrittText(undefined as unknown as number)).toBe('begonnen');
  });
});
