import mqtt from 'mqtt';
import type { FastifyInstance } from 'fastify';
import {
  getMeta, setMeta, deleteMeta, getObservedTopics, clearBuffer,
  getTopicOverrides, setTopicOverride, deleteTopicOverride,
} from '../db.js';
import { getApiConfig, fetchImplenia } from '../implenia-api.js';
import { config as envConfig } from '../config.js';
import { ingestion, DataIngestion } from '../ingestion.js';
import { deviceSource } from '../device-source.js';
import { abortRecording } from '../recording.js';
import {
  DEFAULT_BROKER_URL,
  DEFAULT_TOPICS,
  getMqttSettings,
  normalizeBrokerUrl,
  normalizeTopics,
  setMqttSettings,
} from '../mqtt-config.js';
import { getActiveVerfahren, loadSensorCsv } from '../sensor-meta.js';
import { clearResolverCache, loadTopicMap, getResolverContext, resolveSensorKey } from '../topic-resolver.js';
import {
  TRANSPORTS, getTransport, isTransportConfigured, isValidTransport, setTransport,
  TransportAlreadySetError, clearTransportCache,
} from '../transport.js';
import { getUnsafeDataSummary, resetKiosk } from '../db.js';
import { clearVerfahrenCache } from '../sensor-meta.js';
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

  // ── Transport ───────────────────────────────────────────────────────────

  app.get('/api/config/transport', async () => {
    const transport = getTransport();
    return {
      transport,
      label: TRANSPORTS[transport],
      // False until the wizard actually asked — the value is a default, not a
      // choice, and the UI should say so.
      configured: isTransportConfigured(),
      available: Object.entries(TRANSPORTS).map(([key, label]) => ({ key, label })),
    };
  });

  // Write-once, like the Verfahren — see transport.ts.
  app.put<{ Body: { transport?: string } }>(
    '/api/config/transport',
    async (request, reply) => {
      const transport = request.body?.transport;
      if (!transport || !isValidTransport(transport)) {
        return reply.status(400).send({
          error: 'Bitte eine gültige Datenquelle wählen: ' + Object.values(TRANSPORTS).join(' oder ') + '.',
        });
      }

      try {
        setTransport(transport);
      } catch (err) {
        if (err instanceof TransportAlreadySetError) {
          return reply.status(409).send({
            error:
              `Die Datenquelle ist bereits auf „${TRANSPORTS[err.current]}" festgelegt ` +
              'und kann nicht geändert werden. Um eine andere Datenquelle zu wählen, ' +
              'muss die Software zurückgesetzt werden.',
            current: err.current,
          });
        }
        throw err;
      }

      // Swap the live source so the choice takes effect without a restart.
      ingestion.setSource(DataIngestion.sourceFor(transport));

      return reply.send({ transport, label: TRANSPORTS[transport] });
    },
  );

  // ── Reset ───────────────────────────────────────────────────────────────

  /** What a reset would destroy, and whether it is allowed right now. */
  app.get('/api/config/reset', async () => {
    const unsafe = getUnsafeDataSummary();
    return {
      allowed: unsafe.readings === 0,
      unsafe,
      preserves: ['API-Schlüssel', 'Server-Adresse'],
    };
  });

  app.post('/api/config/reset', async (_request, reply) => {
    const unsafe = getUnsafeDataSummary();
    if (unsafe.readings > 0) {
      // Refusing, not warning: losing recorded measurements is the one
      // outcome this software must never produce.
      return reply.status(409).send({
        error:
          `Zurücksetzen nicht möglich: ${unsafe.readings} Messwerte aus ` +
          `${unsafe.sessions} Aufzeichnung(en) sind weder hochgeladen noch exportiert. ` +
          'Bitte zuerst hochladen oder als Datei exportieren.',
        unsafe,
      });
    }

    // Detach the live recording *before* its session row disappears. An
    // ingestion layer still pointing at a deleted session writes readings
    // against a missing parent, and that foreign-key error is thrown from the
    // source's synchronous handler — it would kill the process as soon as the
    // next message arrived.
    abortRecording();

    resetKiosk();
    // In-memory caches would otherwise keep serving the old setup; clearing
    // them here is why the in-app reset needs no restart.
    clearVerfahrenCache();
    clearTransportCache();
    clearResolverCache();
    deviceSource.clearMappingCache();
    ingestion.setSource(DataIngestion.sourceFor(getTransport()));
    // setSource is a no-op when the transport is unchanged (the common case),
    // so cycle the source explicitly: otherwise the MQTT client keeps the old
    // site's connection and subscription, and the restarted wizard lists
    // topics from a broker this kiosk is no longer being set up for.
    ingestion.restartSource();

    log.info('Kiosk setup reset');
    return reply.send({ ok: true });
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

      const previous = getMqttSettings();
      const changed =
        previous.brokerUrl !== broker.url || previous.topics !== topics.url;

      setMqttSettings(broker.url, topics.url);
      log.info('MQTT settings updated: %s (%s)', broker.url, topics.url);

      if (changed) {
        // Rows from the previous broker would otherwise keep answering "topics
        // are arriving" for the next five minutes — reporting success for
        // exactly the wrong address the caller just typed.
        clearBuffer();
      }

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
