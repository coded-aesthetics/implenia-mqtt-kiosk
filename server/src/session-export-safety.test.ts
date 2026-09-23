import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * Export bookkeeping, against real SQLite and the real DSV sensor CSV.
 *
 * A session exports one file per stream, but the reset guard reads a single
 * `exported_at` flag as "every reading of this session has been saved". The
 * bug this pins down: exporting HDI marked the whole session safe, and the
 * next reset deleted the IVL readings — never uploaded, never written to a
 * file, gone.
 */

let db: typeof import('./db.js');
let meta: typeof import('./sensor-meta.js');
let exp: typeof import('./session-export.js');

beforeAll(async () => {
  db = await import('./db.js');
  meta = await import('./sensor-meta.js');
  exp = await import('./session-export.js');
  // Interlock, belt and braces with vitest.config.ts: this suite deletes every
  // row it can reach, so it must never run against a real database.
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
});

beforeEach(() => {
  db.resetKiosk();
  meta.clearVerfahrenCache();
  // DSV is the only Verfahren whose CSV defines more than one exportable
  // stream, which is exactly the case at issue.
  meta.setActiveVerfahren('dsv');
});

/** Sensors from the DSV CSV, one per stream. */
const HDI_SENSOR = 'Anpressdruck';
const IVL_SENSOR = 'Alpha';

function sessionWithBothStreams(): number {
  const id = db.createSession('H26', '{}');
  db.insertSessionReading(id, `device/1/${HDI_SENSOR}`, 'sensor-hdi', 'float', 12.5, null);
  db.insertSessionReading(id, `device/1/${IVL_SENSOR}`, 'sensor-ivl', 'float', 1.5, null);
  return id;
}

describe('getSessionExportStreams', () => {
  it('offers only the streams that actually have readings', () => {
    const id = db.createSession('H26', '{}');
    db.insertSessionReading(id, `device/1/${HDI_SENSOR}`, 'sensor-hdi', 'float', 12.5, null);

    expect(exp.getSessionExportStreams(id).map((o) => o.stream)).toEqual(['hdi']);
  });

  it('offers both streams when both recorded something', () => {
    const id = sessionWithBothStreams();
    expect(exp.getSessionExportStreams(id).map((o) => o.stream).sort()).toEqual(['hdi', 'ivl']);
  });
});

describe('recordStreamExport', () => {
  it('leaves the session unsafe while another stream is still unexported', () => {
    const id = sessionWithBothStreams();

    const { remaining } = exp.recordStreamExport(id, 'hdi');

    expect(remaining).toEqual(['ivl']);
    // The whole point: the IVL readings are still only on this kiosk.
    expect(db.getUnsafeDataSummary()).toMatchObject({ sessions: 1, readings: 2 });
  });

  it('marks the session safe once every stream with data has been exported', () => {
    const id = sessionWithBothStreams();

    exp.recordStreamExport(id, 'hdi');
    const { remaining } = exp.recordStreamExport(id, 'ivl');

    expect(remaining).toEqual([]);
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0, clipped: 0 });
  });

  it('marks a single-stream session safe on its only export', () => {
    const id = db.createSession('H26', '{}');
    db.insertSessionReading(id, `device/1/${HDI_SENSOR}`, 'sensor-hdi', 'float', 12.5, null);

    expect(exp.recordStreamExport(id, 'hdi').remaining).toEqual([]);
    expect(db.getUnsafeDataSummary()).toEqual({ sessions: 0, readings: 0, clipped: 0 });
  });

  it('is idempotent — re-exporting the same stream does not unlock the rest', () => {
    const id = sessionWithBothStreams();

    exp.recordStreamExport(id, 'hdi');
    const { remaining } = exp.recordStreamExport(id, 'hdi');

    expect(remaining).toEqual(['ivl']);
    expect(db.getUnsafeDataSummary()).toMatchObject({ readings: 2 });
  });

  it('keeps per-session records apart', () => {
    const a = sessionWithBothStreams();
    const b = sessionWithBothStreams();

    exp.recordStreamExport(a, 'hdi');
    exp.recordStreamExport(a, 'ivl');

    expect(db.getExportedStreams(b)).toEqual([]);
    expect(db.getUnsafeDataSummary()).toMatchObject({ sessions: 1, readings: 2 });
  });
});

describe('resetKiosk', () => {
  it('clears the export records along with the sessions', () => {
    const id = sessionWithBothStreams();
    exp.recordStreamExport(id, 'hdi');

    db.resetKiosk();

    expect(db.getExportedStreams(id)).toEqual([]);
  });
});
