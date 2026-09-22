import { config } from './config.js';
import { getMeta, setMeta } from './db.js';

/**
 * MQTT connection settings.
 *
 * These describe the machine and the site, not the software distribution, so
 * they are collected by the setup wizard and stored in the `meta` table. The
 * env vars remain as a pre-seed for a prepared release image; the stored value
 * wins where both exist, matching how the Implenia API URL already behaves.
 */

const BROKER_KEY = 'mqtt_broker_url';
const TOPICS_KEY = 'mqtt_topics';

/** Default address of the Implenia MQTT box. */
export const DEFAULT_BROKER_URL = 'mqtt://192.168.2.1:1883';

/**
 * Default subscription filter. Deliberately wide: on a new machine the topic
 * naming is unknown, and a narrow filter makes unmatched topics invisible
 * rather than visible-but-unassigned.
 */
export const DEFAULT_TOPICS = '#';

const SCHEME_DEFAULT_PORT: Record<string, string> = {
  'mqtt:': '1883',
  'mqtts:': '8883',
};
const ALLOWED_SCHEMES = ['mqtt:', 'mqtts:', 'ws:', 'wss:'];

export type NormalizeResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Accept what a technician would actually type — `192.168.2.1`,
 * `192.168.2.1:1883`, or a full URL — and return a canonical broker URL.
 *
 * A malformed value here is a hard startup failure, so this validates before
 * anything is written rather than letting zod reject it on the next boot.
 */
export function normalizeBrokerUrl(input: string): NormalizeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'Bitte die Adresse des MQTT-Brokers eingeben, z. B. 192.168.2.1' };
  }

  const withScheme = trimmed.includes('://') ? trimmed : `mqtt://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return {
      ok: false,
      error: `„${trimmed}" ist keine gültige Broker-Adresse. Erwartet wird z. B. 192.168.2.1 oder mqtt://192.168.2.1:1883`,
    };
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return {
      ok: false,
      error: `Das Protokoll „${parsed.protocol.replace(':', '')}" wird nicht unterstützt. Erlaubt sind mqtt, mqtts, ws und wss.`,
    };
  }

  if (!parsed.hostname) {
    return {
      ok: false,
      error: `In „${trimmed}" fehlt die Adresse des Brokers, z. B. 192.168.2.1`,
    };
  }

  const port = parsed.port || SCHEME_DEFAULT_PORT[parsed.protocol] || '';
  const host = port ? `${parsed.hostname}:${port}` : parsed.hostname;
  return { ok: true, url: `${parsed.protocol}//${host}` };
}

export function normalizeTopics(input: string): NormalizeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'Bitte mindestens einen Topic-Filter angeben, z. B. #' };
  }
  const parts = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, error: 'Bitte mindestens einen Topic-Filter angeben, z. B. #' };
  }
  for (const part of parts) {
    if (/\s/.test(part)) {
      return {
        ok: false,
        error: `Der Topic-Filter „${part}" darf keine Leerzeichen enthalten. Mehrere Filter mit Komma trennen.`,
      };
    }
  }
  return { ok: true, url: parts.join(',') };
}

export interface MqttSettings {
  brokerUrl: string | null;
  topics: string | null;
  /** Where the values came from — mirrors the API URL's `apiUrlSource`. */
  source: 'runtime' | 'env' | null;
}

export function getMqttSettings(): MqttSettings {
  const storedBroker = getMeta(BROKER_KEY) ?? null;
  const storedTopics = getMeta(TOPICS_KEY) ?? null;
  if (storedBroker) {
    return { brokerUrl: storedBroker, topics: storedTopics ?? DEFAULT_TOPICS, source: 'runtime' };
  }
  if (config.MQTT_BROKER_URL) {
    return {
      brokerUrl: config.MQTT_BROKER_URL,
      topics: config.MQTT_TOPICS ?? DEFAULT_TOPICS,
      source: 'env',
    };
  }
  return { brokerUrl: null, topics: null, source: null };
}

/** Persist validated settings. Callers must normalize first. */
export function setMqttSettings(brokerUrl: string, topics: string): void {
  setMeta(BROKER_KEY, brokerUrl);
  setMeta(TOPICS_KEY, topics);
}
