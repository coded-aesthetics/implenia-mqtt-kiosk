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
  completionStamp: () => '2026-10-06T12:00:00.000Z',
  writeElementCompletion: vi.fn().mockResolvedValue(undefined),
}));

let db: typeof import('./db.js');
let meta: typeof import('./sensor-meta.js');
let recording: typeof import('./recording.js');
let writeCompletion: ReturnType<typeof vi.fn>;

/**
 * The completion sensor is named by the session's own map, through its
 * `is_completed` role — the write is keyed by sensor *name* on the platform,
 * and the element is the authority on which of its sensors carries the role.
 */
const SENSOR_MAP = JSON.stringify({
  testsensor: { sensorId: 'sensor-abc', sensorType: 'float' },
  // Keyed lowercase, `name` carrying the platform's real spelling — which is
  // what the completion write is addressed to. The key would be a different
  // sensor, or a newly created one.
  'ausführungsdatum': {
    sensorId: 'sensor-ausf', sensorType: 'string',
    name: 'Ausführungsdatum', role: 'is_completed',
  },
});

/** A session from before roles were persisted: no role anywhere in the map. */
const LEGACY_SENSOR_MAP = JSON.stringify({
  testsensor: { sensorId: 'sensor-abc', sensorType: 'float' },
});

beforeAll(async () => {
  db = await import('./db.js');
  meta = await import('./sensor-meta.js');
  recording = await import('./recording.js');
  const completion = await import('./element-completion.js');
  writeCompletion = completion.writeElementCompletion as unknown as ReturnType<typeof vi.fn>;

  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

beforeEach(() => {
  writeCompletion.mockClear();
  meta.clearVerfahrenCache();
});

function endedSession(elementName: string, map = SENSOR_MAP): number {
  const id = db.createSession(elementName, map);
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

  it('falls back to the sensor CSVs for a session recorded before roles were persisted', async () => {
    // Those sessions can still be sitting unuploaded on a kiosk that has just
    // updated, and they must finish their element exactly as before.
    meta.setActiveVerfahren('dsv');
    const id = endedSession('F-02', LEGACY_SENSOR_MAP);
    db.insertSessionReading(id, 'testsensor', 'sensor-abc', 'float', 1.5, null);

    await recording.uploadSession(id);

    expect(writeCompletion).toHaveBeenCalledWith(
      'F-02', 'Ausführungsdatum', '2026-10-06T12:00:00.000Z',
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

  /*
   * Pausieren ends a session without finishing the element, and completion
   * hangs off the *upload* rather than the stop — which can run minutes or a
   * reboot later. So the flag has to be read here, and these two tests are
   * what keep that true.
   */
  it('finishes nothing for a paused session, but still uploads its readings', async () => {
    const id = endedSession('F-05');
    db.setSessionPaused(id, true);
    db.insertSessionReading(id, 'testsensor', 'sensor-abc', 'float', 3.5, null);

    const result = await recording.uploadSession(id);

    expect(result.status).toBe('uploaded');
    expect(db.getSessionStats(id).uploaded).toBe(1);
    expect(writeCompletion).not.toHaveBeenCalled();
  });

  it('keeps a paused element off the completed list', async () => {
    // The list is what the element screen reads, and it keys off `uploaded` —
    // so without the flag a pause would show the pillar as done locally while
    // the platform still has it open. That is the confusion Pausieren exists
    // to remove, arriving by the back door.
    const id = endedSession('F-06');
    db.setSessionPaused(id, true);
    db.insertSessionReading(id, 'testsensor', 'sensor-abc', 'float', 4.5, null);

    await recording.uploadSession(id);

    expect(db.getCompletedElements().map((e) => e.elementName)).not.toContain('F-06');
  });
});
