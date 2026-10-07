import { describe, it, expect, vi, afterEach } from 'vitest';
import { needsGeologyConfirmation, shouldConfirmGeology } from './geology-stop';

/**
 * Whether Beenden routes through the geology sign-off.
 *
 * The bias is the point: every uncertain case stops the recording normally.
 * Showing the sign-off when it was not warranted is an annoyance; refusing to
 * stop is a shift of measurements stuck behind a screen.
 */

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(impl));
}

describe('needsGeologyConfirmation', () => {
  it('confirms a drilled session on a geology-capable machine', () => {
    expect(needsGeologyConfirmation({ verfuegbar: true, gebohrt: true })).toBe(true);
  });

  it('skips a machine that records no geology', () => {
    expect(needsGeologyConfirmation({ verfuegbar: false, gebohrt: true })).toBe(false);
  });

  it('skips a session that never drilled', () => {
    expect(needsGeologyConfirmation({ verfuegbar: true, gebohrt: false })).toBe(false);
  });

  it('skips anything it cannot read', () => {
    expect(needsGeologyConfirmation(null)).toBe(false);
    expect(needsGeologyConfirmation({})).toBe(false);
    // Truthy-but-not-true must not pass: a string "true" is a malformed body.
    expect(needsGeologyConfirmation({ verfuegbar: 'true', gebohrt: 'true' })).toBe(false);
  });
});

describe('shouldConfirmGeology', () => {
  it('asks the server about that session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ verfuegbar: true, gebohrt: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await shouldConfirmGeology(42)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/recording/42/geology-context');
  });

  it('stops normally when the server errors', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    expect(await shouldConfirmGeology(1)).toBe(false);
  });

  it('stops normally when the kiosk server is unreachable', async () => {
    stubFetch(() => Promise.reject(new Error('Failed to fetch')));
    expect(await shouldConfirmGeology(1)).toBe(false);
  });

  it('stops normally when the response is not JSON', async () => {
    stubFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.reject(new Error('Unexpected token')),
    }));
    expect(await shouldConfirmGeology(1)).toBe(false);
  });
});
