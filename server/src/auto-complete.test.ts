import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * What a successful upload is allowed to report as produced.
 *
 * Writing the Ausführungsdatum takes the element out of the shift assignment
 * for every other project (see CLAUDE.md → "Element completion"), so it must
 * follow data that actually reached the platform. A session with no pending
 * rows also ends as `uploaded` — an empty one, and one whose every reading was
 * clipped as a Rohrwechsel — and those must finish nothing.
 */

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn().mockResolvedValue({}),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('./herstellen-sensors.js', () => ({
  fetchHerstellenSensors: vi.fn(),
}));

vi.mock('./element-completion.js', () => ({
  findCompletionSensorName: () => 'Ausführungsdatum',
  completionStamp: () => '2026-10-06T12:00:00.000Z',
  writeElementCompletion: vi.fn().mockResolvedValue(undefined),
}));

let db: typeof import('./db.js');
let recording: typeof import('./recording.js');
let writeCompletion: ReturnType<typeof vi.fn>;

const SENSOR_MAP = JSON.stringify({
  testsensor: { sensorId: 'sensor-abc', sensorType: 'float' },
});

beforeAll(async () => {
  db = await import('./db.js');
  recording = await import('./recording.js');
  const completion = await import('./element-completion.js');
  writeCompletion = completion.writeElementCompletion as unknown as ReturnType<typeof vi.fn>;

  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

beforeEach(() => {
  writeCompletion.mockClear();
});

function endedSession(elementName: string): number {
  const id = db.createSession(elementName, SENSOR_MAP);
  db.endSession(id);
  return id;
}

describe('auto-completion after upload', () => {
  it('stamps the element when readings reached the platform', async () => {
    const id = endedSession('F-01');
    db.insertSessionReading(id, 'testsensor', 'sensor-abc', 'float', 1.5, null);

    const result = await recording.uploadSession(id);

    expect(result.status).toBe('uploaded');
    expect(writeCompletion).toHaveBeenCalledWith(
      'F-01', 'Ausführungsdatum', '2026-10-06T12:00:00.000Z',
    );
  });

  it('finishes nothing when every reading was clipped as a Rohrwechsel', async () => {
    const id = endedSession('F-02');
    db.insertSessionReading(id, 'testsensor', 'sensor-abc', 'float', 9.0, null, { clipped: true });
    db.insertSessionReading(id, 'testsensor', 'sensor-abc', 'float', 8.0, null, { clipped: true });

    await recording.uploadSession(id);

    expect(writeCompletion).not.toHaveBeenCalled();
    // The readings are still there to be released.
    expect(db.getSessionStats(id).clipped).toBe(2);
  });

  it('finishes nothing for a session with no readings at all', async () => {
    const id = endedSession('F-03');

    await recording.uploadSession(id);

    expect(writeCompletion).not.toHaveBeenCalled();
  });

  it('does not stamp a session that only partly uploaded', async () => {
    const api = await import('./implenia-api.js');
    const apiFn = api.fetchImplenia as unknown as ReturnType<typeof vi.fn>;
    apiFn.mockRejectedValueOnce(new Error('offline'));

    const id = endedSession('F-04');
    db.insertSessionReading(id, 'testsensor', 'sensor-abc', 'float', 2.5, null);

    const result = await recording.uploadSession(id);

    expect(result.status).toBe('partial');
    expect(writeCompletion).not.toHaveBeenCalled();
  });
});
