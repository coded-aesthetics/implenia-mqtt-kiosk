import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * The geology write path, end to end against real SQLite.
 *
 * What these pin is that **a layer carries its own depth**. The profile is one
 * JSON value at a sentinel instant, so the assertions parse that value back
 * and check depths and provenance directly.
 *
 * The suite this replaced pinned a millisecond alignment instead: every
 * `GeoDIN` reading had to sit on the exact `received_at` of a recorded depth
 * reading, because implenia-web recovered each layer's depth by joining the two
 * series on millisecond equality and silently produced no layer otherwise. That
 * is the whole class of failure this change removes, so the tests for it are
 * gone rather than ported.
 */

vi.mock('./implenia-api.js', () => ({
  fetchImplenia: vi.fn().mockResolvedValue({}),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

vi.mock('./herstellen-sensors.js', () => ({
  fetchHerstellenSensors: vi.fn(),
}));

/** Injektionsbohren's roles: depth is `Bohrtiefe`. */
let roles: Record<string, string | null> = {
  depth: 'Bohrtiefe',
  geology_profile: 'Geologieprofil',
};

vi.mock('./sensor-meta.js', () => ({
  findSensorNameByRole: (role: string) => roles[role] ?? null,
}));

let db: typeof import('./db.js');
let geology: typeof import('./geology.js');

const DEPTH_ID = 'sensor-bohrtiefe';
const PROFIL_ID = 'sensor-geologieprofil';

const SENSOR_MAP = JSON.stringify({
  bohrtiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
  geologieprofil: { sensorId: PROFIL_ID, sensorType: 'string' },
});

const T0 = 1_700_000_000_000;
const SAND = 5;
const SCHLUFF = 9;
const TON = 10;
const BETON = 60;

beforeAll(async () => {
  db = await import('./db.js');
  geology = await import('./geology.js');

  // Required by CLAUDE.md: this suite deletes rows (commitGeology replaces a
  // previous commit), and a reset test once wiped a developer's real kiosk.db.
  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

beforeEach(() => {
  roles = { depth: 'Bohrtiefe', geology_profile: 'Geologieprofil' };
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

interface WireLayer { t: number; nr: number; name?: string; q?: string }

/** Every committed profile value of a session, oldest first. */
function profileValues(id: number): { end: number; layers: WireLayer[] }[] {
  return db.getSessionSensorTextSeries(id, PROFIL_ID)
    .map((r) => JSON.parse(r.text) as { end: number; layers: WireLayer[] });
}

/** The one committed profile, or null if none was written. */
function profile(id: number): { end: number; layers: WireLayer[] } | null {
  const all = profileValues(id);
  expect(all.length).toBeLessThanOrEqual(1);
  return all[0] ?? null;
}

/** The committed layers as `{tiefe, nr}`, which is what the merge works in. */
function layers(id: number): { tiefe: number; nr: number }[] {
  return (profile(id)?.layers ?? []).map((l) => ({ tiefe: l.t, nr: l.nr }));
}

describe('commitGeology', () => {
  it('writes one profile value at the sentinel instant', () => {
    // One overwritable slot, not a series: inserts upsert on
    // `(sensor_id, date)`, which is what makes a re-commit a replacement.
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND }, { tiefe: 2, nr: TON }]);

    const rows = db.getSessionSensorTextSeries(id, PROFIL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].receivedAt).toBe(geology.PROFILE_SENTINEL_AT);
    expect(new Date(rows[0].receivedAt).toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  it('states each layer\'s own depth, needing no reading to sit on', () => {
    const { id, session } = drilledSession(0, 6);
    const result = geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 2.37, nr: SCHLUFF }, { tiefe: 4, nr: TON },
    ]);

    expect(result.geschrieben).toBe(3);
    // 2.37 m falls between two 0.5 m readings. The old shape had to move the
    // boundary onto one of them; here the depth is simply the depth.
    expect(layers(id)).toEqual([
      { tiefe: 0, nr: SAND }, { tiefe: 2.37, nr: SCHLUFF }, { tiefe: 4, nr: TON },
    ]);
  });

  it('carries the bottom of the profile, which is not recoverable downstream', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND }]);
    expect(profile(id)!.end).toBeCloseTo(6);
  });

  it('bottoms the profile on the plan when the hole stopped short of it', () => {
    const { id, session } = drilledSession(0, 4);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Säulenhöhe': 9 },
    });
    geology.commitGeology(db.getSessionById(session.id)!, [{ tiefe: 0, nr: SAND }]);
    // A reader recomputing this from the readings would answer 4.
    expect(profile(id)!.end).toBeCloseTo(9);
  });

  it('writes the ground type name as a label beside the number', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: BETON }]);
    expect(profile(id)!.layers[0]).toMatchObject({ nr: BETON, name: 'Hindernis Beton' });
  });

  it('marks a back-filled boundary with q, and leaves an observed one unmarked', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND, quelle: 'vorgabe' },
      { tiefe: 3, nr: TON, quelle: 'ist' },
    ]);
    const l = profile(id)!.layers;
    expect(l[0].q).toBe('vorgabe');
    expect(l[1].q).toBeUndefined();
  });

  it('falls back to the bare number for a code outside the DIN tables', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: 9999 }]);
    expect(profile(id)!.layers[0].name).toBe('GeoDIN 9999');
  });

  it('lets a caller override the name with its own description', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND, name: 'Sand, stark kiesig' }]);
    expect(profile(id)!.layers[0]).toMatchObject({ nr: SAND, name: 'Sand, stark kiesig' });
  });

  it('replaces an earlier commit instead of stacking a second profile', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF }]);
    const result = geology.commitGeology(session, [{ tiefe: 0, nr: TON }]);

    expect(result.ersetzt).toBe(1);
    expect(profileValues(id)).toHaveLength(1);
    expect(layers(id)).toEqual([{ tiefe: 0, nr: TON }]);
  });

  it('never removes a reading already uploaded', () => {
    // Not a flow the UI can reach — geology is committed at stop, before any
    // upload — but the guard protects platform data, so it is worth pinning.
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND }]);

    const ids = db.getSessionUploadGroups(id)
      .filter((g) => g.sensorId === PROFIL_ID)
      .flatMap((g) => g.readings.map((r) => r.id));
    db.markSessionReadingsUploaded(ids);

    const result = geology.commitGeology(session, [{ tiefe: 0, nr: TON }]);
    expect(result.ersetzt).toBe(0);
    // The uploaded value is still there, with the new one beside it.
    expect(profileValues(id)).toHaveLength(2);
  });

  it('drops a layer below anything drilled or planned', () => {
    // Validation now rather than data loss: there is no reading it failed to
    // find. But keeping it would push `end` past the hole and report ground
    // the drill never reached.
    const { id, session } = drilledSession(0, 5);
    const result = geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF }, { tiefe: 9, nr: TON },
    ]);
    expect(result.zuTief).toEqual([9]);
    expect(result.geschrieben).toBe(2);
    expect(layers(id).map((l) => l.nr)).toEqual([SAND, SCHLUFF]);
  });

  it('keeps a planned layer below the deepest reading when the plan goes deeper', () => {
    const { id, session } = drilledSession(0, 4);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Säulenhöhe': 9 },
    });
    const result = geology.commitGeology(db.getSessionById(session.id)!, [
      { tiefe: 0, nr: SAND }, { tiefe: 7, nr: TON },
    ]);
    expect(result.zuTief).toEqual([]);
    expect(layers(id).map((l) => l.nr)).toEqual([SAND, TON]);
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

    const result = geology.commitGeology(db.getSessionById(id)!, [
      { tiefe: 0, nr: SAND }, { tiefe: 5, nr: TON },
    ]);
    // 5 m is below the real hole, so the phantom must not vouch for it.
    expect(result.zuTief).toEqual([5]);
    expect(layers(id)).toHaveLength(1);
  });

  it('ignores clipped depth readings', () => {
    const id = db.createSession('E-clip', SENSOR_MAP);
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 0, null, { receivedAt: T0 });
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 2, null, { receivedAt: T0 + 1000 });
    db.insertSessionReading(
      id, 'rig/depth', DEPTH_ID, 'float', 8, null,
      { receivedAt: T0 + 2000, clipped: true },
    );

    expect(geology.commitGeology(db.getSessionById(id)!, [{ tiefe: 6, nr: TON }]).zuTief)
      .toEqual([6]);
  });

  it('writes nothing it cannot bound, and explains itself', () => {
    const id = db.createSession('E-leer', SENSOR_MAP);
    const result = geology.commitGeology(db.getSessionById(id)!, [{ tiefe: 4, nr: SAND }]);
    expect(result.geschrieben).toBe(0);
    expect(result.hinweis).toBeDefined();
    expect(profile(id)).toBeNull();
  });

  it('writes nothing when the session has no profile sensor', () => {
    const id = db.createSession('E-nop', JSON.stringify({
      bohrtiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
    }));
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 1, null, { receivedAt: T0 });

    const result = geology.commitGeology(db.getSessionById(id)!, [{ tiefe: 0, nr: SAND }]);
    expect(result.geschrieben).toBe(0);
    expect(result.hinweis).toContain('Geologieprofil');
  });

  it('skips layers with an invalid ground type rather than writing them', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 1, nr: 0 }, { tiefe: 2, nr: 1.5 },
      { tiefe: 3, nr: NaN }, { tiefe: 4, nr: TON },
    ]);
    expect(layers(id)).toEqual([{ tiefe: 0, nr: SAND }, { tiefe: 4, nr: TON }]);
  });

  it('sorts an unsorted profile', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 4, nr: TON }, { tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF },
    ]);
    expect(layers(id).map((l) => l.tiefe)).toEqual([0, 2, 4]);
  });

  it('is valid JSON an implenia-web reader can parse', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: BETON, quelle: 'vorgabe' },
    ]);
    const raw = db.getSessionSensorTextSeries(id, PROFIL_ID)[0].text;
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(['end', 'layers']);
    expect(parsed.layers[0]).toEqual({ t: 0, nr: SAND, name: 'Sand' });
    expect(parsed.layers[1]).toEqual({
      t: 2, nr: BETON, name: 'Hindernis Beton', q: 'vorgabe',
    });
  });
});

describe('recordLiveLayer', () => {
  it('stores the depth the rig was at, and reports it back', () => {
    const { id, session } = drilledSession(0, 3);
    const result = geology.recordLiveLayer(session, SAND);

    expect(result).toEqual({ tiefe: 3, receivedAt: T0 + 6000 });
    expect(db.getSessionGeology(id)).toEqual([
      { depth: 3, nr: SAND, text: null, observedAt: expect.any(Number) },
    ]);
  });

  it('is readable back as a layer at that depth', () => {
    const { session } = drilledSession(0, 4);
    geology.recordLiveLayer(session, SAND);
    expect(geology.getGeologyContext(session).beobachtet)
      .toEqual([{ tiefe: 4, nr: SAND }]);
  });

  it('keeps the operator\'s own description', () => {
    const { id, session } = drilledSession(0, 2);
    geology.recordLiveLayer(session, SAND, 'Sand, stark kiesig');
    expect(db.getSessionGeology(id)[0].text).toBe('Sand, stark kiesig');
  });

  it('replaces an earlier entry at the same depth', () => {
    // The depth stands still for the whole of a Rohrverlängerung, so every tap
    // lands on one value. Two ground types at one depth is not a profile — the
    // second tap is a correction.
    const { id, session } = drilledSession(0, 3);
    geology.recordLiveLayer(session, SAND);
    geology.recordLiveLayer(session, TON);

    expect(db.getSessionGeology(id)).toHaveLength(1);
    expect(db.getSessionGeology(id)[0].nr).toBe(TON);
  });

  it('refuses before the first depth reading, with an actionable reason', () => {
    const id = db.createSession('E-nodepth', SENSOR_MAP);
    const result = geology.recordLiveLayer(db.getSessionById(id)!, SAND);
    expect(result).toHaveProperty('fehler');
    expect((result as { fehler: string }).fehler).toContain('Bohrtiefe');
  });

  it('rejects an invalid ground type', () => {
    const { session } = drilledSession(0, 3);
    expect(geology.recordLiveLayer(session, 0)).toHaveProperty('fehler');
    expect(geology.recordLiveLayer(session, -1)).toHaveProperty('fehler');
    expect(geology.recordLiveLayer(session, 1.5)).toHaveProperty('fehler');
  });

  it('refuses once drilling has ended, instead of recording a depth nobody is at', () => {
    // The buttons and the voice commands are gated on the browser's view of
    // the mode, which a second tab does not share. The newest reading is a
    // retraction reading by then, outside the window the profile is built
    // from — so the entry would be shown as recorded and appear in nothing.
    const { id, session } = drilledSession(0, 3);
    db.setDrillingEndedAt(id, T0 + 6000);

    const result = geology.recordLiveLayer(db.getSessionById(id)!, SAND);
    expect(result).toHaveProperty('fehler');
    expect((result as { fehler: string }).fehler).toContain('Bohren');
    expect(db.getSessionGeology(id)).toEqual([]);
  });

  it('never lands on a Rohrwechsel reading', () => {
    const id = db.createSession('E-rw', SENSOR_MAP);
    db.insertSessionReading(id, 'rig/depth', DEPTH_ID, 'float', 2, null, { receivedAt: T0 });
    db.insertSessionReading(
      id, 'rig/depth', DEPTH_ID, 'float', 9, null,
      { receivedAt: T0 + 1000, phase: 'rohrwechsel' },
    );

    const result = geology.recordLiveLayer(db.getSessionById(id)!, SAND);
    expect(result).toEqual({ tiefe: 2, receivedAt: T0 });
  });
});

describe('getGeologyContext', () => {
  it('reports a drilled session as ready to confirm', () => {
    const { session } = drilledSession(0, 6);
    const ctx = geology.getGeologyContext(session);
    expect(ctx.verfuegbar).toBe(true);
    expect(ctx.gebohrt).toBe(true);
    expect(ctx.gebohrteTiefe).toBeCloseTo(6);
    expect(ctx.maxTiefe).toBeCloseTo(6);
  });

  it('reports a session that barely moved as not drilled', () => {
    const { session } = drilledSession(0, 0.2, 0.1);
    expect(geology.getGeologyContext(session).gebohrt).toBe(false);
  });

  it('reports a Verfahren without geology as unavailable, with no complaint', () => {
    roles = { depth: 'Bohrtiefe', geology_profile: null };
    const id = db.createSession('E-nogeo', JSON.stringify({
      bohrtiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
    }));
    const ctx = geology.getGeologyContext(db.getSessionById(id)!);
    expect(ctx.verfuegbar).toBe(false);
    expect(ctx.hinweis).toBeUndefined();
  });

  it('explains a geology-capable Verfahren whose session lacks the sensor', () => {
    const id = db.createSession('E-missing', JSON.stringify({
      bohrtiefe: { sensorId: DEPTH_ID, sensorType: 'float' },
    }));
    const ctx = geology.getGeologyContext(db.getSessionById(id)!);
    expect(ctx.verfuegbar).toBe(false);
    expect(ctx.hinweis).toContain('Geologieprofil');
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

  it('reads the live entries back as the observed layers', () => {
    const { id, session } = drilledSession(0, 8);
    db.insertSessionGeology(id, 0, SAND, null, T0);
    db.insertSessionGeology(id, 3, BETON, null, T0 + 1);
    db.insertSessionGeology(id, 3.5, SAND, null, T0 + 2);

    expect(geology.getGeologyContext(session).beobachtet).toEqual([
      { tiefe: 0, nr: SAND },
      { tiefe: 3, nr: BETON },
      { tiefe: 3.5, nr: SAND },
    ]);
  });

  it('does not read a committed profile back as observation', () => {
    // The commit writes the Vorgabe back-fill too. Reading the committed value
    // back would mark the plan as something the operator saw — which is what
    // `observedOnly` had to undo in the series shape. Here the back-fill never
    // enters the scratchpad, so there is nothing to undo.
    const { id, session } = drilledSession(0, 8);
    db.insertSessionGeology(id, 3, BETON, null, T0);
    geology.commitDefaultGeology(session);

    expect(geology.getGeologyContext(db.getSessionById(id)!).beobachtet)
      .toEqual([{ tiefe: 3, nr: BETON }]);
  });

  it('reports a profile the operator has signed off as bestaetigt', () => {
    const { id, session } = drilledSession(0, 6);
    expect(geology.getGeologyContext(session).bestaetigt).toBe(false);
    db.setGeologyConfirmedAt(id, Date.now());
    expect(geology.getGeologyContext(db.getSessionById(id)!).bestaetigt).toBe(true);
  });
});

describe('commitDefaultGeology', () => {
  it('back-fills the plan where nothing was confirmed', () => {
    const { id, session } = drilledSession(0, 6);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 6, 'Säulenhöhe': 6 },
    });

    const result = geology.commitDefaultGeology(db.getSessionById(id)!);
    expect(result?.geschrieben).toBeGreaterThan(0);
    // Everything came from the plan, so every layer says so.
    expect(profile(id)!.layers.every((l) => l.q === 'vorgabe')).toBe(true);
  });

  it('keeps what the operator entered live and fills only the rest', () => {
    const { id, session } = drilledSession(0, 6);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 6, 'Säulenhöhe': 6 },
    });
    db.insertSessionGeology(id, 4, SCHLUFF, null, T0);

    geology.commitDefaultGeology(db.getSessionById(id)!);
    const observed = profile(id)!.layers.filter((l) => l.q === undefined);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ t: 4, nr: SCHLUFF });
  });

  it('commits an obstruction without claiming it reached the surface', () => {
    // Extending soil upward is a mild guess that is usually right; extending
    // `Hindernis Beton` upward asserts the drill met concrete from the
    // surface. Such a profile legitimately begins below 0 — which is exactly
    // what a start depth can express and an end depth cannot.
    const { id, session } = drilledSession(0, 6);
    db.insertSessionGeology(id, 2, BETON, null, T0);

    geology.commitDefaultGeology(db.getSessionById(id)!);
    expect(profile(id)!.layers[0].t).toBeCloseTo(2);
  });

  it('commits the observations alone when there is no plan', () => {
    const { id, session } = drilledSession(0, 6);
    db.insertSessionGeology(id, 0, SAND, null, T0);
    db.insertSessionGeology(id, 3, TON, null, T0 + 1);

    geology.commitDefaultGeology(db.getSessionById(id)!);
    expect(layers(id)).toEqual([{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: TON }]);
  });

  it('does nothing for a session that never really drilled', () => {
    const { id, session } = drilledSession(0, 0.2, 0.1);
    db.insertSessionGeology(id, 0.1, SAND, null, T0);
    expect(geology.commitDefaultGeology(session)).toBeNull();
    expect(profile(id)).toBeNull();
  });

  it('does nothing when the Verfahren records no geology', () => {
    roles = { depth: 'Bohrtiefe', geology_profile: null };
    const { session } = drilledSession(0, 6);
    expect(geology.commitDefaultGeology(session)).toBeNull();
  });

  it('does nothing when there is neither a plan nor an observation', () => {
    const { session } = drilledSession(0, 6);
    expect(geology.commitDefaultGeology(session)).toBeNull();
  });

  it('is repeatable — a second call replaces the first and keeps provenance', () => {
    // The sign-off happens at the step out of `bohren`, and a step back to
    // drill deeper brings the operator through it again.
    const { id, session } = drilledSession(0, 6);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 6, 'Säulenhöhe': 6 },
    });
    db.insertSessionGeology(id, 4, SCHLUFF, null, T0);

    geology.commitDefaultGeology(db.getSessionById(id)!);
    const first = profile(id)!;
    geology.commitDefaultGeology(db.getSessionById(id)!);
    const second = profile(id)!;

    expect(profileValues(id)).toHaveLength(1);
    expect(second).toEqual(first);
    // The back-fill is still marked as back-fill on the second pass.
    expect(second.layers.some((l) => l.q === 'vorgabe')).toBe(true);
    expect(second.layers.some((l) => l.q === undefined)).toBe(true);
  });
});

describe('layers that would otherwise be lost or invented', () => {
  it('commits nothing for planned ground this session never came near', () => {
    // A resumed element whose second session starts at 8 m: a planned boundary
    // at 1 m is ground this session did not pass through.
    const { id, session } = drilledSession(8, 12);
    db.setElementVorgaben(session.element_name, {
      int_sensors: { 'Geologie 1': SAND, 'Geologie 2': TON },
      float_sensors: { 'Tiefe Geologie 1': 1, 'Tiefe Geologie 2': 12, 'Säulenhöhe': 12 },
    });

    geology.commitDefaultGeology(db.getSessionById(id)!);
    // Whatever it committed, it did not fabricate a run of 10 cm layers at the
    // top of this session's window.
    const tiefen = layers(id).map((l) => l.tiefe);
    expect(new Set(tiefen).size).toBe(tiefen.length);
  });

  it('ignores a negative depth instead of claiming ground above the surface', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: -1, nr: BETON }, { tiefe: 0, nr: SAND }]);
    expect(layers(id)).toEqual([{ tiefe: 0, nr: SAND }]);
  });

  it('keeps the shallowest planned type when a Vorgabe names no depths', () => {
    // Several layers land on one depth; keeping the last would commit the
    // deepest planned type from 0 m, which fails in the wrong direction.
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [
      { tiefe: 0, nr: SAND }, { tiefe: 0, nr: SCHLUFF }, { tiefe: 0, nr: TON },
    ]);
    expect(layers(id)).toEqual([{ tiefe: 0, nr: SAND }]);
  });
});

describe('the drilling window', () => {
  it('credits a session with the span it drilled, not the span it travelled', () => {
    const { id } = drilledSession(0, 6);
    // Retraction, recorded as drilling data because the mode never lands on a
    // reading. Without the window `min` falls toward zero and the gate gets
    // more permissive than it means to be.
    db.setDrillingEndedAt(id, T0 + 12_000);
    for (let i = 0; i < 6; i++) {
      db.insertSessionReading(
        id, 'rig/depth', DEPTH_ID, 'float', 6 - i, null,
        { receivedAt: T0 + 13_000 + i * 1000 },
      );
    }

    const ctx = geology.getGeologyContext(db.getSessionById(id)!);
    expect(ctx.gebohrteTiefe).toBeCloseTo(6);
    expect(ctx.maxTiefe).toBeCloseTo(6);
  });

  it('is open while the rig is still drilling', () => {
    const { id } = drilledSession(0, 6);
    expect(db.getSessionById(id)!.drilling_ended_at).toBeNull();
    expect(geology.getGeologyContext(db.getSessionById(id)!).gebohrt).toBe(true);
  });
});

describe('hasGeologyReadings', () => {
  it('is false for a session with nothing on record', () => {
    const { session } = drilledSession(0, 6);
    expect(geology.hasGeologyReadings(session)).toBe(false);
  });

  it('counts a live entry, even before any commit', () => {
    // The stop pairs this with `geology_confirmed_at` before it skips its own
    // back-fill: the mark says "the operator was asked", not "a profile was
    // written", and the two come apart when a commit threw.
    const { id, session } = drilledSession(0, 6);
    db.insertSessionGeology(id, 2, SAND, null, T0);
    expect(geology.hasGeologyReadings(session)).toBe(true);
  });

  it('counts a committed profile', () => {
    const { id, session } = drilledSession(0, 6);
    geology.commitGeology(session, [{ tiefe: 0, nr: SAND }]);
    expect(geology.hasGeologyReadings(db.getSessionById(id)!)).toBe(true);
  });
});
