import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * The geology write path, end to end against real SQLite.
 *
 * What these pin is the millisecond alignment: every `GeoDIN` reading must sit
 * on the exact `received_at` of a recorded depth reading, because implenia-web
 * joins the two by millisecond equality and silently produces no layer
 * otherwise. The round-trip assertions read the committed readings back through
 * the same change detection web uses, so a regression shows up as a missing
 * layer rather than as a passing test.
 */

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn().mockResolvedValue({}),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('./herstellen-sensors.js', () => ({
  fetchHerstellenSensors: vi.fn(),
}));

/** Injektionsbohren's roles: depth is `Bohrtiefe`, which is also what web reads. */
let roles: Record<string, string | null> = {
  depth: 'Bohrtiefe',
  geology_nr: 'GeoDIN',
  geology_text: 'Geologie',
};

vi.mock('./sensor-meta.js', () => ({
  findSensorNameByRole: (role: string) => roles[role] ?? null,
}));

let db: typeof import('./db.js');
let geology: typeof import('./geology.js');
let depthTimestamp: typeof import('./depth-timestamp.js');

const DEPTH_ID = 'sensor-bohrtiefe';
const NR_ID = 'sensor-geodin';
const TEXT_ID = 'sensor-geologie';

const SENSOR_MAP = JSON.stringify({
  bohrtiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
  geodin: { sensorId: NR_ID, sensorType: 'int' },
  geologie: { sensorId: TEXT_ID, sensorType: 'string' },
});

const T0 = 1_700_000_000_000;
const SAND = 5;
const SCHLUFF = 9;
const TON = 10;
const BETON = 60;

beforeAll(async () => {
  db = await import('./db.js');
  geology = await import('./geology.js');
  depthTimestamp = await import('./depth-timestamp.js');

  // Required by CLAUDE.md: this suite deletes rows (commitGeology replaces a
  // previous commit), and a reset test once wiped a developer's real kiosk.db.
  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

beforeEach(() => {
  roles = { depth: 'Bohrtiefe', geology_nr: 'GeoDIN', geology_text: 'Geologie' };
});

/** A session with a depth series descending `from` → `to` at 0.5 m per second. */
function drilledSession(from = 0, to = 6, step = 0.5): { id: number; session: import('./db.js').Session } {
  const id = db.createSession(`E-${Math.random().toString(36).slice(2, 8)}`, SENSOR_MAP);
  let i = 0;
  for (let d = from; d <= to + 1e-9; d += step) {
    db.insertSessionReading(
      id, 'rig/depth', DEPTH_ID, 'float', Math.round(d * 1e6) / 1e6, null,
      { receivedAt: T0 + i * 1000 },
    );
    i++;
  }
  return { id, session: db.getSessionById(id)! };
}

/** The committed GeoDIN readings, oldest first. */
function geoDinRows(id: number): { receivedAt: number; nr: number }[] {
  return db.getSessionSensorSeries(id, NR_ID)
    .map((p) => ({ receivedAt: p.receivedAt, nr: Math.round(p.value) }));
}

/** The committed Geologie texts, in the order they were written. */
function geologieTexts(id: number): string[] {
  return db.getSessionReadingsDetailed(id, 500)
    .filter((r) => r.topic === 'Geologie')
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .map((r) => r.valueText ?? '');
}

describe('commitGeology', () => {
  it('dates every reading on an existing depth reading', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 2.5, nr: SCHLUFF }, { tiefe: 4, nr: TON },
    ]);

    const depthStamps = new Set(db.getSessionDepthSamples(id, DEPTH_ID).map((s) => s.receivedAt));
    const rows = geoDinRows(id);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(depthStamps.has(r.receivedAt)).toBe(true);
  });

  it('round-trips the profile through the change detection web uses', () => {
    const { id, session } = drilledSession(0, 10);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 2.5, nr: SCHLUFF },
      { tiefe: 4, nr: BETON }, { tiefe: 4.5, nr: SCHLUFF }, { tiefe: 7, nr: TON },
    ]);

    const samples = db.getSessionDepthSamples(id, DEPTH_ID)
      .map((p) => ({ receivedAt: p.receivedAt, depth: p.value }));
    const { observedLayers } = depthTimestamp;
    expect(observedLayers(samples, geoDinRows(id))).toEqual([
      { tiefe: 0, nr: SAND },
      { tiefe: 2.5, nr: SCHLUFF },
      { tiefe: 4, nr: BETON },
      { tiefe: 4.5, nr: SCHLUFF },
      { tiefe: 7, nr: TON },
    ]);
  });

  it('writes the ground type name into the text series', () => {
    const { id, session } = drilledSession(0, 4);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND, name: 'Sand', quelle: 'ist' },
      { tiefe: 2, nr: SCHLUFF, name: 'Schluff', quelle: 'ist' },
    ]);
    expect(geologieTexts(id)).toEqual(['Sand', 'Schluff']);
  });

  it('marks a back-filled boundary in the text, not in GeoDIN', () => {
    const { id, session } = drilledSession(0, 4);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND, name: 'Sand', quelle: 'ist' },
      { tiefe: 2, nr: SCHLUFF, name: 'Schluff', quelle: 'vorgabe' },
    ]);
    expect(geologieTexts(id)).toEqual(['Sand', 'Schluff (Vorgabe)']);
    // GeoDIN stays a clean number series — provenance must not reach it.
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND, SCHLUFF]);
  });

  it('names the ground type itself when the caller gives no name', () => {
    // The DIN tables come from the din4023 package, so a profile reads the same
    // however the recording was stopped.
    const { id, session } = drilledSession(0, 2);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND }]);
    expect(geologieTexts(id)).toEqual(['Sand']);
  });

  it('falls back to the bare number for a code outside the DIN tables', () => {
    const { id, session } = drilledSession(0, 2);
    geology.commitGeology(session, [{ tiefe: 0, nr: 999 }]);
    expect(geologieTexts(id)).toEqual(['GeoDIN 999']);
  });

  it('lets a caller override the name with its own description', () => {
    const { id, session } = drilledSession(0, 2);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND, name: 'Feinsand, humos' }]);
    expect(geologieTexts(id)).toEqual(['Feinsand, humos']);
  });

  it('replaces an earlier commit instead of stacking a second profile', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF },
    ]);
    const second = geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 3, nr: TON },
    ]);

    expect(second.ersetzt).toBe(4); // 2 GeoDIN + 2 Geologie
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND, TON]);
    expect(geologieTexts(id)).toHaveLength(2);
  });

  it('never removes a reading already uploaded', () => {
    // Not a flow the UI can reach — geology is committed at stop, before any
    // upload — but the guard protects platform data, so it is worth pinning.
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF }]);

    const ids = db.getSessionUploadGroups(id)
      .filter((g) => g.sensorId === NR_ID)
      .flatMap((g) => g.readings.map((r) => r.id));
    db.markSessionReadingsUploaded(ids);

    const result = geology.commitGeology(session, [{ tiefe: 0, nr: TON }]);
    expect(result.ersetzt).toBe(2); // only the two pending Geologie texts
    // Both uploaded GeoDIN readings are still there, with the new one added.
    const nrs = geoDinRows(id).map((r) => r.nr);
    expect(nrs).toHaveLength(3);
    expect(nrs).toContain(SAND);
    expect(nrs).toContain(SCHLUFF);
    expect(nrs).toContain(TON);
  });

  it('drops a boundary below the bottom of the hole', () => {
    const { id, session } = drilledSession(0, 5);
    const result = geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF }, { tiefe: 9, nr: TON },
    ]);
    expect(result.zuTief).toEqual([9]);
    expect(result.geschrieben).toBe(2);
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND, SCHLUFF]);
  });

  it('ignores depth readings recorded during a Rohrwechsel', () => {
    const id = db.createSession('E-rohr', SENSOR_MAP);
    // A real descent, then a phantom 9 m reading while a pipe was added.
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 0, null, { receivedAt: T0 });
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 2, null, { receivedAt: T0 + 1000 });
    db.insertSessionReading(
      id, 'rig/depth', DEPTH_ID, 'float', 9, null,
      { receivedAt: T0 + 2000, phase: 'rohrwechsel' },
    );
    const session = db.getSessionById(id)!;

    const result = geology.commitGeology(session, [{ tiefe: 0, nr: SAND }, { tiefe: 5, nr: TON }]);
    // 5 m is below the real hole, so it is dropped — not dated at the phantom.
    expect(result.zuTief).toEqual([5]);
    expect(geoDinRows(id)).toHaveLength(1);
  });

  it('ignores clipped depth readings', () => {
    const id = db.createSession('E-clip', SENSOR_MAP);
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 0, null, { receivedAt: T0 });
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 2, null, { receivedAt: T0 + 1000 });
    db.insertSessionReading(
      id, 'rig/depth', DEPTH_ID, 'float', 8, null,
      { receivedAt: T0 + 2000, clipped: true },
    );
    const session = db.getSessionById(id)!;

    expect(geology.commitGeology(session, [{ tiefe: 6, nr: TON }]).zuTief).toEqual([6]);
  });

  it('writes nothing and explains itself when the session has no depth readings', () => {
    const id = db.createSession('E-leer', SENSOR_MAP);
    const result = geology.commitGeology(db.getSessionById(id)!, [{ tiefe: 0, nr: SAND }]);
    expect(result.geschrieben).toBe(0);
    expect(result.hinweis).toContain('Tiefenmesswerte');
    expect(geoDinRows(id)).toEqual([]);
  });

  it('writes nothing when the session has no GeoDIN sensor', () => {
    const id = db.createSession('E-nogeo', JSON.stringify({
      bohrtiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
    }));
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 1, null, { receivedAt: T0 });

    const result = geology.commitGeology(db.getSessionById(id)!, [{ tiefe: 0, nr: SAND }]);
    expect(result.geschrieben).toBe(0);
    expect(result.hinweis).toContain('GeoDIN');
  });

  it('commits GeoDIN even when the Verfahren has no text sensor', () => {
    roles = { depth: 'Bohrtiefe', geology_nr: 'GeoDIN', geology_text: null };
    const { id, session } = drilledSession(0, 4);
    const result = geology.commitGeology(session, [{ tiefe: 0, nr: SAND }]);
    expect(result.geschrieben).toBe(1);
    expect(geologieTexts(id)).toEqual([]);
  });

  it('skips layers with an invalid ground type rather than writing them', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND },
      { tiefe: 2, nr: 0 },
      { tiefe: 3, nr: -1 },
      { tiefe: 4, nr: 2.5 },
      { tiefe: 5, nr: TON },
    ]);
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND, TON]);
  });

  it('sorts an unsorted profile before aligning it', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 4, nr: TON }, { tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF },
    ]);
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND, SCHLUFF, TON]);
  });

  it('keeps GeoDIN and Geologie on the same instant', () => {
    const { id, session } = drilledSession(0, 4);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND, name: 'Sand' }, { tiefe: 2, nr: TON, name: 'Ton' },
    ]);
    const nrStamps = geoDinRows(id).map((r) => r.receivedAt);
    const textStamps = db.getSessionReadingsDetailed(id, 500)
      .filter((r) => r.topic === 'Geologie')
      .map((r) => r.receivedAt)
      .sort((a, b) => a - b);
    expect(textStamps).toEqual(nrStamps);
  });
});

describe('recordLiveLayer', () => {
  it('dates the reading at the latest depth reading and reports its depth', () => {
    const { id, session } = drilledSession(0, 3);
    const result = geology.recordLiveLayer(session, SCHLUFF, 'Schluff');
    expect(result).toEqual({ tiefe: 3, receivedAt: T0 + 6000 });
    expect(geoDinRows(id)).toEqual([{ receivedAt: T0 + 6000, nr: SCHLUFF }]);
    expect(geologieTexts(id)).toEqual(['Schluff']);
  });

  it('is readable back as a layer at that depth', () => {
    const { id, session } = drilledSession(0, 3);
    geology.recordLiveLayer(session, SAND, 'Sand');
    const ctx = geology.getGeologyContext(session);
    expect(ctx.beobachtet).toEqual([{ tiefe: 3, nr: SAND }]);
    expect(geoDinRows(id)).toHaveLength(1);
  });

  it('refuses before the first depth reading, with an actionable reason', () => {
    const id = db.createSession('E-nodepth', SENSOR_MAP);
    const result = geology.recordLiveLayer(db.getSessionById(id)!, SAND);
    expect(result).toHaveProperty('fehler');
    expect((result as { fehler: string }).fehler).toContain('Bohrtiefe');
  });

  it('rejects an invalid ground type', () => {
    const { session } = drilledSession(0, 2);
    expect(geology.recordLiveLayer(session, 0)).toHaveProperty('fehler');
    expect(geology.recordLiveLayer(session, 1.5)).toHaveProperty('fehler');
  });

  it('never lands on a Rohrwechsel reading', () => {
    const id = db.createSession('E-live-rohr', SENSOR_MAP);
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 3, null, { receivedAt: T0 });
    db.insertSessionReading(
      id, 'rig/depth', DEPTH_ID, 'float', 11, null,
      { receivedAt: T0 + 1000, phase: 'rohrwechsel' },
    );
    const result = geology.recordLiveLayer(db.getSessionById(id)!, SAND);
    expect(result).toEqual({ tiefe: 3, receivedAt: T0 });
  });
});

describe('getGeologyContext', () => {
  it('reports a drilled session as ready to confirm', () => {
    const { session } = drilledSession(0, 6);
    const ctx = geology.getGeologyContext(session);
    expect(ctx.verfuegbar).toBe(true);
    expect(ctx.gebohrt).toBe(true);
    expect(ctx.gebohrteTiefe).toBe(6);
    expect(ctx.maxTiefe).toBe(6);
  });

  it('reports a session that barely moved as not drilled', () => {
    const { session } = drilledSession(2, 2.2, 0.1);
    const ctx = geology.getGeologyContext(session);
    expect(ctx.gebohrt).toBe(false);
  });

  it('reports a Verfahren without geology as unavailable, with no complaint', () => {
    roles = { depth: 'Bohrtiefe', geology_nr: null, geology_text: null };
    const { session } = drilledSession(0, 6);
    const ctx = geology.getGeologyContext(session);
    expect(ctx.verfuegbar).toBe(false);
    expect(ctx.hinweis).toBeUndefined();
  });

  it('explains a geology-capable Verfahren whose session lacks the sensor', () => {
    const id = db.createSession('E-missing', JSON.stringify({
      bohrtiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
    }));
    const ctx = geology.getGeologyContext(db.getSessionById(id)!);
    expect(ctx.verfuegbar).toBe(false);
    expect(ctx.hinweis).toContain('GeoDIN');
  });

  it('serves the planned profile from the vorgaben cache', () => {
    const { session } = drilledSession(0, 6);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 9, 'Säulenhöhe': 9 },
    });
    const ctx = geology.getGeologyContext(db.getSessionById(session.id)!);
    expect(ctx.vorgabe).toEqual({
      schichten: [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: TON }],
      endTiefe: 9,
    });
  });

  it('survives an element with no cached vorgaben', () => {
    const { session } = drilledSession(0, 6);
    const ctx = geology.getGeologyContext(session);
    expect(ctx.vorgabe).toBeNull();
    expect(ctx.verfuegbar).toBe(true);
  });

  it('reads a committed profile back as the observed layers', () => {
    const { session } = drilledSession(0, 8);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 3, nr: BETON }, { tiefe: 3.5, nr: SAND },
    ]);
    expect(geology.getGeologyContext(session).beobachtet).toEqual([
      { tiefe: 0, nr: SAND },
      { tiefe: 3, nr: BETON },
      { tiefe: 3.5, nr: SAND },
    ]);
  });
});

describe('commitDefaultGeology', () => {
  it('back-fills the plan where nothing was confirmed', () => {
    const { id, session } = drilledSession(0, 8);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': SCHLUFF, 'Geologie 3': TON },
      float_sensors: {
        'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 7,
        'Tiefe Geologie 3': 12, 'Säulenhöhe': 12,
      },
    });

    const result = geology.commitDefaultGeology(db.getSessionById(id)!)!;
    expect(result.geschrieben).toBe(3);
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND, SCHLUFF, TON]);
    expect(geologieTexts(id)).toEqual([
      'Sand (Vorgabe)', 'Schluff (Vorgabe)', 'Ton (Vorgabe)',
    ]);
  });

  it('keeps what the operator entered live and fills only the rest', () => {
    const { id, session } = drilledSession(0, 8);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': SCHLUFF },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 12, 'Säulenhöhe': 12 },
    });
    // The operator saw the change at 2.5 m, not the planned 3 m.
    db.insertSessionReading(
      id, 'GeoDIN', NR_ID, 'int', SCHLUFF, null, { receivedAt: T0 + 5000 },
    );

    geology.commitDefaultGeology(db.getSessionById(id)!);
    const samples = db.getSessionDepthSamples(id, DEPTH_ID)
      .map((p) => ({ receivedAt: p.receivedAt, depth: p.value }));
    expect(depthTimestamp.observedLayers(samples, geoDinRows(id))).toEqual([
      { tiefe: 0, nr: SAND },
      { tiefe: 2.5, nr: SCHLUFF },
    ]);
    // The confirmed boundary is not marked as carried over; the top is.
    expect(geologieTexts(id)).toEqual(['Sand (Vorgabe)', 'Schluff']);
  });

  it('commits an obstruction without claiming it reached the surface', () => {
    const { id, session } = drilledSession(0, 6);
    db.insertSessionReading(
      id, 'GeoDIN', NR_ID, 'int', BETON, null, { receivedAt: T0 + 4000 },
    );
    const result = geology.commitDefaultGeology(db.getSessionById(id)!)!;
    expect(result.geschrieben).toBe(1);

    const samples = db.getSessionDepthSamples(id, DEPTH_ID)
      .map((p) => ({ receivedAt: p.receivedAt, depth: p.value }));
    // One layer, starting where the concrete was actually met.
    expect(depthTimestamp.observedLayers(samples, geoDinRows(id)))
      .toEqual([{ tiefe: 2, nr: BETON }]);
  });

  it('commits the observations alone when there is no plan', () => {
    const { id, session } = drilledSession(0, 6);
    db.insertSessionReading(
      id, 'GeoDIN', NR_ID, 'int', SAND, null, { receivedAt: T0 + 4000 },
    );
    const result = geology.commitDefaultGeology(db.getSessionById(id)!)!;
    // The sand seen at 2 m is extended to the top, as an assumption.
    expect(result.geschrieben).toBe(1);
    expect(geologieTexts(id)).toEqual(['Sand (Vorgabe)']);
  });

  it('does nothing for a session that never really drilled', () => {
    const { session } = drilledSession(2, 2.2, 0.1);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND },
      float_sensors: { 'Tiefe Geologie 1': 9 },
    });
    expect(geology.commitDefaultGeology(session)).toBeNull();
  });

  it('does nothing when the Verfahren records no geology', () => {
    roles = { depth: 'Bohrtiefe', geology_nr: null, geology_text: null };
    const { session } = drilledSession(0, 6);
    expect(geology.commitDefaultGeology(session)).toBeNull();
  });

  it('does nothing when there is neither a plan nor an observation', () => {
    const { session } = drilledSession(0, 6);
    expect(geology.commitDefaultGeology(session)).toBeNull();
  });

  it('is repeatable — a second call replaces the first', () => {
    const { id, session } = drilledSession(0, 8);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 12, 'Säulenhöhe': 12 },
    });
    geology.commitDefaultGeology(db.getSessionById(id)!);
    const second = geology.commitDefaultGeology(db.getSessionById(id)!)!;
    expect(second.ersetzt).toBeGreaterThan(0);
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND, TON]);
  });
});

describe('entries that would otherwise be lost or invented', () => {
  it('replaces an earlier entry rather than colliding on one millisecond', () => {
    // Two taps with no depth reading between them — the whole of a
    // Rohrverlängerung is such a window, since the depth series is filtered to
    // phase 'bohren'. Both readings would land on one instant, and the
    // upload's per-timestamp dedup keeps only the last, so the obstruction the
    // operator entered and left would disappear entirely.
    const { id, session } = drilledSession(0, 2);
    const a = geology.recordLiveLayer(session, BETON, 'Beton');
    const b = geology.recordLiveLayer(session, SAND, 'Sand');
    expect(a).toHaveProperty('tiefe');
    expect(b).toHaveProperty('tiefe');

    const rows = geoDinRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].nr).toBe(SAND);
    expect(new Set(rows.map((r) => r.receivedAt)).size).toBe(rows.length);
    expect(geologieTexts(id)).toEqual(['Sand']);
  });

  it('commits nothing for planned ground this session never came near', () => {
    // Session 2 of a resumed element: recording starts at 8 m and the plan's
    // boundaries were drilled the day before. Aligning them to the nearest free
    // reading would commit three fabricated 10cm layers at 8.0/8.1/8.2 and
    // report a clean success.
    const id = db.createSession('P-resumed', SENSOR_MAP);
    let i = 0;
    for (let d = 8; d <= 10.0001; d += 0.1) {
      db.insertSessionReading(
        id, 'rig/depth', DEPTH_ID, 'float', Math.round(d * 1e6) / 1e6, null,
        { receivedAt: T0 + i * 1000 },
      );
      i++;
    }
    db.setElementVorgaben('P-resumed', {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': SCHLUFF, 'Geologie 3': TON },
      float_sensors: {
        'Tiefe Geologie 1': 2, 'Tiefe Geologie 2': 5,
        'Tiefe Geologie 3': 12, 'Säulenhöhe': 12,
      },
    });

    const result = geology.commitDefaultGeology(db.getSessionById(id)!)!;
    expect(result.geschrieben).toBe(0);
    expect(result.zuFlach).toEqual([0, 2, 5]);
    expect(geoDinRows(id)).toEqual([]);
  });

  it('keeps the boundaries a resumed session did drill through', () => {
    const id = db.createSession('P-resumed2', SENSOR_MAP);
    let i = 0;
    for (let d = 8; d <= 10.0001; d += 0.1) {
      db.insertSessionReading(
        id, 'rig/depth', DEPTH_ID, 'float', Math.round(d * 1e6) / 1e6, null,
        { receivedAt: T0 + i * 1000 },
      );
      i++;
    }
    const result = geology.commitGeology(db.getSessionById(id)!, [
      { tiefe: 0, nr: SAND }, { tiefe: 9, nr: TON },
    ]);
    expect(result.zuFlach).toEqual([0]);
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([TON]);
  });

  it('ignores a negative boundary instead of letting it take the top reading', () => {
    const { id, session } = drilledSession(0, 2);
    geology.commitGeology(session, [{ tiefe: -5, nr: SAND }, { tiefe: 0, nr: SCHLUFF }]);
    const samples = db.getSessionDepthSamples(id, DEPTH_ID)
      .map((p) => ({ receivedAt: p.receivedAt, depth: p.value }));
    // The real top-of-hole layer keeps the first reading.
    expect(depthTimestamp.observedLayers(samples, geoDinRows(id)))
      .toEqual([{ tiefe: 0, nr: SCHLUFF }]);
  });

  it('keeps the shallowest planned type when a Vorgabe names no depths', () => {
    // "Geologie 1..3" with no "Tiefe Geologie n" puts every layer at 0 m.
    // Keeping the last committed Ton from the surface; the plan's own topmost
    // type is the better guess.
    const { id, session } = drilledSession(0, 6);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': SCHLUFF, 'Geologie 3': TON },
    });
    geology.commitDefaultGeology(db.getSessionById(id)!);
    expect(geoDinRows(id).map((r) => r.nr)).toEqual([SAND]);
  });
});
