import mqtt from 'mqtt';
import type { FastifyInstance } from 'fastify';
import {
  getMeta, setMeta, deleteMeta, getObservedTopics,
  getTopicOverrides, setTopicOverride, deleteTopicOverride,
} from '../db.js';
import { getApiConfig, fetchImplenia } from '../implenia-api.js';
import { config as envConfig } from '../config.js';
import { ingestion } from '../ingestion.js';
import {
  DEFAULT_BROKER_URL,
  DEFAULT_TOPICS,
  getMqttSettings,
  normalizeBrokerUrl,
  normalizeTopics,
  setMqttSettings,
} from '../mqtt-config.js';
import { getActiveVerfahren, loadSensorCsv } from '../sensor-meta.js';
import { clearResolverCache, loadTopicMap } from '../topic-resolver.js';
import { createLogger } from '../logger.js';

const log = createLogger('config');

export function registerConfigRoutes(app: FastifyInstance): void {
  app.get('/api/config', async (_request, reply) => {
    const cfg = getApiConfig();
    const runtimeUrl = getMeta('implenia_api_url');
    return reply.send({
      hasApiKey: cfg !== null,
      apiUrl: runtimeUrl ?? envConfig.IMPLENIA_API_URL ?? null,
      apiUrlSource: runtimeUrl ? 'runtime' : envConfig.IMPLENIA_API_URL ? 'env' : null,
    });
  });

  app.post('/api/config', async (request, reply) => {
    const { apiKey, apiUrl } = request.body as {
      apiKey?: string;
      apiUrl?: string;
    };

    if (!apiKey || apiKey.trim().length === 0) {
      return reply.status(400).send({ error: 'apiKey is required' });
    }

    setMeta('implenia_api_key', apiKey.trim());
    if (apiUrl && apiUrl.trim().length > 0) {
      setMeta('implenia_api_url', apiUrl.trim());
    }

    log.info('API key updated via config page');
    return reply.send({ ok: true });
  });

  app.put('/api/config/api-url', async (request, reply) => {
    const { apiUrl } = request.body as { apiUrl?: string };

    if (!apiUrl || apiUrl.trim().length === 0) {
      return reply.status(400).send({ error: 'apiUrl is required' });
    }

    try {
      new URL(apiUrl.trim());
    } catch {
      return reply.status(400).send({ error: 'Ungültige URL' });
    }

    setMeta('implenia_api_url', apiUrl.trim());
    log.info('API URL updated via config page');
    return reply.send({ ok: true });
  });

  app.get('/api/config/validate', async (_request, reply) => {
    const cfg = getApiConfig();
    if (!cfg) {
      return reply.send({ ok: false, error: 'API-Schlüssel oder Server-Adresse nicht konfiguriert' });
    }

    try {
      const data = await fetchImplenia<{ name?: string }>('/api/v1/measuring-device/self');
      log.info('API validation: device check ok: %s', data.name ?? 'unnamed');

      // Verify this device can receive shift assignments (200 or 404 are acceptable)
      const today = new Date().toISOString().split('T')[0];
      try {
        await fetchImplenia(`/shift-assignment?date=${today}`);
      } catch (shiftErr) {
        const status = (shiftErr as import('../implenia-api.js').ApiError).statusCode;
        if (status !== 404) {
          log.warn('API validation: shift-assignment probe failed for %s: %s', data.name, (shiftErr as Error).message);
          return reply.send({
            ok: false,
            error: 'wrong_device_type',
            deviceName: data.name ?? null,
          });
        }
      }

      log.info('API validation successful: %s', data.name ?? 'unnamed');
      return reply.send({ ok: true, deviceName: data.name ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('API validation failed: %s', message);
      if (message.includes('401') || message.includes('403')) {
        return reply.send({ ok: false, error: 'Ungültiger API-Schlüssel' });
      }
      return reply.send({ ok: false, error: `Verbindung fehlgeschlagen: ${message}` });
    }
  });

  // ── MQTT ────────────────────────────────────────────────────────────────

  app.get('/api/config/mqtt', async () => {
    const settings = getMqttSettings();
    return {
      ...settings,
      defaultBrokerUrl: DEFAULT_BROKER_URL,
      defaultTopics: DEFAULT_TOPICS,
      connected: ingestion.sourceConnected,
    };
  });

  /**
   * Try a broker address without persisting it, so a wrong value is caught
   * here instead of showing up as silent no-data three screens later.
   */
  app.post<{ Body: { brokerUrl?: string } }>(
    '/api/config/mqtt/test',
    async (request, reply) => {
      const normalized = normalizeBrokerUrl(request.body?.brokerUrl ?? '');
      if (!normalized.ok) {
        return reply.status(400).send({ ok: false, error: normalized.error });
      }

      const result = await probeBroker(normalized.url);
      return reply.send({ ...result, brokerUrl: normalized.url });
    },
  );

  app.put<{ Body: { brokerUrl?: string; topics?: string } }>(
    '/api/config/mqtt',
    async (request, reply) => {
      const broker = normalizeBrokerUrl(request.body?.brokerUrl ?? '');
      if (!broker.ok) return reply.status(400).send({ error: broker.error });

      const topics = normalizeTopics(request.body?.topics ?? DEFAULT_TOPICS);
      if (!topics.ok) return reply.status(400).send({ error: topics.error });

      setMqttSettings(broker.url, topics.url);
      log.info('MQTT settings updated: %s (%s)', broker.url, topics.url);

      // Pick up the new settings without a process restart.
      ingestion.restartSource();

      return reply.send({ brokerUrl: broker.url, topics: topics.url });
    },
  );

  /**
   * Topics actually seen on the broker. Drives the wizard's "is data arriving"
   * check and, later, the sensor assignment screen.
   */
  app.get<{ Querystring: { since?: string } }>(
    '/api/config/mqtt/topics',
    async (request) => {
      const windowMs = Number(request.query.since ?? '') || 5 * 60_000;
      const topics = getObservedTopics(Date.now() - windowMs);
      return { windowMs, count: topics.length, topics };
    },
  );

  // ── Topic assignment ────────────────────────────────────────────────────

  /**
   * Everything the assignment screen needs: the sensors this Verfahren
   * expects, which topic currently feeds each, and where that binding came
   * from (shipped map vs. wired on site).
   */
  app.get('/api/config/topic-overrides', async () => {
    const verfahren = getActiveVerfahren();
    const shipped = verfahren ? loadTopicMap(verfahren) : new Map<string, string>();
    const overrides = getTopicOverrides();

    const boundBySensor = new Map<string, { topic: string; source: 'override' | 'shipped' }>();
    for (const [topic, sensorName] of shipped) {
      boundBySensor.set(sensorName.toLowerCase(), { topic, source: 'shipped' });
    }
    // Overrides win, mirroring resolveSensorKey().
    for (const o of overrides) {
      boundBySensor.set(o.sensorName.toLowerCase(), { topic: o.topic, source: 'override' });
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
          // "name" = resolves already because the topic equals the sensor name.
          boundBy: bound?.source ?? 'name',
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

      const verfahren = getActiveVerfahren();
      if (!verfahren) {
        return reply.status(409).send({
          error: 'Es ist noch kein Verfahren eingerichtet. Bitte zuerst die Einrichtung abschließen.',
        });
      }

      // Guard against binding to a sensor that does not exist for this
      // Verfahren — a typo here would silently drop data at upload time.
      const known = (loadSensorCsv(verfahren) ?? []).some((r) => r.name === sensorName);
      if (!known) {
        return reply.status(400).send({
          error: `„${sensorName}" ist kein Sensor dieses Verfahrens. Bitte einen Sensor aus der Liste wählen.`,
        });
      }

      setTopicOverride(topic, sensorName);
      clearResolverCache();
      log.info('Topic %s assigned to sensor %s', topic, sensorName);
      return reply.send({ topic, sensorName });
    },
  );

  app.delete<{ Params: { topic: string } }>(
    '/api/config/topic-overrides/:topic',
    async (request, reply) => {
      const topic = decodeURIComponent(request.params.topic);
      deleteTopicOverride(topic);
      clearResolverCache();
      log.info('Topic assignment removed for %s', topic);
      return reply.send({ ok: true });
    },
  );

  app.delete('/api/config/api-key', async (_request, reply) => {
    deleteMeta('implenia_api_key');
    log.info('API key removed via config page');
    return reply.send({ ok: true });
  });
}

/** Connect, report, disconnect. Never leaves a client behind. */
function probeBroker(
  brokerUrl: string,
  timeoutMs = 8000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const client = mqtt.connect(brokerUrl, {
      reconnectPeriod: 0, // one attempt — this is a test, not a session
      connectTimeout: timeoutMs,
    });

    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: describeBrokerError('connack timeout', brokerUrl) }),
      timeoutMs + 1000,
    );

    client.on('connect', () => finish({ ok: true }));
    client.on('error', (err) => {
      // Keep the library's own wording in the log for remote diagnosis; the
      // technician gets a German sentence that says what to do about it.
      log.warn('MQTT probe of %s failed: %s', brokerUrl, err.message);
      finish({ ok: false, error: describeBrokerError(err.message, brokerUrl) });
    });
  });
}

/**
 * Turn an mqtt.js error into something a technician on site can act on.
 * Library messages are English and name syscalls; these name the box and the
 * cable.
 */
export function describeBrokerError(raw: string, brokerUrl: string): string {
  const msg = raw.toLowerCase();

  if (msg.includes('timeout')) {
    return `Keine Antwort von ${brokerUrl}. Bitte prüfen, ob die MQTT-Box eingeschaltet und das Netzwerkkabel verbunden ist.`;
  }
  if (msg.includes('econnrefused')) {
    return `${brokerUrl} ist erreichbar, nimmt aber keine Verbindung an. Bitte prüfen, ob die Adresse und der Port richtig sind.`;
  }
  if (msg.includes('enotfound') || msg.includes('eai_again')) {
    return `Die Adresse ${brokerUrl} konnte nicht aufgelöst werden. Bitte den Namen prüfen oder die IP-Adresse direkt eintragen.`;
  }
  if (msg.includes('ehostunreach') || msg.includes('enetunreach')) {
    return `${brokerUrl} ist im Netzwerk nicht erreichbar. Bitte prüfen, ob der PC mit der MQTT-Box verbunden ist.`;
  }
  if (msg.includes('not authorized') || msg.includes('bad username') || msg.includes('bad user')) {
    return `${brokerUrl} hat die Verbindung abgelehnt (keine Berechtigung). Bitte die Konfiguration der MQTT-Box prüfen.`;
  }
  return `Verbindung zu ${brokerUrl} nicht möglich. Bitte Adresse, Netzwerkkabel und MQTT-Box prüfen.`;
}
