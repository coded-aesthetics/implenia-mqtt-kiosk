import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn().mockResolvedValue({}),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('./herstellen-sensors.js', () => ({
  fetchHerstellenSensors: vi.fn(),
}));

let db: typeof import('./db.js');
let recording: typeof import('./recording.js');
let apiFn: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  db = await import('./db.js');
  recording = await import('./recording.js');
  const api = await import('./implenia-api.js');
  apiFn = api.fetchImplenia as ReturnType<typeof vi.fn>;

  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

function createSessionWithReadings(
  readings: Array<{ valueNumeric: number | null; valueText: string | null }>,
): number {
  const sensorMap = {
    testsensor: { sensorId: 'sensor-abc', sensorType: 'float' },
  };
  const sessionId = db.createSession('test-element', JSON.stringify(sensorMap));
  db.endSession(sessionId);
  const baseTime = Date.now();
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    db.insertSessionReading(
      sessionId, 'testsensor', 'sensor-abc', 'float',
      r.valueNumeric, r.valueText, { receivedAt: baseTime + i },
    );
  }
  return sessionId;
}

describe('uploadSession', () => {
  it('filters null readings from the batch payload', async () => {
    const sessionId = createSessionWithReadings([
      { valueNumeric: 1.5, valueText: null },
      { valueNumeric: null, valueText: null },
      { valueNumeric: 3.0, valueText: null },
    ]);

    apiFn.mockResolvedValueOnce({});
    await recording.uploadSession(sessionId);

    expect(apiFn).toHaveBeenCalledOnce();
    const [, opts] = apiFn.mock.calls[0];
    const payload = opts.body.readings as Array<{ value: unknown }>;
    expect(payload).toHaveLength(2);
    expect(payload.every((r: { value: unknown }) => r.value !== null)).toBe(true);
    expect(payload[0].value).toBe(1.5);
    expect(payload[1].value).toBe(3.0);
  });

  it('skips API call when all readings are null', async () => {
    apiFn.mockClear();

    const sessionId = createSessionWithReadings([
      { valueNumeric: null, valueText: null },
      { valueNumeric: null, valueText: null },
    ]);

    const result = await recording.uploadSession(sessionId);

    expect(apiFn).not.toHaveBeenCalled();
    expect(result.status).toBe('uploaded');
  });

  it('marks all readings as uploaded after success', async () => {
    apiFn.mockClear();
    apiFn.mockResolvedValueOnce({});

    const sessionId = createSessionWithReadings([
      { valueNumeric: 5.0, valueText: null },
      { valueNumeric: null, valueText: null },
    ]);

    await recording.uploadSession(sessionId);

    const stats = db.getSessionStats(sessionId);
    expect(stats.uploaded).toBe(2);
    expect(stats.pending).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('deduplicates readings with the same timestamp, keeping the last value', async () => {
    apiFn.mockClear();
    apiFn.mockResolvedValueOnce({});

    const sensorMap = {
      testsensor: { sensorId: 'sensor-abc', sensorType: 'float' },
    };
    const sessionId = db.createSession('test-dedup', JSON.stringify(sensorMap));
    db.endSession(sessionId);

    const now = Date.now();
    // Three readings sharing the same millisecond timestamp
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 1.0, null, { receivedAt: now });
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 2.0, null, { receivedAt: now });
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 3.0, null, { receivedAt: now });
    // One reading at a different timestamp
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 4.0, null, { receivedAt: now + 1 });

    await recording.uploadSession(sessionId);

    expect(apiFn).toHaveBeenCalledOnce();
    const [, opts] = apiFn.mock.calls[0];
    const payload = opts.body.readings as Array<{ date: string; value: number }>;
    expect(payload).toHaveLength(2);
    // Last value for the duplicate timestamp wins
    expect(payload[0].value).toBe(3.0);
    expect(payload[1].value).toBe(4.0);

    // All 4 DB rows marked as uploaded
    const stats = db.getSessionStats(sessionId);
    expect(stats.uploaded).toBe(4);
    expect(stats.pending).toBe(0);
  });
});
