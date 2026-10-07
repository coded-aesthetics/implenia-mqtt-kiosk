import { describe, it, expect } from 'vitest';
import {
  COMPLETION_SENTINEL_DATE,
  completionBody,
  completionStamp,
} from './element-completion.js';

/**
 * These assertions encode the cross-project contract (see CLAUDE.md →
 * "Element completion"). Breaking one of them breaks the rework path in
 * implenia-machine-backend and the re-materialization of derived values in
 * implenia-web, not just this kiosk.
 */
describe('element completion payload', () => {
  it('dates every write at the shared sentinel, not "now"', () => {
    expect(COMPLETION_SENTINEL_DATE).toBe('2000-01-01T00:00:00Z');
    expect(completionBody('Ausführungsdatum', completionStamp()).timestamp)
      .toBe(COMPLETION_SENTINEL_DATE);
    expect(completionBody('Ausführungsdatum', '').timestamp)
      .toBe(COMPLETION_SENTINEL_DATE);
  });

  it('clears with an empty string, never null', () => {
    const body = completionBody('Ausführungsdatum', '');
    expect(body.string_sensors['Ausführungsdatum']).toBe('');
    // A null here is a 422 from the batch endpoint, which types
    // string_sensors as map[string]string.
    expect(body.string_sensors['Ausführungsdatum']).not.toBeNull();
  });

  it('stamps completion with a full ISO 8601 instant', () => {
    expect(completionStamp(new Date('2026-10-06T22:30:00Z')))
      .toBe('2026-10-06T22:30:00.000Z');
    expect(completionBody('Ausführungsdatum', completionStamp(new Date('2026-05-20T06:00:00Z'))))
      .toEqual({
        string_sensors: { 'Ausführungsdatum': '2026-05-20T06:00:00.000Z' },
        timestamp: COMPLETION_SENTINEL_DATE,
      });
  });

  it('gives two uploads on the same day distinct stamps', () => {
    // This is the whole point of a timestamp over a date: implenia-web compares
    // the stamp against the one it materialized from, so an element appended to
    // twice in one shift must not write the same value twice.
    const first = completionStamp(new Date('2026-10-06T08:15:00Z'));
    const second = completionStamp(new Date('2026-10-06T14:41:03Z'));
    expect(second).not.toBe(first);
    expect(first.slice(0, 10)).toBe(second.slice(0, 10));
  });
});
