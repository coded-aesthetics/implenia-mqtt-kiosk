import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * The end of the chain: a real `uploadSession` for a session recorded on a pier
 * the kiosk has left goes out under *that pier's* key.
 *
 * `site-credentials.test.ts` pins the mechanism; this pins that the upload is
 * actually wired to it, with the real `implenia-api` and a stubbed socket —
 * because the failure it prevents is invisible from inside the kiosk. Every
 * request the upload fans out to is checked, not just the first: the CSV
 * chunks, the per-sensor batches, the element→device resolve and the
 * `Ausführungsdatum` write all have to go to the same place, and each is its own
 * opportunity to fall back to the configured key.
 */

vi.mock('./herstellen-sensors.js', () => ({
  fetchHerstellenSensors: vi.fn(),
}));

let db: typeof import('./db.js');
let site: typeof import('./site.js');
let recording: typeof import('./recording.js');

const PIER_1 = 'key-for-pier-1';
const PIER_2 = 'key-for-pier-2';

let sent: { url: string; auth: string | null }[] = [];

function stubFetch(): void {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      auth: (init.headers as Record<string, string>).Authorization ?? null,
    });
    return {
      ok: true,
      status: 200,
      // Enough for the element→device resolve and the CSV result to parse.
      // `rows_processed` must not fall short of what was sent, or the chunk is
      // treated as a problem and the session ends `partial`.
      json: async () => ({
        device_id: 'dev-pier-1',
        rows_processed: 10_000,
        failed_count: 0,
        unknown_sensors: [],
      }),
      text: async () => '{}',
    } as unknown as Response;
  }));
}

function moveTo(apiKey: string): string {
  db.setMeta('implenia_api_key', apiKey);
  db.setMeta('implenia_api_url', 'http://platform.test');
  site.syncSite();
  return db.currentSiteId();
}

/** A finished session with one sensor's readings, on whatever site is current. */
function recordedSession(): number {
  const sensorMap = {
    tiefe: {
      sensorId: 'pier-1-tiefe', sensorType: 'float', name: 'Tiefe', role: 'depth', source: 'mqtt',
    },
    'ausführungsdatum': {
      sensorId: 'pier-1-ausf', sensorType: 'string',
      name: 'Ausführungsdatum', role: 'is_completed', source: 'kiosk',
    },
  };
  const id = db.createSession('P-01', JSON.stringify(sensorMap));
  const base = Date.now();
  for (let i = 0; i < 3; i++) {
    db.insertSessionReading(
      id, 'tiefe', 'pier-1-tiefe', 'float', i + 1, null, { receivedAt: base + i * 1000 },
    );
  }
  db.endSession(id);
  return id;
}

beforeAll(async () => {
  db = await import('./db.js');
  site = await import('./site.js');
  recording = await import('./recording.js');

  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
});

beforeEach(() => {
  db.resetKiosk();
  db.deleteMeta('current_site_id');
  db.deleteMeta('implenia_api_key');
  db.deleteMeta('implenia_api_url');
  db.getSessions().forEach((s) => db.deleteSessionWithReadings(s.id));
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploading after the crew moved to the next pier', () => {
  it('sends every request under the key of the pier that recorded it', async () => {
    moveTo(PIER_1);
    const sessionId = recordedSession();

    moveTo(PIER_2);
    await recording.uploadSession(sessionId);

    expect(sent.length).toBeGreaterThan(0);
    const wrongKey = sent.filter((r) => r.auth !== `Bearer ${PIER_1}`);
    expect(wrongKey).toEqual([]);
  });

  it('marks the readings uploaded, so the retry loop lets go of them', async () => {
    moveTo(PIER_1);
    const sessionId = recordedSession();

    moveTo(PIER_2);
    const { status } = await recording.uploadSession(sessionId);

    // The whole point: before this, the same session answered 401 on every
    // connectivity transition and every boot for the life of the machine.
    expect(status).toBe('uploaded');
    // And nothing is left that the reset guard or the switch warning would
    // still count as unsent.
    expect(db.getUnsafeDataSummary().readings).toBe(0);
  });

  it('still uses the configured key for a session recorded on this pier', async () => {
    moveTo(PIER_1);
    const sessionId = recordedSession();

    await recording.uploadSession(sessionId);

    const wrongKey = sent.filter((r) => r.auth !== `Bearer ${PIER_1}`);
    expect(wrongKey).toEqual([]);
  });
});
