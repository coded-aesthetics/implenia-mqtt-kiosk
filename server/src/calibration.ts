/**
 * Per-sensor linear calibration.
 *
 * A reading does not always arrive in the unit the sensor is supposed to be
 * in. The depth on a retrofitted rig is the clearest case — its sensor sits on
 * the feed mechanism, so the carriage travels about 2.6 m per metre of hole —
 * but the same happens wherever a channel was scaled for a different machine,
 * wired to a different transducer, or simply never calibrated.
 *
 *     wert = rohwert × scale + offset
 *
 * Belongs on the machine, and should be fixed there when it can be. Until then
 * the kiosk must be able to record correct values from a rig nobody can take
 * out of service, so every float sensor carries a scale and an offset. They
 * default to their neutral elements — 1 and 0 — so a sensor nobody has touched
 * behaves exactly as it always did.
 *
 * Calibration is keyed by **sensor name**, not topic: it is a property of what
 * is being measured, so it survives a technician rebinding which topic feeds
 * the sensor.
 */

import { getCalibrations, type CalibrationRow } from './db.js';

export interface Calibration {
  scale: number;
  offset: number;
}

export const NEUTRAL: Calibration = { scale: 1, offset: 0 };

export function isNeutral(c: Calibration): boolean {
  return c.scale === 1 && c.offset === 0;
}

/** `raw × scale + offset`, or the raw value when there is nothing to apply. */
export function applyCalibration(raw: number, c: Calibration): number {
  if (!Number.isFinite(raw)) return raw;
  return raw * c.scale + c.offset;
}

export type TareResult =
  | { ok: true; offset: number }
  | { ok: false; error: string };

/**
 * How old the reading being tared against may be.
 *
 * Taring cancels *what the sensor is reading now*, so the value has to be now.
 * The broker dropping out does not empty the observation buffer — the last
 * value simply stops changing — and cancelling a reading from minutes ago
 * would write that stale number into every measurement the rig records from
 * then on. Rigs publish several times a second, so a few seconds is generous.
 */
export const TARE_MAX_AGE_MS = 10_000;

export type CalibrationValidation =
  | { ok: true; value: Calibration }
  | { ok: false; error: string };

/**
 * Validate what the calibration screen submitted.
 *
 * The messages are German and say what to do, because a technician on site
 * reads them and cannot call anyone.
 */
export function validateCalibration(scale: unknown, offset: unknown): CalibrationValidation {
  const s = typeof scale === 'number' ? scale : Number(scale);
  const o = typeof offset === 'number' ? offset : Number(offset);

  if (!Number.isFinite(s)) {
    return { ok: false, error: 'Der Faktor muss eine Zahl sein, z. B. 1 oder 0,379.' };
  }
  if (s === 0) {
    // Every reading would become the offset, and the original value could not
    // be recovered from what gets stored.
    return {
      ok: false,
      error:
        'Der Faktor darf nicht 0 sein — damit wäre jeder Messwert gleich. ' +
        'Für „keine Umrechnung" ist der Faktor 1.',
    };
  }
  if (!Number.isFinite(o)) {
    return { ok: false, error: 'Der Versatz muss eine Zahl sein, z. B. 0 oder -1,5.' };
  }

  return { ok: true, value: { scale: s, offset: o } };
}

/**
 * The offset that makes whatever is arriving right now read zero.
 *
 * A pressure or load channel often sits at a non-zero idle value — the machine
 * is at rest and the kiosk shows 3,4 bar — and the correction is simply to
 * subtract that baseline. Doing it by hand means reading a live number off the
 * screen, negating it and typing it back, which is exactly the kind of
 * arithmetic a technician should not be doing on a rig.
 *
 * The scale is applied first, so the offset cancels the *scaled* value: with
 * `wert = rohwert × scale + offset`, the reading goes to 0 only for
 * `offset = -(rohwert × scale)`. Rounded to six decimals so the field shows
 * `-3,4` rather than the float noise of the same number.
 *
 * `ageMs` is how long ago that reading arrived. A stale one is refused rather
 * than used — see TARE_MAX_AGE_MS.
 */
export function tareOffset(
  raw: number | null | undefined,
  scale: number,
  ageMs?: number | null,
): TareResult {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return {
      ok: false,
      error:
        'Für diesen Sensor kommt gerade kein Messwert an. Bitte prüfen, ob dem ' +
        'Sensor ein Topic zugeordnet ist und das Gerät sendet, dann erneut nullen.',
    };
  }
  if (ageMs !== undefined && ageMs !== null && ageMs > TARE_MAX_AGE_MS) {
    const seconds = Math.round(ageMs / 1000);
    return {
      ok: false,
      error:
        `Der letzte Messwert für diesen Sensor ist ${seconds} Sekunden alt — ` +
        'die Verbindung zum Gerät ist vermutlich unterbrochen. Auf einen aktuellen ' +
        'Wert warten und dann erneut nullen.',
    };
  }
  if (!Number.isFinite(scale) || scale === 0) {
    return { ok: false, error: 'Der Faktor muss eine Zahl ungleich 0 sein, z. B. 1 oder 0,379.' };
  }
  return { ok: true, offset: Number((-(raw * scale)).toFixed(6)) };
}

/**
 * Calibrations by lowercased sensor name.
 *
 * Read on the hot path — once per reading — so it is cached, and the config
 * route clears it on write. There is no TTL: a stale calibration silently
 * changes recorded measurements, so it must take effect exactly when saved and
 * not a few seconds later.
 */
let cache: Map<string, Calibration> | null = null;

export function getCalibrationMap(): Map<string, Calibration> {
  if (cache) return cache;
  const map = new Map<string, Calibration>();
  for (const row of getCalibrations() as CalibrationRow[]) {
    map.set(row.sensorName.toLowerCase(), { scale: row.scale, offset: row.offset });
  }
  cache = map;
  return cache;
}

/** The calibration for a resolved sensor key, neutral when none is stored. */
export function calibrationFor(sensorKey: string | null): Calibration {
  if (!sensorKey) return NEUTRAL;
  return getCalibrationMap().get(sensorKey.toLowerCase()) ?? NEUTRAL;
}

export function clearCalibrationCache(): void {
  cache = null;
}
