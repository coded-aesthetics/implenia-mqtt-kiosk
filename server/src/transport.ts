import { getMeta, setMeta } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('transport');

/**
 * How sensor data reaches this kiosk. One machine uses exactly one.
 *
 * Unlike the Verfahren, this is freely changeable: switching it does not
 * reinterpret existing data. Serial channel mappings are keyed
 * (device_id, value_index) and MQTT overrides by topic, so they cannot
 * collide, and readings already recorded keep their own sensor map.
 */
export const TRANSPORTS = {
  mqtt: 'MQTT-Box',
  serial: 'Serielle Verbindung (USB)',
} as const;

export type Transport = keyof typeof TRANSPORTS;

const TRANSPORT_KEY = 'transport';

/** Existing installs predate the setting and were all MQTT. */
export const DEFAULT_TRANSPORT: Transport = 'mqtt';

export function isValidTransport(value: string): value is Transport {
  return Object.prototype.hasOwnProperty.call(TRANSPORTS, value);
}

let cached: Transport | undefined;

export function getTransport(): Transport {
  if (cached !== undefined) return cached;

  const stored = getMeta(TRANSPORT_KEY);
  if (stored == null) {
    cached = DEFAULT_TRANSPORT;
  } else if (isValidTransport(stored)) {
    cached = stored;
  } else {
    log.error('Stored transport "%s" is unknown — falling back to %s', stored, DEFAULT_TRANSPORT);
    cached = DEFAULT_TRANSPORT;
  }
  return cached;
}

/** True once the wizard has actually made the choice. */
export function isTransportConfigured(): boolean {
  return getMeta(TRANSPORT_KEY) != null;
}

export function setTransport(transport: Transport): void {
  setMeta(TRANSPORT_KEY, transport);
  cached = transport;
  log.info('Transport set to %s', transport);
}

export function clearTransportCache(): void {
  cached = undefined;
}
