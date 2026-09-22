import { fetchImplenia } from './implenia-api.js';
import { getSensorMetaLookup } from './sensor-meta.js';

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

/** Sources the kiosk itself produces a value for, and must therefore upload. */
const RECORDABLE_SOURCES = new Set(['mqtt', 'kiosk', 'user']);

/**
 * Should this sensor be part of the recording session's sensor map?
 *
 * `user` belongs here even though nothing arrives over the wire for it: the
 * worker enters it on the touchscreen. Injektionsbohren's `Status` is the
 * case that matters — it drives every phase-segmented KPI, the protocol and
 * the "produced" check in implenia-web. Leaving `user` out meant a Status
 * reading was stored with a null sensor_id and silently never uploaded.
 *
 * `server` stays out: those values are computed by the platform after upload.
 */
export function isRecordableSensor(
  sensor: { id: string; meta?: SensorMeta | null },
  vorgabenIds: ReadonlySet<string>,
): boolean {
  if (sensor.meta != null && sensor.meta.source != null) {
    return RECORDABLE_SOURCES.has(sensor.meta.source);
  }
  // Legacy fallback (pre-migration devices, no meta): everything that is not
  // a vorgaben sensor.
  return !vorgabenIds.has(sensor.id);
}

/**
 * Compute herstellen (production) sensors for an element.
 *
 * Two modes, chosen per-sensor based on whether `meta` is present:
 *
 * — Meta-aware (new devices): include sensors the kiosk produces a value for
 *   (see isRecordableSensor).
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

  const csvMeta = getSensorMetaLookup();

  const result: SensorDefs = {};
  for (const key of SENSOR_KEYS) {
    const all = allDefs[key] ?? [];
    const filtered = all.filter((s) => {
      // Enrich with CSV metadata where the API doesn't provide it
      const csv = csvMeta.get(s.name);
      if (csv) {
        if (!s.meta) s.meta = {};
        if (!s.meta.source && csv.source) s.meta.source = csv.source;
        if (!s.meta.role && csv.role) s.meta.role = csv.role;
        if (!s.meta.priority && csv.priority) s.meta.priority = csv.priority;
        if (!s.unit && csv.unit) s.unit = csv.unit;
      }

      return isRecordableSensor(s, vorgabenIds);
    });
    if (filtered.length > 0) {
      result[key] = filtered;
    }
  }

  return result;
}
