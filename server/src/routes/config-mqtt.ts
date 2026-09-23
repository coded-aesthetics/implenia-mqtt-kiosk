import mqtt from 'mqtt';
import type { FastifyInstance } from 'fastify';
import { clearBuffer, getObservedTopics } from '../db.js';
import { ingestion } from '../ingestion.js';
import {
  DEFAULT_BROKER_URL,
  DEFAULT_TOPICS,
  getMqttSettings,
  normalizeBrokerUrl,
  normalizeTopics,
  setMqttSettings,
} from '../mqtt-config.js';
import { createLogger } from '../logger.js';

// Logs as 'config', not as this file's name: /api/logs?module=config is how
// service personnel filter these, and splitting the file must not split that.
const log = createLogger('config');

/** Broker settings, the observed-topic feed, and the connection test. */
export function registerMqttConfigRoutes(app: FastifyInstance): void {
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
