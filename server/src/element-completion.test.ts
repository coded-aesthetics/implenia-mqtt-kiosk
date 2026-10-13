import { describe, it, expect, vi } from 'vitest';
import {
  COMPLETION_SENTINEL_DATE,
  assertBatchAccepted,
  completionBody,
  completionStamp,
  writeElementCompletion,
} from './element-completion.js';

const fetchImplenia = vi.fn();

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: (...args: unknown[]) => fetchImplenia(...args),
}));

// The id resolution and its stale-id retry have their own suite.
vi.mock('./element-device.js', () => ({
  withElementDevice: (_name: string, write: (id: string) => Promise<unknown>) =>
    write('device-1'),
}));

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

/**
 * The platform rejecting the write inside an HTTP 200.
 *
 * `readings/batch` resolves string sensors by name and fails the reading when
 * it does not know the name — `failed_count: 1` in a 200 body, transaction
 * committed, nothing written. Only the status code was ever checked, so the
 * single write the whole completion contract rests on could do nothing while
 * the kiosk logged it as done: the element stays unfinished on the platform
 * and implenia-web, seeing no new stamp, never re-materializes its derived
 * values.
 */
describe('a batch write the platform did not accept', () => {
  it('rejects a response that failed every reading', () => {
    expect(() => assertBatchAccepted({
      success: false,
      processed_count: 0,
      failed_count: 1,
      results: [{
        sensor_name: 'Ausführungsdatum',
        sensor_type: 'string',
        success: false,
        error: 'sensor not found or not owned by measuring device: no rows in result set',
      }],
    } as Parameters<typeof assertBatchAccepted>[0], 'Ausführungsdatum'))
      .toThrow(/Ausführungsdatum/);
  });

  it('names the sensor and the platform\'s own reason', () => {
    try {
      assertBatchAccepted(
        { success: false, failed_count: 1, results: [{ success: false, error: 'no rows' }] },
        'Ausführungsdatum',
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      // The manual Fertigmeldung route wraps this in German and appends it in
      // parentheses for service personnel, so it has to say which sensor and
      // why — „Fertigmeldung fehlgeschlagen" alone sends nobody anywhere.
      expect((err as Error).message).toContain('Ausführungsdatum');
      expect((err as Error).message).toContain('no rows');
    }
  });

  it('accepts the shapes that mean it landed', () => {
    expect(() => assertBatchAccepted(
      { success: true, failed_count: 0, results: [{ success: true }] }, 'Ausführungsdatum',
    )).not.toThrow();
    // A backend predating these fields said nothing and meant success.
    expect(() => assertBatchAccepted({}, 'Ausführungsdatum')).not.toThrow();
    expect(() => assertBatchAccepted(null, 'Ausführungsdatum')).not.toThrow();
  });

  it('is wired into the write, not just available next to it', async () => {
    fetchImplenia.mockReset();
    fetchImplenia.mockResolvedValue({
      success: false,
      failed_count: 1,
      results: [{ sensor_name: 'Ausführungsdatum', success: false, error: 'sensor not found' }],
    });

    await expect(
      writeElementCompletion('P-01', 'Ausführungsdatum', completionStamp()),
    ).rejects.toThrow(/Ausführungsdatum/);

    // And a write the platform took does not throw.
    fetchImplenia.mockResolvedValue({ success: true, failed_count: 0, results: [] });
    await expect(
      writeElementCompletion('P-01', 'Ausführungsdatum', ''),
    ).resolves.toBeUndefined();
  });
});
