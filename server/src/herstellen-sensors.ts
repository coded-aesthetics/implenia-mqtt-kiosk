import { fetchImplenia } from './implenia-api.js';

/**
 * Sensor definition as returned by the Implenia API.
 */
export interface SensorDef {
  id: string;
  name: string;
  unit?: string;
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
 * Compute herstellen (production) sensors for an element by subtracting
 * vorgaben sensors from the element's full sensor set.
 *
 * The Implenia API has no dedicated "herstellen" device — it only has a
 * "vorgaben" child device. So: herstellen = allSensors − vorgabenSensors.
 */
export async function fetchHerstellenSensors(elementName: string): Promise<SensorDefs> {
  const encoded = encodeURIComponent(elementName);

  // Fetch all sensors on the element and vorgaben sensors in parallel
  const [allDefs, vorgabenDefs] = await Promise.all([
    fetchImplenia<SensorDefs>(
      `/api/v1/measuring-device/self/child/name:${encoded}`,
    ),
    fetchImplenia<SensorDefs>(
      `/api/v1/measuring-device/self/child/name:${encoded}/child/name:vorgaben`,
    ).catch(() => ({} as SensorDefs)), // vorgaben device may not exist
  ]);

  // Collect vorgaben sensor IDs for exclusion
  const vorgabenIds = new Set<string>();
  for (const key of SENSOR_KEYS) {
    for (const s of vorgabenDefs[key] ?? []) {
      vorgabenIds.add(s.id);
    }
  }

  // Subtract vorgaben from all
  const result: SensorDefs = {};
  for (const key of SENSOR_KEYS) {
    const all = allDefs[key] ?? [];
    const filtered = all.filter((s) => !vorgabenIds.has(s.id));
    if (filtered.length > 0) {
      result[key] = filtered;
    }
  }

  return result;
}
