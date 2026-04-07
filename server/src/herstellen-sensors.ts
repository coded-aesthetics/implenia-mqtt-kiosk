import { fetchImplenia } from './implenia-api.js';

export interface SensorMeta {
  source?: string;   // "mqtt" | "kiosk" | "user" | "server"
  role?: string;     // e.g. "depth", "is_completed"
  priority?: string; // "hero" | "primary" | "secondary"
}

/**
 * Sensor definition as returned by the Implenia API.
 */
export interface SensorDef {
  id: string;
  name: string;
  unit?: string;
  meta?: SensorMeta | null;
}

export interface SensorDefs {
  sensors_float?: SensorDef[];
  sensors_int?: SensorDef[];
  sensors_string?: SensorDef[];
  sensors_geo?: SensorDef[];
}

/** The sensor type keys we support. */
const SENSOR_KEYS = ['sensors_float', 'sensors_int', 'sensors_string', 'sensors_geo'] as const;

/**
 * Compute herstellen (production) sensors for an element.
 *
 * Two modes, chosen per-sensor based on whether `meta` is present:
 *
 * — Meta-aware (new devices): include sensors where meta.source is "mqtt" or
 *   "kiosk". These are sensors the kiosk can display in the live view.
 *
 * — Legacy fallback (pre-migration devices): meta is null/absent. Fall back to
 *   the original strategy: herstellen = allSensors − vorgabenSensors.
 *
 * Both modes can be active on the same element — each sensor is evaluated
 * independently based on its own meta field.
 */
export async function fetchHerstellenSensors(elementName: string): Promise<SensorDefs> {
  const encoded = encodeURIComponent(elementName);

  // Fetch all sensors and vorgaben sensors in parallel.
  // Vorgaben fetch is always done — needed for the legacy fallback path and for
  // mixed devices where only some sensors have been migrated.
  const [allDefs, vorgabenDefs] = await Promise.all([
    fetchImplenia<SensorDefs>(
      `/api/v1/measuring-device/self/child/name:${encoded}`,
    ),
    fetchImplenia<SensorDefs>(
      `/api/v1/measuring-device/self/child/name:${encoded}/child/name:vorgaben`,
    ).catch(() => ({} as SensorDefs)),
  ]);

  // Build vorgaben ID set for the legacy fallback path.
  const vorgabenIds = new Set<string>();
  for (const key of SENSOR_KEYS) {
    for (const s of vorgabenDefs[key] ?? []) {
      vorgabenIds.add(s.id);
    }
  }

  const LIVE_SOURCES = new Set(['mqtt', 'kiosk']);

  const result: SensorDefs = {};
  for (const key of SENSOR_KEYS) {
    const all = allDefs[key] ?? [];
    const filtered = all.filter((s) => {
      if (s.meta != null) {
        // Meta-aware path: only live-source sensors belong in the herstellen view.
        return s.meta.source != null && LIVE_SOURCES.has(s.meta.source);
      }
      // Legacy fallback: include if not a vorgaben sensor.
      return !vorgabenIds.has(s.id);
    });
    if (filtered.length > 0) {
      result[key] = filtered;
    }
  }

  return result;
}
