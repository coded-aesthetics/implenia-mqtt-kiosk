import type { FastifyInstance } from 'fastify';
import {
  getObservedTopics, getTopicOverrides, setTopicOverride, deleteTopicOverride,
} from '../db.js';
import { getActiveVerfahren, loadSensorCsv } from '../sensor-meta.js';
import {
  clearResolverCache, loadTopicMap, getResolverContext, resolveSensorKey,
} from '../topic-resolver.js';
import { checkKnownSensor } from './sensor-guard.js';
import { createLogger } from '../logger.js';

// Logs as 'config', not as this file's name: /api/logs?module=config is how
// service personnel filter these, and splitting the file must not split that.
const log = createLogger('config');

/** Binding MQTT topics to the sensors of the active Verfahren. */
export function registerTopicOverrideRoutes(app: FastifyInstance): void {
  /**
   * Everything the assignment screen needs: the sensors this Verfahren
   * expects, which topic currently feeds each, and where that binding came
   * from (shipped map vs. wired on site).
   */
  app.get('/api/config/topic-overrides', async () => {
    const verfahren = getActiveVerfahren();
    const shipped = verfahren ? loadTopicMap(verfahren) : new Map<string, string>();
    const overrides = getTopicOverrides();

    const boundBySensor = new Map<string, { topic: string; source: 'override' | 'shipped' | 'name' }>();
    for (const [topic, sensorName] of shipped) {
      boundBySensor.set(sensorName.toLowerCase(), { topic, source: 'shipped' });
    }
    // Overrides win, mirroring resolveSensorKey().
    for (const o of overrides) {
      boundBySensor.set(o.sensorName.toLowerCase(), { topic: o.topic, source: 'override' });
    }

    // A topic whose last segment already equals a sensor name needs no
    // binding — it resolves today. Showing it as "not assigned" would send a
    // technician off rebinding sensors that already work, so resolve what is
    // actually arriving and report that too.
    const observed = getObservedTopics(Date.now() - 5 * 60_000);
    const ctx = getResolverContext();
    for (const t of observed) {
      const key = resolveSensorKey(t.topic, ctx);
      if (!key || boundBySensor.has(key)) continue;
      boundBySensor.set(key, { topic: t.topic, source: 'name' });
    }

    const rows = verfahren ? loadSensorCsv(verfahren) ?? [] : [];
    const sensors = rows
      .filter((r) => r.source === 'mqtt')
      .map((r) => {
        const bound = boundBySensor.get(r.name.toLowerCase());
        return {
          name: r.name,
          unit: r.unit,
          priority: r.priority,
          topic: bound?.topic ?? null,
          boundBy: bound?.source ?? 'none',
        };
      });

    return { verfahren, sensors, overrides };
  });

  app.put<{ Body: { topic?: string; sensorName?: string } }>(
    '/api/config/topic-overrides',
    async (request, reply) => {
      const topic = request.body?.topic?.trim();
      const sensorName = request.body?.sensorName?.trim();
      if (!topic || !sensorName) {
        return reply.status(400).send({ error: 'Topic und Sensorname sind erforderlich.' });
      }

      const check = checkKnownSensor(sensorName);
      if (!check.ok) return reply.status(check.status).send({ error: check.error });

      setTopicOverride(topic, sensorName);
      clearResolverCache();
      log.info('Topic %s assigned to sensor %s', topic, sensorName);
      return reply.send({ topic, sensorName });
    },
  );

  app.delete<{ Params: { topic: string } }>(
    '/api/config/topic-overrides/:topic',
    async (request, reply) => {
      // Fastify hands params over already percent-decoded, so decoding again
      // would corrupt a topic containing a literal '%' — or throw URIError on
      // one that is not valid escape syntax.
      const topic = request.params.topic;
      deleteTopicOverride(topic);
      clearResolverCache();
      log.info('Topic assignment removed for %s', topic);
      return reply.send({ ok: true });
    },
  );
}
