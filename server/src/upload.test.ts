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
  it('uploads a non-numeric value on a float sensor as a gap', async () => {
    // A rig that formats its floats in C writes "nan", which lands in
    // value_text. Sent as a string it fails the backend's validation with a
    // 422 — and the backend rejects the *whole* batch, so one junk reading
    // costs up to CHUNK_SIZE good ones and drops the session to `partial`.
    apiFn.mockClear();
    const sessionId = createSessionWithReadings([
      { valueNumeric: 1.5, valueText: null },
      { valueNumeric: null, valueText: 'nan' },
      { valueNumeric: 3.0, valueText: null },
    ]);

    apiFn.mockResolvedValueOnce({});
    const result = await recording.uploadSession(sessionId);

    const [, opts] = apiFn.mock.calls[0];
    const payload = opts.body.readings as Array<{ value: unknown }>;
    expect(payload.map((p) => p.value)).toEqual([1.5, null, 3.0]);
    expect(result.status).toBe('uploaded');
  });

  it('sends a lone null between values (edge of its own run)', async () => {
    apiFn.mockClear();
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
    expect(payload).toHaveLength(3);
    expect(payload[0].value).toBe(1.5);
    expect(payload[1].value).toBeNull();
    expect(payload[2].value).toBe(3.0);
  });

  it('keeps first and last null of a consecutive run', async () => {
    apiFn.mockClear();
    const sessionId = createSessionWithReadings([
      { valueNumeric: 1.0, valueText: null },
      { valueNumeric: null, valueText: null },
      { valueNumeric: null, valueText: null },
      { valueNumeric: null, valueText: null },
      { valueNumeric: null, valueText: null },
      { valueNumeric: 2.0, valueText: null },
    ]);

    apiFn.mockResolvedValueOnce({});
    await recording.uploadSession(sessionId);

    expect(apiFn).toHaveBeenCalledOnce();
    const [, opts] = apiFn.mock.calls[0];
    const payload = opts.body.readings as Array<{ value: unknown }>;
    // 1.0, null (first), null (last), 2.0  — middle two nulls dropped
    expect(payload).toHaveLength(4);
    expect(payload[0].value).toBe(1.0);
    expect(payload[1].value).toBeNull();
    expect(payload[2].value).toBeNull();
    expect(payload[3].value).toBe(2.0);
  });

  it('uploads edge nulls when all readings are null', async () => {
    apiFn.mockClear();

    const sessionId = createSessionWithReadings([
      { valueNumeric: null, valueText: null },
      { valueNumeric: null, valueText: null },
      { valueNumeric: null, valueText: null },
    ]);

    apiFn.mockResolvedValueOnce({});
    const result = await recording.uploadSession(sessionId);

    expect(apiFn).toHaveBeenCalledOnce();
    const [, opts] = apiFn.mock.calls[0];
    const payload = opts.body.readings as Array<{ value: unknown }>;
    // First and last null kept
    expect(payload).toHaveLength(2);
    expect(payload[0].value).toBeNull();
    expect(payload[1].value).toBeNull();
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

  it('keeps clipped readings after a successful upload', async () => {
    // Clipping is a judgement the kiosk made from a threshold typed in on
    // site, and it is wrong often enough that releasing those readings is a
    // documented recovery path. The upload is exactly when a wrong threshold
    // becomes visible, so deleting them here would destroy the only copy of
    // data the operator can still ask for.
    apiFn.mockClear();
    apiFn.mockResolvedValueOnce({});

    const sensorMap = {
      testsensor: { sensorId: 'sensor-abc', sensorType: 'float' },
    };
    const sessionId = db.createSession('test-clip-keep', JSON.stringify(sensorMap));
    db.endSession(sessionId);

    const baseTime = Date.now();
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 1.0, null, { receivedAt: baseTime });
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 2.0, null, { receivedAt: baseTime + 1 });
    // Insert clipped readings directly
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 99.0, null, { receivedAt: baseTime + 2, clipped: true });
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 98.0, null, { receivedAt: baseTime + 3, clipped: true });

    const statsBefore = db.getSessionStats(sessionId);
    expect(statsBefore.clipped).toBe(2);
    expect(statsBefore.pending).toBe(2);

    await recording.uploadSession(sessionId);

    const statsAfter = db.getSessionStats(sessionId);
    expect(statsAfter.uploaded).toBe(2);
    expect(statsAfter.clipped).toBe(2);
    expect(statsAfter.total).toBe(4);

    // And they are still releasable afterwards.
    expect(db.unclipSessionReadings(sessionId)).toBe(2);
  });

  it('runs one upload when two callers race for the same session', async () => {
    // The stop route, the connectivity watcher and the boot sweep can all pick
    // the same session: `uploading` is only written once an attempt is already
    // underway. Two passes would send the same rows twice and then race on the
    // session's final status.
    apiFn.mockClear();
    apiFn.mockResolvedValue({});

    const sessionId = createSessionWithReadings([
      { valueNumeric: 1.0, valueText: null },
      { valueNumeric: 2.0, valueText: null },
    ]);

    const [first, second] = await Promise.all([
      recording.uploadSession(sessionId),
      recording.uploadSession(sessionId),
    ]);

    expect(apiFn).toHaveBeenCalledOnce();
    expect(first.status).toBe('uploaded');
    expect(second).toEqual(first);
    expect(db.getSessionById(sessionId)?.status).toBe('uploaded');
    expect(db.getSessionStats(sessionId).failed).toBe(0);
  });

  it('allows a retry once the first upload has finished', async () => {
    apiFn.mockClear();
    apiFn.mockRejectedValueOnce(new Error('offline'));

    const sessionId = createSessionWithReadings([{ valueNumeric: 7.0, valueText: null }]);

    const failed = await recording.uploadSession(sessionId);
    expect(failed.status).toBe('partial');

    apiFn.mockResolvedValueOnce({});
    const retried = await recording.uploadSession(sessionId);
    expect(retried.status).toBe('uploaded');
    expect(db.getSessionStats(sessionId).uploaded).toBe(1);
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
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 1.0, null, { receivedAt: now });
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 2.0, null, { receivedAt: now });
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 3.0, null, { receivedAt: now });
    db.insertSessionReading(sessionId, 'testsensor', 'sensor-abc', 'float', 4.0, null, { receivedAt: now + 1 });

    await recording.uploadSession(sessionId);

    expect(apiFn).toHaveBeenCalledOnce();
    const [, opts] = apiFn.mock.calls[0];
    const payload = opts.body.readings as Array<{ date: string; value: number }>;
    expect(payload).toHaveLength(2);
    expect(payload[0].value).toBe(3.0);
    expect(payload[1].value).toBe(4.0);

    const stats = db.getSessionStats(sessionId);
    expect(stats.uploaded).toBe(4);
    expect(stats.pending).toBe(0);
  });
});
