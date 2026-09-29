import type { VorgabenData } from '../hooks/useImplenia';
import type { SensorReading } from '../hooks/useWebSocket';

export function findSoll(vorgaben: VorgabenData | null, sensorName: string): number | null {
  if (!vorgaben) return null;
  const fv = vorgaben.float_sensors?.[sensorName];
  if (typeof fv === 'number' && Number.isFinite(fv)) return fv;
  const iv = vorgaben.int_sensors?.[sensorName];
  if (typeof iv === 'number' && Number.isFinite(iv)) return iv;
  return null;
}

export function buildSensorValues(readings: Map<string, SensorReading>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of readings.values()) {
    const n = parseFloat(r.payload);
    const val = Number.isFinite(n) ? n : 0;
    map.set(r.topic, val);
    const slashIdx = r.topic.lastIndexOf('/');
    if (slashIdx >= 0) {
      map.set(r.topic.substring(slashIdx + 1), val);
    }
  }
  return map;
}
