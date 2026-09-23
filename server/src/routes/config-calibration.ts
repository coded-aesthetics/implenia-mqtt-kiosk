import type { FastifyInstance } from 'fastify';
import {
  applyCalibration, clearCalibrationCache, getCalibrationMap, validateCalibration,
  tareOffset, NEUTRAL,
} from '../calibration.js';
import { getCalibrations, setCalibration, deleteCalibration, getObservedTopics } from '../db.js';
import { parsePayload } from '../parse-payload.js';
import { getActiveVerfahren, loadSensorCsv } from '../sensor-meta.js';
import { getResolverContext, resolveSensorKey } from '../topic-resolver.js';
import { checkKnownSensor } from './sensor-guard.js';
import { createLogger } from '../logger.js';

// Logs as 'config', not as this file's name: /api/logs?module=config is how
// service personnel filter these, and splitting the file must not split that.
const log = createLogger('config');

/**
 * The last raw value per sensor, resolved exactly the way the live path
 * resolves an incoming topic. Used by the calibration screen and by taring, so
 * both see the same number the recording would see.
 *
 * `ageMs` travels with each value and is the point of the window being five
 * minutes rather than five seconds: the screen should keep showing the last
 * reading when the broker hiccups, clearly marked as old, while taring against
 * one has to be refused. Only the caller knows which of the two it is.
 */
interface LiveRaw {
  topic: string;
  raw: number | null;
  /** How long ago this value arrived. */
  ageMs: number;
}

function liveRawBySensor(): Map<string, LiveRaw> {
  const ctx = getResolverContext();
  const now = Date.now();
  const latest = new Map<string, LiveRaw>();
  for (const t of getObservedTopics(now - 5 * 60_000)) {
    const key = resolveSensorKey(t.topic, ctx);
    if (key) {
      latest.set(key.toLowerCase(), {
        topic: t.topic,
        raw: parsePayload(t.lastPayload).valueNumeric,
        ageMs: Math.max(0, now - t.lastSeen),
      });
    }
  }
  return latest;
}

/** Per-sensor linear calibration, and taring against the live raw value. */
export function registerCalibrationRoutes(app: FastifyInstance): void {
  /**
   * Every float sensor of this Verfahren with its scale and offset, and what
   * it is reading right now — raw and calibrated.
   *
   * The live value is what makes this usable: a technician sets a factor by
   * comparing the kiosk against the display on the rig, not by arithmetic.
   */
  app.get('/api/config/calibration', async () => {
    const verfahren = getActiveVerfahren();
    const rows = verfahren ? loadSensorCsv(verfahren) ?? [] : [];
    const stored = getCalibrationMap();
    const latest = liveRawBySensor();

    const sensors = rows
      .filter((r) => r.type.trim() === 'Double')
      .map((r) => {
        const key = r.name.toLowerCase();
        const cal = stored.get(key) ?? NEUTRAL;
        const live = latest.get(key);
        const raw = live?.raw ?? null;
        return {
          name: r.name,
          unit: r.unit,
          source: r.source,
          scale: cal.scale,
          offset: cal.offset,
          topic: live?.topic ?? null,
          raw,
          // So the screen can mark a value as old instead of presenting a
          // four-minute-old reading as what the sensor is doing right now.
          rawAgeMs: raw === null ? null : live?.ageMs ?? null,
          calibrated: raw === null ? null : applyCalibration(raw, cal),
        };
      });

    return { verfahren, sensors, calibrated: getCalibrations().length };
  });

  app.put<{ Body: { sensorName?: string; scale?: unknown; offset?: unknown } }>(
    '/api/config/calibration',
    async (request, reply) => {
      const sensorName = request.body?.sensorName?.trim();
      if (!sensorName) {
        return reply.status(400).send({ error: 'Es wurde kein Sensor angegeben.' });
      }

      const check = checkKnownSensor(sensorName);
      if (!check.ok) return reply.status(check.status).send({ error: check.error });

      const result = validateCalibration(request.body?.scale, request.body?.offset);
      if (!result.ok) return reply.status(400).send({ error: result.error });

      setCalibration(sensorName, result.value.scale, result.value.offset);
      // No TTL on the cache: a calibration changes recorded measurements, so
      // it has to take effect on the very next reading.
      clearCalibrationCache();
      log.info(
        'Calibration for %s set to ×%s %s%s',
        sensorName, result.value.scale,
        result.value.offset >= 0 ? '+' : '', result.value.offset,
      );
      return reply.send({ sensorName, ...result.value });
    },
  );

  /**
   * Zero a sensor: store the offset that cancels whatever it is reading right
   * now (`-(rohwert × Faktor)`).
   *
   * The raw value is read here rather than taken from the request, so what
   * gets cancelled is the reading at the moment of the tap and not whatever
   * the screen last polled up to a few seconds earlier. The factor may come
   * from the form — a technician typically sets the factor and zeroes in one
   * go, before saving — and falls back to the stored one.
   */
  app.post<{ Params: { sensorName: string }; Body: { scale?: unknown } }>(
    '/api/config/calibration/:sensorName/tare',
    async (request, reply) => {
      const sensorName = request.params.sensorName.trim();

      const check = checkKnownSensor(sensorName);
      if (!check.ok) return reply.status(check.status).send({ error: check.error });

      const stored = getCalibrationMap().get(sensorName.toLowerCase()) ?? NEUTRAL;
      const scale = request.body?.scale === undefined
        ? stored.scale
        : Number(typeof request.body.scale === 'string'
          ? request.body.scale.replace(',', '.')
          : request.body.scale);

      const live = liveRawBySensor().get(sensorName.toLowerCase());
      const result = tareOffset(live?.raw ?? null, scale, live?.ageMs ?? null);
      if (!result.ok) return reply.status(409).send({ error: result.error });

      setCalibration(sensorName, scale, result.offset);
      clearCalibrationCache();
      log.info(
        'Calibration for %s tared: raw=%s, scale=%s, offset=%s',
        sensorName, live?.raw, scale, result.offset,
      );
      return reply.send({
        sensorName, scale, offset: result.offset, raw: live?.raw ?? null, topic: live?.topic ?? null,
      });
    },
  );

  app.delete<{ Params: { sensorName: string } }>(
    '/api/config/calibration/:sensorName',
    async (request, reply) => {
      deleteCalibration(request.params.sensorName);
      clearCalibrationCache();
      log.info('Calibration removed for %s', request.params.sensorName);
      return reply.send({ ok: true });
    },
  );
}
