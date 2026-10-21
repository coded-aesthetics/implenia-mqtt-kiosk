import { describe, it, expect } from 'vitest';
import {
  cacheServesFailure, parseShiftCache, pruneCompleted, serialiseShiftCache,
  type ShiftCacheEntry,
} from './shift-cache.js';

function apiError(statusCode: number): Error {
  const err = new Error(`Implenia API ${statusCode}: nope`);
  (err as Error & { statusCode: number }).statusCode = statusCode;
  return err;
}

describe('serialise/parse', () => {
  it('round-trips the devices verbatim, vorgaben included', () => {
    const devices = [{ id: '1', name: 'P-01', vorgaben: { float_sensors: { Tiefe: 12 } } }];
    const raw = serialiseShiftCache(devices, 1_700_000_000_000);
    expect(parseShiftCache(raw!)).toEqual({
      fetchedAt: 1_700_000_000_000,
      measuring_devices: devices,
    });
  });

  it('refuses to cache anything that is not a device list', () => {
    expect(serialiseShiftCache(undefined, 1)).toBeNull();
    expect(serialiseShiftCache({ measuring_devices: [] }, 1)).toBeNull();
  });

  // An unreadable cache has to read as "no cache", not throw: the element list
  // then shows the connection error it would have shown anyway.
  it('treats junk, a missing list and a missing date as no cache', () => {
    expect(parseShiftCache(undefined)).toBeNull();
    expect(parseShiftCache('{')).toBeNull();
    expect(parseShiftCache('{"fetchedAt":1}')).toBeNull();
    expect(parseShiftCache('{"measuring_devices":[]}')).toBeNull();
  });
});

describe('cacheServesFailure', () => {
  it('serves the cache when the platform said nothing at all', () => {
    expect(cacheServesFailure(new Error('fetch failed'))).toBe(true);
    expect(cacheServesFailure(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('serves the cache on a 5xx — a broken backend is not an answer', () => {
    expect(cacheServesFailure(apiError(500))).toBe(true);
    expect(cacheServesFailure(apiError(502))).toBe(true);
    expect(cacheServesFailure(apiError(504))).toBe(true);
  });

  /*
   * The distinction the whole module turns on. A 404 is the platform saying
   * there is no shift assignment today, and answering that with yesterday's
   * list would invent work; a 401 is a key a technician has to fix, and a list
   * over the top of it hides the only message that leads anywhere.
   */
  it('does not serve the cache when the platform answered', () => {
    expect(cacheServesFailure(apiError(404))).toBe(false);
    expect(cacheServesFailure(apiError(401))).toBe(false);
    expect(cacheServesFailure(apiError(403))).toBe(false);
    expect(cacheServesFailure(apiError(422))).toBe(false);
  });

  it('does not serve the cache on a kiosk with no API configured', () => {
    expect(cacheServesFailure(new Error('Implenia API not configured'))).toBe(false);
  });
});

describe('pruneCompleted', () => {
  const entry: ShiftCacheEntry = {
    fetchedAt: 1_000,
    measuring_devices: [{ id: '1', name: 'P-01' }, { id: '2', name: 'P-02' }],
  };

  it('drops an element this kiosk uploaded after the list was taken', () => {
    const left = pruneCompleted(entry, [{ elementName: 'P-01', lastUpload: 2_000 }]);
    expect(left.map((d) => d.name)).toEqual(['P-02']);
  });

  // The platform's own list already excluded anything finished before it was
  // served, so an older completion says nothing new — and an element resumed
  // after that upload is legitimately back on the list.
  it('keeps an element whose upload predates the list', () => {
    const left = pruneCompleted(entry, [{ elementName: 'P-01', lastUpload: 500 }]);
    expect(left.map((d) => d.name)).toEqual(['P-01', 'P-02']);
  });

  it('returns the list untouched when nothing was finished since', () => {
    expect(pruneCompleted(entry, [])).toBe(entry.measuring_devices);
  });
});
