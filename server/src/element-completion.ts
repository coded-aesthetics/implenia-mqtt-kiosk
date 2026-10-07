/**
 * Element completion (`Ausführungsdatum`) — the write side of a convention
 * shared with implenia-machine-backend and implenia-web.
 *
 * An element counts as produced when its `Ausführungsdatum` string sensor (CSV
 * role `is_completed`) holds a non-empty value. Three properties of the write
 * matter, and all three are load-bearing for other projects:
 *
 * 1. **The reading is dated at a sentinel, not "now".** The backend's insert is
 *    `ON CONFLICT (sensor_id, date) DO UPDATE`, so a fixed date makes completion
 *    a single upserted slot per element instead of a time series. Without it,
 *    clearing cannot work: every reader asks whether *any* non-empty value
 *    exists, and yesterday's row would keep the element finished forever.
 *    2000-01-01T00:00:00Z is the same sentinel implenia-web uses for
 *    materialized per-element values (`MATERIALIZATION_SENTINEL_DATE`).
 *
 * 2. **The value is a full ISO 8601 timestamp, and it doubles as a data-version
 *    stamp.** Every successful upload rewrites it, so the value says "the
 *    element's data was last completed at this instant". implenia-web stores the
 *    stamp it last materialized from in `MeasuringDevice.config`
 *    (`__dsv_materialized`) and recomputes its derived values whenever the two
 *    differ — that is how appending to an already-completed element gets
 *    protocol totals, drilling stats and the BIM widget recomputed. A
 *    date-only value would be too coarse: a pillar interrupted and finished in
 *    the same shift would write the same value twice and web would skip the
 *    recompute.
 *
 * 3. **Cleared is an empty string, never `null`.** The batch endpoint types
 *    `string_sensors` as `map[string]string` and rejects a null body with a 422
 *    (`expected string`). Empty un-completes the element (rework path) and
 *    makes web drop its materialization flag.
 *
 * See the "Element completion" section in CLAUDE.md — the same text lives in
 * all three repos — before changing any of this.
 */

import { withElementDevice } from './element-device.js';
import { fetchImplenia } from './implenia-api.js';
import { findSensorNameByRole } from './sensor-meta.js';

/**
 * The date every `Ausführungsdatum` reading is written at, so repeated writes
 * overwrite one row rather than appending to a history.
 */
export const COMPLETION_SENTINEL_DATE = '2000-01-01T00:00:00Z';

/** The sensor carrying completion for the configured Verfahren, if it has one. */
export function findCompletionSensorName(): string | null {
  return findSensorNameByRole('is_completed');
}

/**
 * The value written when an element's data is complete: an ISO 8601 instant
 * (`2026-10-07T07:14:22.000Z`), which readers treat both as the execution date
 * and as the version of the element's data. UTC with a `Z` suffix, like the
 * `Zeitpunkt` column of the session export; consumers render it in
 * Europe/Berlin.
 */
export function completionStamp(now: Date = new Date()): string {
  return now.toISOString();
}

/** The batch-readings body for setting (a stamp) or clearing (`''`). */
export function completionBody(
  completionSensor: string,
  value: string,
): { string_sensors: Record<string, string>; timestamp: string } {
  return {
    string_sensors: { [completionSensor]: value },
    timestamp: COMPLETION_SENTINEL_DATE,
  };
}

/**
 * Write the element's completion value. Throws on API failure — every caller
 * is expected to stay usable when the write does not land, because a stale
 * completion flag must never block the next recording.
 *
 * By resolved device id, not by `name:<element>`: the batch endpoint does not
 * accept the reference form. See element-device.ts.
 */
export async function writeElementCompletion(
  elementName: string,
  completionSensor: string,
  value: string,
): Promise<void> {
  await withElementDevice(elementName, (deviceId) =>
    fetchImplenia(
      `/api/v1/measuring-device/${deviceId}/readings/batch`,
      { method: 'POST', body: completionBody(completionSensor, value) },
    ),
  );
}
