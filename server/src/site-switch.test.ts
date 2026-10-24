import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * What moving the kiosk to the next pier does to everything it remembers per
 * element name.
 *
 * The scenario is a bridge: a row of piers, each its own BIM widget with its
 * own API key, the key switched on the way to the next one — and every pier
 * has a `P-01`. Before the site scoping, that name was the whole identity of
 * an element, so arriving at pier 2 the kiosk reported pier 1's finished
 * elements as finished, marked pier 2's untouched pillars as begun at the
 * depth pier 1's reached, and — the one that is silent — held pier 1's
 * platform sensor ids ready to be pinned into a session started offline, which
 * uploads one pier's measurements onto the pier beside it.
 *
 * Two rules carry the whole design, and both are asserted here rather than
 * inferred: nothing is deleted on a switch (a pier keeps its rows under its own
 * id, so going back brings them back — including the only route its pending
 * measurements have to the platform), and `default` rows, which mean "recorded
 * before this kiosk knew which site it was on", are adopted by the first key.
 */

let db: typeof import('./db.js');
let site: typeof import('./site.js');

const PIER_1 = 'key-for-pier-1';
const PIER_2 = 'key-for-pier-2';

/** Hand the kiosk a pier's API key, the way the config page does. */
function moveTo(apiKey: string): void {
  db.setMeta('implenia_api_key', apiKey);
  db.setMeta('implenia_api_url', 'http://platform.test');
  site.syncSite();
}

const SENSOR_MAP = JSON.stringify({
  tiefe: { sensorId: 'pier-1-tiefe', sensorType: 'float', name: 'Tiefe', role: 'depth' },
});

/** A finished element: recorded, ended, uploaded. */
function completeElement(name: string, tiefe: number): number {
  const id = db.createSession(name, SENSOR_MAP);
  db.setSessionMaxDepth(id, tiefe);
  db.endSession(id, 'ended');
  db.updateSessionStatus(id, 'uploaded');
  return id;
}

beforeAll(async () => {
  db = await import('./db.js');
  site = await import('./site.js');

  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
});

beforeEach(() => {
  // Sessions, both element caches and every meta key but the credentials — so
  // each test starts as a kiosk that has never been given a key.
  db.resetKiosk();
  db.deleteMeta('current_site_id');
  db.deleteMeta('implenia_api_key');
  db.deleteMeta('implenia_api_url');
});

describe('the reported symptoms', () => {
  it('leaves pier 1\'s finished elements behind when the key changes', () => {
    moveTo(PIER_1);
    completeElement('P-01', 8.2);
    expect(db.getCompletedElements().map((e) => e.elementName)).toEqual(['P-01']);

    moveTo(PIER_2);
    expect(db.getCompletedElements()).toEqual([]);
  });

  it('does not mark pier 2\'s P-01 as begun because pier 1\'s was', () => {
    moveTo(PIER_1);
    completeElement('P-01', 8.2);
    expect(db.getStartedElements().map((e) => e.elementName)).toEqual(['P-01']);

    moveTo(PIER_2);
    // The tile for pier 2's P-01 must say nothing at all. Saying "bis 8,20 m"
    // about a hole nobody has opened is how an element gets drilled twice.
    expect(db.getStartedElements()).toEqual([]);
  });

  it('brings pier 1 back, in full, when its key is put back', () => {
    moveTo(PIER_1);
    completeElement('P-01', 8.2);
    moveTo(PIER_2);
    completeElement('P-01', 3.5);

    moveTo(PIER_1);
    expect(db.getStartedElements()).toEqual([
      expect.objectContaining({ elementName: 'P-01', tiefe: 8.2 }),
    ]);
    moveTo(PIER_2);
    expect(db.getStartedElements()).toEqual([
      expect.objectContaining({ elementName: 'P-01', tiefe: 3.5 }),
    ]);
  });

  it('keeps both piers\' sessions on the machine — nothing is deleted', () => {
    moveTo(PIER_1);
    completeElement('P-01', 8.2);
    moveTo(PIER_2);
    completeElement('P-01', 3.5);

    // Unscoped on purpose: the upload loop and the recording bar ask "what is
    // still waiting here", which is a question about the machine, not the site.
    expect(db.getSessions()).toHaveLength(2);
  });
});

describe('the phase a resumed element reopens on', () => {
  it('is pier 2\'s own, not the identically-named pillar it left behind', () => {
    moveTo(PIER_1);
    const first = db.createSession('P-01', SENSOR_MAP);
    db.setOperatingModeRow(first, 'auffuellen');
    db.endSession(first, 'ended');

    moveTo(PIER_2);
    expect(db.getLastSessionForElement('P-01')).toBeNull();

    const second = db.createSession('P-01', SENSOR_MAP);
    expect(db.getLastSessionForElement('P-01')?.id).toBe(second);
    expect(db.getLastSessionForElement('P-01')?.operating_mode).toBe('bohren');
  });
});

describe('the caches that decide where measurements land', () => {
  it('never hands pier 2 pier 1\'s platform sensor ids', () => {
    // The silent one. These ids are pinned into the session at
    // `beginRecording` and readings upload to `/sensor-float/<id>/batch`, so a
    // leaked id does not fail — it uploads pier 2's drilling onto pier 1's
    // pillar, and nothing anywhere says so.
    moveTo(PIER_1);
    db.setElementSensors('P-01', { sensors_float: [{ id: 'pier-1-tiefe', name: 'Tiefe' }] });

    moveTo(PIER_2);
    expect(db.getElementSensors('P-01')).toBeNull();

    db.setElementSensors('P-01', { sensors_float: [{ id: 'pier-2-tiefe', name: 'Tiefe' }] });
    expect(db.getElementSensors('P-01')).toEqual({
      sensors_float: [{ id: 'pier-2-tiefe', name: 'Tiefe' }],
    });

    moveTo(PIER_1);
    expect(db.getElementSensors('P-01')).toEqual({
      sensors_float: [{ id: 'pier-1-tiefe', name: 'Tiefe' }],
    });
  });

  it('never shows pier 2 pier 1\'s Soll values', () => {
    moveTo(PIER_1);
    db.setElementVorgaben('P-01', { float_sensors: { Tiefe: 12 } });

    moveTo(PIER_2);
    expect(db.getElementVorgaben('P-01')).toBeNull();
  });

  it('scopes the shift assignment and the imported file by site', () => {
    moveTo(PIER_1);
    const pier1Key = db.siteMetaKey('imported_shift_assignment');
    db.setMeta(pier1Key, '{"measuring_devices":[]}');

    moveTo(PIER_2);
    const pier2Key = db.siteMetaKey('imported_shift_assignment');
    expect(pier2Key).not.toBe(pier1Key);
    expect(db.getMeta(pier2Key)).toBeUndefined();

    // Scoped rather than cleared: an operator on an offline site must never
    // have to re-import a file to undo a key change.
    moveTo(PIER_1);
    expect(db.getMeta(db.siteMetaKey('imported_shift_assignment'))).toBe(
      '{"measuring_devices":[]}',
    );
  });
});

describe('what the first key adopts', () => {
  it('takes over everything recorded before the kiosk knew its site', () => {
    // Two cases at once: a kiosk updating into this version, whose rows all
    // read `default`, and one set up offline from an imported Schichtauftrag
    // and keyed afterwards. Both would otherwise watch their recordings drop
    // out of the element list the moment a technician typed the key in.
    completeElement('P-01', 8.2);
    db.setElementSensors('P-01', { sensors_float: [{ id: 'sensor-1', name: 'Tiefe' }] });
    db.setElementVorgaben('P-01', { float_sensors: { Tiefe: 12 } });
    db.setMeta('imported_shift_assignment', '{"measuring_devices":[]}');
    expect(db.currentSiteId()).toBe(db.DEFAULT_SITE);

    moveTo(PIER_1);

    expect(db.getCompletedElements().map((e) => e.elementName)).toEqual(['P-01']);
    expect(db.getElementSensors('P-01')).not.toBeNull();
    expect(db.getElementVorgaben('P-01')).not.toBeNull();
    expect(db.getMeta(db.siteMetaKey('imported_shift_assignment'))).toBe(
      '{"measuring_devices":[]}',
    );
    // Moved, not copied: a stale unscoped key would be adopted a second time
    // by the next pier.
    expect(db.getMeta('imported_shift_assignment')).toBeUndefined();
  });

  it('adopts nothing from one real site to another', () => {
    moveTo(PIER_1);
    completeElement('P-01', 8.2);
    moveTo(PIER_2);
    expect(db.getCompletedElements()).toEqual([]);

    // And the rows are still pier 1's, not re-stamped to pier 2.
    moveTo(PIER_1);
    expect(db.getCompletedElements().map((e) => e.elementName)).toEqual(['P-01']);
  });
});

describe('syncSite', () => {
  it('reports whether the kiosk actually moved', () => {
    db.setMeta('implenia_api_key', PIER_1);
    db.setMeta('implenia_api_url', 'http://platform.test');
    expect(site.syncSite()).toBe(true);
    expect(site.syncSite()).toBe(false);
  });

  it('leaves the site alone when there is no key', () => {
    // A wrong key entered on the config page is saved, fails validation and is
    // deleted again. Returning to `default` there would orphan the real site's
    // history until somebody happened to retype its key.
    moveTo(PIER_1);
    const onPier1 = db.currentSiteId();

    db.deleteMeta('implenia_api_key');
    expect(site.syncSite()).toBe(false);
    expect(db.currentSiteId()).toBe(onPier1);
  });
});

describe('siteFingerprint', () => {
  it('is stable, distinct per key, and does not carry the key', () => {
    const fp = site.siteFingerprint(PIER_1);
    expect(fp).toBe(site.siteFingerprint(PIER_1));
    expect(fp).not.toBe(site.siteFingerprint(PIER_2));
    // It lands in log lines, in session rows and in meta keys, all of which
    // service personnel read.
    expect(fp).not.toContain(PIER_1);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});
