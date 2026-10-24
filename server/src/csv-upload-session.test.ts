import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * The CSV upload, end to end against a real in-memory database.
 *
 * `upload.test.ts` covers the per-sensor path; its fixtures carry no sensor
 * names, so they stay on it. This one pins the route the kiosk takes by
 * default: the telemetry reduced onto a grid and posted as chunked CSV, the
 * sensors that must keep their own instants posted the per-sensor way, and the
 * two ways the CSV route can turn out to be unusable.
 */

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn().mockResolvedValue({}),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('./herstellen-sensors.js', () => ({
  fetchHerstellenSensors: vi.fn(),
}));

let db: typeof import('./db.js');
let recording: typeof import('./recording.js');
let reductionConfig: typeof import('./reduction-config.js');
let CHUNK_ROWS: number;
let elementDevice: typeof import('./element-device.js');
let apiFn: ReturnType<typeof vi.fn>;

const DEVICE = { device_id: 'dev-1' };

/**
 * Stand in for the platform: resolve the element, and answer a CSV post the way
 * the endpoint does — counting the data rows it was actually given, so a test
 * cannot pass on a response that claims more than was sent.
 */
function fakePlatform(
  csvResponse: (body: string) => unknown = (body) => ({
    success: true,
    rows_processed: body.trimEnd().split('\n').length - 1,
    values_inserted: 0,
    failed_count: 0,
  }),
) {
  return (path: string, opts?: { rawBody?: string }) => {
    if (path.includes('/resolve')) return Promise.resolve(DEVICE);
    if (path.includes('/readings/batch/csv')) {
      const result = csvResponse(opts?.rawBody ?? '');
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }
    return Promise.resolve({});
  };
}

/** The columns of a posted CSV, and a cell lookup by column name. */
function readCsv(body: string) {
  const lines = body.trimEnd().split('\n');
  const header = lines[0].split(';');
  return {
    header,
    rows: lines.slice(1).map((line) => {
      const cells = line.split(';');
      return {
        at: cells[0],
        get: (name: string) => cells[header.indexOf(name)],
      };
    }),
  };
}

beforeAll(async () => {
  db = await import('./db.js');
  recording = await import('./recording.js');
  reductionConfig = await import('./reduction-config.js');
  elementDevice = await import('./element-device.js');
  const api = await import('./implenia-api.js');
  apiFn = api.fetchImplenia as ReturnType<typeof vi.fn>;
  CHUNK_ROWS = (await import('./csv-upload.js')).CHUNK_ROWS;

  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

beforeEach(() => {
  apiFn.mockReset();
  elementDevice.forgetElementDevices();
  reductionConfig.setReductionConfig({
    exportBucketMs: 1000, uploadBucketMs: 1000, uploadMode: 'csv',
  });
});

const SENSOR_MAP = {
  bohrtiefe: {
    sensorId: 's-tiefe', sensorType: 'float', name: 'Bohrtiefe', role: 'depth', source: 'mqtt',
  },
  drehzahl: {
    sensorId: 's-rpm', sensorType: 'float', name: 'Drehzahl', role: 'rpm', source: 'mqtt',
  },
  vorschubdruck: {
    sensorId: 's-druck', sensorType: 'float', name: 'Vorschubdruck', source: 'mqtt',
  },
  geodin: {
    sensorId: 's-geo', sensorType: 'int', name: 'GeoDIN', role: 'geology_nr', source: 'server',
  },
  kommentar: {
    sensorId: 's-kom', sensorType: 'string', name: 'Kommentar', source: 'user',
  },
  // The operator's phase flag: four readings in a whole shift, and the one
  // sensor whose fabricated NULLs cost implenia-web a protocol.
  status: {
    sensorId: 's-status', sensorType: 'int', name: 'Status', role: 'mode', source: 'user',
  },
  'ausführungsdatum': {
    sensorId: 's-fertig', sensorType: 'string', name: 'Ausführungsdatum',
    role: 'is_completed', source: 'user',
  },
};

let element = 0;

/** A session with four 250 ms samples of two channels, a GeoDIN and a comment. */
function seedSession(): { sessionId: number; elementName: string } {
  const elementName = `P-${++element}`;
  const sessionId = db.createSession(elementName, JSON.stringify(SENSOR_MAP));
  db.endSession(sessionId);
  const t0 = Date.parse('2026-05-18T12:00:00.000Z');

  for (let i = 0; i < 8; i++) {
    db.insertSessionReading(
      sessionId, 'rig/Bohrtiefe', 's-tiefe', 'float', i * 0.1, null,
      { receivedAt: t0 + i * 250 },
    );
    db.insertSessionReading(
      sessionId, 'rig/Drehzahl', 's-rpm', 'float', 60 + i, null,
      { receivedAt: t0 + i * 250 + 12 },
    );
    db.insertSessionReading(
      sessionId, 'rig/Vorschubdruck', 's-druck', 'float', 5 + i, null,
      { receivedAt: t0 + i * 250 + 24 },
    );
  }
  db.insertSessionReading(
    sessionId, 'rig/GeoDIN', 's-geo', 'int', 23, null, { receivedAt: t0 + 750 },
  );
  db.insertSessionReading(
    sessionId, 'rig/Kommentar', 's-kom', 'string', null, 'Hindernis',
    { receivedAt: t0 + 900 },
  );
  // Two phase steps, as an operator produces them: one value each, seconds
  // apart, standing for every row in between.
  db.insertSessionReading(
    sessionId, 'kiosk/status', 's-status', 'int', 0, null, { receivedAt: t0 + 20 },
  );
  db.insertSessionReading(
    sessionId, 'kiosk/status', 's-status', 'int', 1, null, { receivedAt: t0 + 1500 },
  );

  return { sessionId, elementName };
}

/** A session long enough to need more than one CSV chunk. */
function seedLongSession(): { sessionId: number; elementName: string } {
  const elementName = `L-${++element}`;
  const sessionId = db.createSession(elementName, JSON.stringify(SENSOR_MAP));
  db.endSession(sessionId);
  const t0 = Date.parse('2026-05-18T12:00:00.000Z');
  const rows = CHUNK_ROWS + 10;
  for (let i = 0; i < rows; i++) {
    db.insertSessionReading(
      sessionId, 'rig/Bohrtiefe', 's-tiefe', 'float', i * 0.01, null,
      { receivedAt: t0 + i * 1000 },
    );
    db.insertSessionReading(
      sessionId, 'rig/Drehzahl', 's-rpm', 'float', 60, null,
      { receivedAt: t0 + i * 1000 + 12 },
    );
  }
  return { sessionId, elementName };
}

function callsTo(fragment: string) {
  return apiFn.mock.calls.filter(([path]: [string]) => String(path).includes(fragment));
}

describe('uploadSession on the CSV route', () => {
  it('posts the telemetry as CSV to the element\'s device', async () => {
    apiFn.mockImplementation(fakePlatform());

    const { sessionId } = seedSession();
    const result = await recording.uploadSession(sessionId);

    const csvCalls = callsTo('/readings/batch/csv');
    expect(csvCalls).toHaveLength(1);
    const [path, opts] = csvCalls[0];
    expect(path).toBe('/api/v1/measuring-device/dev-1/readings/batch/csv');
    expect(opts.method).toBe('POST');
    expect(opts.contentType).toContain('text/csv');
    expect(opts.body).toBeUndefined();
    expect(result.status).toBe('uploaded');
  });

  it('reduces the session to one row per second, last value per channel', async () => {
    apiFn.mockImplementation(fakePlatform());

    const { sessionId } = seedSession();
    await recording.uploadSession(sessionId);

    const [, opts] = callsTo('/readings/batch/csv')[0];
    const csv = readCsv(opts.rawBody as string);
    expect(csv.header[0]).toBe('Zeitpunkt');
    expect(csv.header.slice(1).sort()).toEqual(['Bohrtiefe', 'Drehzahl', 'Vorschubdruck']);

    // 2 s of 250 ms samples → two rows, each holding that second's last value
    // and dated at that reading's own instant, not at the bucket edge.
    expect(csv.rows).toHaveLength(2);
    expect(csv.rows[0].at).toBe('2026-05-18T12:00:00.774Z');
    expect(csv.rows[0].get('Drehzahl')).toBe('63');
    expect(csv.rows[1].at).toBe('2026-05-18T12:00:01.774Z');
    expect(csv.rows[1].get('Drehzahl')).toBe('67');
  });

  it('never puts an operator-entered sensor in the CSV', async () => {
    // The regression that cost a real protocol. `Status` has two readings in
    // this session, so a CSV column for it would carry one value and an empty
    // cell on every other row — and an empty cell inserts a NULL, which
    // implenia-web's forward-fill reads as "the mode is now unknown". It goes
    // the id-addressed way, both readings at their own instants.
    apiFn.mockImplementation(fakePlatform());

    const { sessionId } = seedSession();
    await recording.uploadSession(sessionId);

    for (const [, opts] of callsTo('/readings/batch/csv')) {
      expect(readCsv(opts.rawBody as string).header).not.toContain('Status');
    }
    const batch = callsTo('/api/v1/sensor-int/s-status/batch');
    expect(batch).toHaveLength(1);
    expect(batch[0][1].body.readings.map((r: { value: number }) => r.value)).toEqual([0, 1]);
  });

  it('sends a platform-computed channel and the comment per sensor, at their own instants', async () => {
    apiFn.mockImplementation(fakePlatform());

    const { sessionId } = seedSession();
    await recording.uploadSession(sessionId);

    // Only the machine's own channels may be gridded: an absent cell in the
    // CSV is a written NULL, and that only means "the channel went quiet" for
    // something that publishes periodically.
    const geo = callsTo('/api/v1/sensor-int/s-geo/batch');
    expect(geo).toHaveLength(1);
    expect(geo[0][1].body.readings).toEqual([
      { date: '2026-05-18T12:00:00.750Z', value: 23 },
    ]);

    const kom = callsTo('/api/v1/sensor-string/s-kom/batch');
    expect(kom).toHaveLength(1);
    expect(kom[0][1].body.readings).toEqual([
      { date: '2026-05-18T12:00:00.900Z', value: 'Hindernis' },
    ]);
  });

  it('never posts a gridded sensor to the per-sensor endpoint as well', async () => {
    apiFn.mockImplementation(fakePlatform());

    const { sessionId } = seedSession();
    await recording.uploadSession(sessionId);

    expect(callsTo('/api/v1/sensor-float/s-rpm/batch')).toHaveLength(0);
    expect(callsTo('/api/v1/sensor-float/s-druck/batch')).toHaveLength(0);
  });

  it('marks every reading it reduced away as uploaded', async () => {
    apiFn.mockImplementation(fakePlatform());

    const { sessionId } = seedSession();
    await recording.uploadSession(sessionId);

    const stats = db.getSessionStats(sessionId);
    expect(stats.pending).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.uploaded).toBe(stats.total);
  });

  it('keeps a chunk\'s readings for a retry when that chunk fails', async () => {
    let csvCalls = 0;
    apiFn.mockImplementation(fakePlatform((body) => {
      csvCalls++;
      // The first chunk lands, the second is lost to the link. A structural
      // refusal switches routes, but only on the first chunk — a 502 is "not
      // now", and re-sending everything per sensor would put the whole session
      // back on the link this change exists to spare.
      if (csvCalls > 1) {
        const err = new Error('Implenia API 502: bad gateway') as Error & { statusCode: number };
        err.statusCode = 502;
        return err;
      }
      return {
        success: true,
        rows_processed: body.trimEnd().split('\n').length - 1,
        failed_count: 0,
      };
    }));

    const { sessionId } = seedLongSession();
    const result = await recording.uploadSession(sessionId);

    expect(csvCalls).toBeGreaterThan(1);
    expect(result.status).toBe('partial');
    const stats = db.getSessionStats(sessionId);
    expect(stats.failed).toBeGreaterThan(0);
    expect(stats.uploaded).toBeGreaterThan(0);
    // It did not fall back and re-send the gridded channels per sensor.
    expect(callsTo('/api/v1/sensor-float/s-rpm/batch')).toHaveLength(0);
  });

  it('falls back to the per-sensor route when the endpoint is not deployed', async () => {
    apiFn.mockImplementation((path: string) => {
      if (path.includes('/resolve')) return Promise.resolve(DEVICE);
      if (path.includes('/readings/batch/csv')) {
        const err = new Error('Implenia API 404: not found') as Error & { statusCode: number };
        err.statusCode = 404;
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const { sessionId } = seedSession();
    const result = await recording.uploadSession(sessionId);

    expect(result.status).toBe('uploaded');
    expect(callsTo('/api/v1/sensor-float/s-rpm/batch')).toHaveLength(1);
    expect(callsTo('/api/v1/sensor-float/s-druck/batch')).toHaveLength(1);
    expect(db.getSessionStats(sessionId).pending).toBe(0);
  });

  it('falls back when the platform does not recognise the column names', async () => {
    // A 200 that silently matched nothing is the failure the response check
    // exists for: by name is not how the rest of this kiosk addresses sensors.
    apiFn.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('/resolve') ? DEVICE
          : path.includes('/readings/batch/csv')
            ? { success: true, rows_processed: 2, unknown_sensors: ['Bohrtiefe', 'Drehzahl'] }
            : {},
      ));

    const { sessionId } = seedSession();
    const result = await recording.uploadSession(sessionId);

    expect(result.status).toBe('uploaded');
    expect(callsTo('/api/v1/sensor-float/s-tiefe/batch')).toHaveLength(1);
  });

  it('keeps the CSV route when a 422 blames the platform\'s own inserts', async () => {
    // The endpoint answers `failed_count > 0` with a 422 carrying the same
    // result shape as a success. That is its database having a bad minute, not
    // a body it will keep refusing — falling back would re-send the whole
    // session as JSON over the mobile link this route exists to spare.
    apiFn.mockImplementation(fakePlatform((body) => {
      const err = new Error('Implenia API 422') as Error & {
        statusCode: number; body: string;
      };
      err.statusCode = 422;
      err.body = JSON.stringify({
        success: false,
        rows_processed: body.trimEnd().split('\n').length - 1,
        failed_count: 7,
        errors: ['insert error (7 values): statement timeout'],
      });
      return err;
    }));

    const { sessionId } = seedSession();
    const result = await recording.uploadSession(sessionId);

    expect(result.status).toBe('partial');
    expect(callsTo('/api/v1/sensor-float/s-rpm/batch')).toHaveLength(0);
    expect(db.getSessionStats(sessionId).failed).toBeGreaterThan(0);
  });

  it('falls back when a 422 blames the column names', async () => {
    apiFn.mockImplementation(fakePlatform(() => {
      const err = new Error('Implenia API 422') as Error & {
        statusCode: number; body: string;
      };
      err.statusCode = 422;
      err.body = JSON.stringify({
        success: false,
        rows_processed: 0,
        unknown_sensors: ['Bohrtiefe', 'Drehzahl', 'Vorschubdruck'],
        errors: ['no matching sensors found: all CSV columns are unknown for this device'],
      });
      return err;
    }));

    const { sessionId } = seedSession();
    const result = await recording.uploadSession(sessionId);

    expect(result.status).toBe('uploaded');
    expect(callsTo('/api/v1/sensor-float/s-tiefe/batch')).toHaveLength(1);
  });

  it('falls back when the element does not resolve to a device', async () => {
    // The CSV endpoint is addressed per element device, so an element the
    // platform does not know leaves it with nothing to post to — while the
    // per-sensor route is addressed by sensor id and needs no device at all.
    // Marking every chunk failed here would strand measurements that the route
    // this kiosk shipped with uploads fine.
    apiFn.mockImplementation((path: string) =>
      Promise.resolve(path.includes('/resolve') ? {} : {}));

    const { sessionId } = seedSession();
    const result = await recording.uploadSession(sessionId);

    expect(callsTo('/readings/batch/csv')).toHaveLength(0);
    expect(callsTo('/api/v1/sensor-float/s-tiefe/batch')).toHaveLength(1);
    expect(callsTo('/api/v1/sensor-float/s-rpm/batch')).toHaveLength(1);
    expect(db.getSessionStats(sessionId).pending).toBe(0);
    expect(result.status).toBe('uploaded');
  });

  it('completes the element once both halves of the upload have landed', async () => {
    apiFn.mockImplementation(fakePlatform());

    const { sessionId, elementName } = seedSession();
    await recording.uploadSession(sessionId);

    const completion = callsTo('/readings/batch')
      .filter(([path]: [string]) => !String(path).endsWith('/csv'));
    expect(completion).toHaveLength(1);
    const body = completion[0][1].body;
    expect(body.string_sensors['Ausführungsdatum']).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(elementName).toBeTruthy();
  });

  it('does not complete an element whose chunks did not all land', async () => {
    // "Only an upload that actually put readings on the platform finishes the
    // element" has to hold across both halves, or a dropped chunk would report
    // a pillar as produced on data the platform never received.
    let csvCalls = 0;
    apiFn.mockImplementation(fakePlatform((body) => {
      csvCalls++;
      if (csvCalls > 1) {
        const err = new Error('Implenia API 502: bad gateway') as Error & { statusCode: number };
        err.statusCode = 502;
        return err;
      }
      return {
        success: true,
        rows_processed: body.trimEnd().split('\n').length - 1,
        failed_count: 0,
      };
    }));

    const { sessionId } = seedLongSession();
    const result = await recording.uploadSession(sessionId);

    expect(result.status).toBe('partial');
    const completion = callsTo('/readings/batch')
      .filter(([path]: [string]) => !String(path).endsWith('/csv'));
    expect(completion).toHaveLength(0);
  });

  it('takes the per-sensor route when that is what is configured', async () => {
    reductionConfig.setReductionConfig({
      exportBucketMs: 1000, uploadBucketMs: 1000, uploadMode: 'sensor',
    });
    apiFn.mockResolvedValue({});

    const { sessionId } = seedSession();
    await recording.uploadSession(sessionId);

    expect(callsTo('/readings/batch/csv')).toHaveLength(0);
    expect(callsTo('/api/v1/sensor-float/s-rpm/batch')).toHaveLength(1);
  });

  it('does not build a sparse CSV if a kiosk has no grid configured', async () => {
    // validateReduction refuses the combination, but a settings row written
    // before that check must not produce one value and thirteen NULLs per row.
    reductionConfig.setReductionConfig({
      exportBucketMs: 0, uploadBucketMs: 0, uploadMode: 'csv',
    });
    apiFn.mockResolvedValue({});

    const { sessionId } = seedSession();
    await recording.uploadSession(sessionId);

    expect(callsTo('/readings/batch/csv')).toHaveLength(0);
    expect(callsTo('/api/v1/sensor-float/s-rpm/batch')).toHaveLength(1);
  });

  it('reports progress in Paketen on the CSV route and in Sensoren otherwise', async () => {
    apiFn.mockImplementation(fakePlatform());

    const csvUnits: string[] = [];
    const a = seedSession();
    await recording.uploadSession(a.sessionId, (p) => csvUnits.push(p.unit));
    expect(new Set(csvUnits)).toEqual(new Set(['paket']));

    reductionConfig.setReductionConfig({
      exportBucketMs: 1000, uploadBucketMs: 1000, uploadMode: 'sensor',
    });
    apiFn.mockResolvedValue({});
    const sensorUnits: string[] = [];
    const b = seedSession();
    await recording.uploadSession(b.sessionId, (p) => sensorUnits.push(p.unit));
    expect(new Set(sensorUnits)).toEqual(new Set(['sensor']));
  });
});
