import { getMeta, setMeta } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('transport');

/**
 * How sensor data reaches this kiosk. One machine uses exactly one.
 *
 * Write-once, like the Verfahren. A rig's physical wiring does not change
 * mid-project, and a wrong choice announces itself within minutes — no data
 * arrives at all — at a point where resetting costs nothing because nothing
 * has been recorded yet. Making it switchable bought a case nobody has, at
 * the price of a second rule for service personnel to remember.
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

/** Raised when a second transport is written to an already-configured kiosk. */
export class TransportAlreadySetError extends Error {
  constructor(public readonly current: Transport) {
    super(`Transport already set to "${current}"`);
    this.name = 'TransportAlreadySetError';
  }
}

export function setTransport(transport: Transport): void {
  if (isTransportConfigured()) {
    throw new TransportAlreadySetError(getTransport());
  }
  setMeta(TRANSPORT_KEY, transport);
  cached = transport;
  log.info('Transport set to %s', transport);
}

export function clearTransportCache(): void {
  cached = undefined;
}
