import { describe, it, expect } from 'vitest';
import { LOG_TOPIC } from './ingestion.js';
import { LOG_SENSOR_NAME } from './recording.js';

/**
 * Two modules name the same topic, and they cannot share a constant: they sit
 * in an import cycle (`ingestion → mqtt → websocket → recording → ingestion`),
 * so a const read at module-body time across it lands in the temporal dead zone
 * and takes the kiosk down at boot — which is how this test came to exist.
 *
 * If they drift, the kiosk's own log rows reappear as tiles on the Messwerte
 * screen after a resume, because nothing would filter them out any more.
 */
describe('the log sensor topic', () => {
  it('is the same string in ingestion and recording', () => {
    expect(LOG_TOPIC).toBe(LOG_SENSOR_NAME);
  });
});
