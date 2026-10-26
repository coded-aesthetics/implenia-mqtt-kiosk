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

/**
 * Every live value, keyed by every name it can be reached under: the sensor
 * the server resolved the topic to, the topic's last segment, and the whole
 * topic.
 *
 * **All keys are lowercased**, which is why every read goes through
 * `sensorValue()` rather than `.get()`. The server's answer is a recording
 * sensor-map key and therefore lowercase (`resolveSensorKey`), while every
 * caller holds a CSV name in its original case — so keying it as it arrives
 * left a `plc/ch05` wired to `Drehzahl` resolving correctly for the upload and
 * reading 0 on screen, a case-only miss on a name that otherwise matched
 * exactly. Normalising both sides is what actually closes that hole; it also
 * makes a topic wired in a different case than the CSV resolve.
 */
export function buildSensorValues(readings: Map<string, SensorReading>): Map<string, number> {
  const map = new Map<string, number>();
  const setze = (key: string | null | undefined, wert: number): void => {
    const k = key?.trim().toLowerCase();
    if (k) map.set(k, wert);
  };
  for (const r of readings.values()) {
    const n = parseFloat(r.payload);
    const val = Number.isFinite(n) ? n : 0;
    setze(r.topic, val);
    const slashIdx = r.topic.lastIndexOf('/');
    if (slashIdx >= 0) setze(r.topic.substring(slashIdx + 1), val);
    setze(r.sensor, val);
  }
  return map;
}

/**
 * Where a slot reads its live value from.
 *
 * `sensor` is the **CSV sensor name**, and it is the one that works on every
 * rig: the server tags each reading with the sensor its topic resolved to, so
 * a channel a technician wired in the Sensorzuordnung is reachable under this
 * name whatever the box happens to call the topic. See `buildSensorValues`.
 *
 * `topic` is what the reference box publishes the same channel under, kept as
 * a fallback for a kiosk whose topic resolves to nothing — a bench setup, a
 * replay file, a box whose Verfahren is not the one being displayed. It is
 * **not** a substitute for `sensor`: every slot here was keyed by `topic`
 * alone until 2026-10-26, which worked on the one retrofitted rig the shipped
 * topic map was written from (`Bohrgeraet/Tiefe`, `Maschine/Druck_*`) and read
 * **0,00 m** on every other machine. The depth was the expensive one: the hero
 * is also the tap target for the depth correction, so the correction screen
 * opened on "Es liegt noch kein Tiefenmesswert vor" while the server had the
 * depth all along and was recording it correctly.
 */
export interface Kanal {
  /** The CSV sensor name — how a wired topic is reached on any rig. */
  sensor: string;
  /** The reference box's topic for the same channel. Fallback only. */
  topic?: string;
}

/**
 * The value of a sensor out of `buildSensorValues`, by name or topic.
 *
 * The only correct way to read that map — see the note there. `undefined` when
 * nothing has arrived, so a caller's own `?? 0` still decides what a missing
 * value looks like.
 *
 * **Several names may be given, and the first that has a value wins.** A
 * screen slot names the CSV sensor first and the topic the reference box
 * publishes it under second, because only the former works on a rig whose
 * topics were wired on site — see `Kanal` above for what the second one is
 * still there for.
 */
export function sensorValue(
  values: Map<string, number>,
  ...names: (string | null | undefined)[]
): number | undefined {
  for (const name of names) {
    if (!name) continue;
    const wert = values.get(name.trim().toLowerCase());
    if (wert !== undefined) return wert;
  }
  return undefined;
}

/**
 * The live reading of a sensor, found by name.
 *
 * Three ways a topic can carry a sensor, in the order the server resolves
 * them: the sensor key it resolved the topic to (what the Sensorzuordnung
 * wired, and the only one that works for an opaque topic), the topic's last
 * segment, and the whole topic. Within one rank the newest wins.
 *
 * Returns the reading rather than the number because the caller needs
 * `receivedAt` too: a frozen angle shown as if it were live is worse than no
 * angle at all.
 */
export function findSensorReading(
  readings: Map<string, SensorReading>,
  sensorName: string,
): SensorReading | null {
  const wanted = sensorName.trim().toLowerCase();
  if (!wanted) return null;

  let best: SensorReading | null = null;
  let bestRank = Infinity;

  for (const r of readings.values()) {
    const topic = r.topic.toLowerCase();
    const segment = topic.split('/').pop() ?? '';
    const rank =
      r.sensor != null && r.sensor.toLowerCase() === wanted ? 0
        : segment === wanted ? 1
          : topic === wanted ? 2
            : Infinity;
    if (rank === Infinity) continue;
    if (rank < bestRank || (rank === bestRank && best !== null && r.receivedAt > best.receivedAt)) {
      best = r;
      bestRank = rank;
    }
  }

  return best;
}

/** The numeric value of `findSensorReading`, or null when it is not a number. */
export function findSensorNumber(
  readings: Map<string, SensorReading>,
  sensorName: string,
): { value: number; receivedAt: number } | null {
  const reading = findSensorReading(readings, sensorName);
  if (!reading) return null;
  const n = parseFloat(reading.payload);
  if (!Number.isFinite(n)) return null;
  return { value: n, receivedAt: reading.receivedAt };
}
