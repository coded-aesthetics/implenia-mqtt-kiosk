import { describe, it, expect } from 'vitest';
import { buildSensorValues, sensorValue, findSensorReading } from './sensors';
import type { SensorReading } from '../hooks/useWebSocket';

function lese(
  topic: string,
  payload: string,
  opts: { sensor?: string | null; receivedAt?: number } = {},
): SensorReading {
  return {
    topic,
    payload,
    receivedAt: opts.receivedAt ?? 1_000,
    sensor: opts.sensor ?? null,
  } as SensorReading;
}

function karte(...rs: SensorReading[]): Map<string, SensorReading> {
  return new Map(rs.map((r) => [r.topic, r]));
}

describe('buildSensorValues / sensorValue', () => {
  it('reaches a sensor wired on site under its CSV name', () => {
    // The whole point of the Sensorzuordnung: an opaque topic bound to a
    // sensor whose name appears nowhere in it.
    const values = buildSensorValues(karte(lese('plc/ch05', '42.5', { sensor: 'drehzahl' })));
    expect(sensorValue(values, 'Drehzahl')).toBe(42.5);
  });

  it('is case-insensitive, because the server resolves to a lowercased key', () => {
    // resolveSensorKey() answers with the recording sensor-map key, which is
    // lowercase; every caller holds the CSV name in its original case. Keying
    // the answer as it arrives was a case-only miss that read 0 on screen
    // while the upload was correct.
    const values = buildSensorValues(karte(lese('plc/ch09', '7', { sensor: 'bohrtiefe' })));
    expect(sensorValue(values, 'Bohrtiefe')).toBe(7);
    expect(sensorValue(values, 'BOHRTIEFE')).toBe(7);
    expect(sensorValue(values, ' bohrtiefe ')).toBe(7);
  });

  it('still reaches a sensor by the topic and by its last segment', () => {
    const values = buildSensorValues(karte(lese('rig/1/Tiefe', '3.5')));
    expect(sensorValue(values, 'Tiefe')).toBe(3.5);
    expect(sensorValue(values, 'rig/1/Tiefe')).toBe(3.5);
  });

  it('resolves a topic whose case differs from the CSV name', () => {
    const values = buildSensorValues(karte(lese('rig/1/tiefe', '3.5')));
    expect(sensorValue(values, 'Tiefe')).toBe(3.5);
  });

  it('is undefined for a sensor nothing has arrived for', () => {
    const values = buildSensorValues(karte(lese('rig/1/Tiefe', '3.5')));
    expect(sensorValue(values, 'Drehzahl')).toBeUndefined();
  });

  it('reads a non-numeric payload as 0 rather than dropping the key', () => {
    const values = buildSensorValues(karte(lese('rig/1/Tiefe', 'offen')));
    expect(sensorValue(values, 'Tiefe')).toBe(0);
  });
});

describe('findSensorReading', () => {
  it('prefers the server-resolved sensor over a coincidental topic segment', () => {
    const gewollt = lese('plc/ch05', '10', { sensor: 'richtung x', receivedAt: 1 });
    const zufall = lese('other/richtung x', '99', { receivedAt: 2 });
    expect(findSensorReading(karte(gewollt, zufall), 'Richtung X')).toBe(gewollt);
  });

  it('falls back to the last segment when nothing resolved', () => {
    const r = lese('rig/1/Richtung X', '10');
    expect(findSensorReading(karte(r), 'Richtung X')).toBe(r);
  });

  it('takes the newest within one rank', () => {
    const alt = lese('a/Tiefe', '1', { receivedAt: 1 });
    const neu = lese('b/Tiefe', '2', { receivedAt: 2 });
    expect(findSensorReading(karte(alt, neu), 'Tiefe')).toBe(neu);
  });

  it('is null for a name nothing carries', () => {
    expect(findSensorReading(karte(lese('a/Tiefe', '1')), 'Drehzahl')).toBeNull();
  });
});
