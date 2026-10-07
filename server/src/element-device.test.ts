import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn(),
}));

import { fetchImplenia } from './implenia-api.js';
import { withElementDevice, forgetElementDevices } from './element-device.js';

const mockFetch = fetchImplenia as unknown as ReturnType<typeof vi.fn>;

function apiError(statusCode: number): Error {
  const err = new Error(`Implenia API ${statusCode}: nope`);
  (err as Error & { statusCode: number }).statusCode = statusCode;
  return err;
}

/** Resolve calls answer with a device id; writes go through the write callback. */
function resolvesTo(deviceId: string): void {
  mockFetch.mockResolvedValue({ device_id: deviceId });
}

describe('withElementDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetElementDevices();
  });

  it('resolves the element name once and reuses the id', async () => {
    resolvesTo('dev-1');
    const write = vi.fn().mockResolvedValue('ok');

    await withElementDevice('F-23', write);
    await withElementDevice('F-23', write);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/measuring-device/self/child/name:F-23/resolve',
    );
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith('dev-1');
  });

  it('encodes element names that need it', async () => {
    resolvesTo('dev-1');
    await withElementDevice('F 23/A', vi.fn().mockResolvedValue('ok'));

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/measuring-device/self/child/name:F%2023%2FA/resolve',
    );
  });

  it('re-resolves and retries when the element moved to a new device', async () => {
    mockFetch
      .mockResolvedValueOnce({ device_id: 'dev-old' })
      .mockResolvedValueOnce({ device_id: 'dev-new' });
    const write = vi
      .fn()
      .mockRejectedValueOnce(apiError(404))
      .mockResolvedValueOnce('ok');

    await expect(withElementDevice('F-23', write)).resolves.toBe('ok');

    expect(write).toHaveBeenNthCalledWith(1, 'dev-old');
    expect(write).toHaveBeenNthCalledWith(2, 'dev-new');
  });

  // A write rejected while the id is still current is a real failure (a
  // revoked key, a sensor that does not exist). Sending it again would risk a
  // duplicate reading for no reason.
  it('does not retry when re-resolving yields the same id', async () => {
    resolvesTo('dev-1');
    const write = vi.fn().mockRejectedValue(apiError(401));

    await expect(withElementDevice('F-23', write)).rejects.toThrow('Implenia API 401');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not retry on failures unrelated to the device id', async () => {
    resolvesTo('dev-1');
    const write = vi.fn().mockRejectedValue(apiError(422));

    await expect(withElementDevice('F-23', write)).rejects.toThrow('Implenia API 422');
    expect(write).toHaveBeenCalledTimes(1);
    // The cached id survives — a 422 says nothing about the device.
    await withElementDevice('F-23', vi.fn().mockResolvedValue('ok'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports the write error when re-resolving fails too', async () => {
    mockFetch
      .mockResolvedValueOnce({ device_id: 'dev-1' })
      .mockRejectedValueOnce(apiError(404));
    const write = vi.fn().mockRejectedValue(apiError(404));

    await expect(withElementDevice('F-23', write)).rejects.toThrow('Implenia API 404: nope');
  });

  it('fails with a German, actionable message when the element is unknown', async () => {
    mockFetch.mockResolvedValue({});

    await expect(
      withElementDevice('F-99', vi.fn()),
    ).rejects.toThrow(/nicht auffindbar.*Schichtauftrag/s);
  });
});
