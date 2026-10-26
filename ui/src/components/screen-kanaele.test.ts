import { describe, it, expect } from 'vitest';
import { INJEKTIONSBOHREN_BOHREN } from './BohrenScreen';
import { INJEKTIONSBOHREN_VERPRESSEN } from './VerpressenScreen';
import { buildSensorValues, sensorValue, type Kanal } from '../utils/sensors';
import type { SensorReading } from '../hooks/useWebSocket';

/**
 * Every live value the two drilling screens show must be reachable on a rig
 * whose topics were wired on site.
 *
 * This is the test that was missing. The screens named each channel by the
 * topic of the one retrofitted rig the shipped topic map was written from, so
 * the whole screen — the depth hero included — read 0,00 m on a machine
 * publishing under any other topic, however correctly the Sensorzuordnung had
 * wired it. The server was recording and uploading those channels the whole
 * time, which is what made it a display bug nobody could see the shape of: the
 * depth hero is also the tap target for the depth correction, so the
 * correction screen said "Es liegt noch kein Tiefenmesswert vor".
 *
 * The two reading sets below are the two things a kiosk can actually see. A
 * channel has to resolve in both.
 */

function lese(topic: string, sensor: string | null): SensorReading {
  return { topic, payload: '7', receivedAt: 1_000, sensor } as SensorReading;
}

function kanaele(): { name: string; kanal: Kanal }[] {
  const b = INJEKTIONSBOHREN_BOHREN;
  const v = INJEKTIONSBOHREN_VERPRESSEN;
  return [
    { name: 'Bohren: Tiefe', kanal: b.depth },
    { name: 'Bohren: Volumen', kanal: b.volume },
    { name: 'Bohren: Drehzahl', kanal: b.centerGauge },
    ...[...b.leftGauges, ...b.rightGauges, ...b.bars].map((s) => ({
      name: `Bohren: ${s.label}`, kanal: s,
    })),
    { name: 'Verpressen: Tiefe', kanal: v.depth },
    { name: 'Verpressen: Volumen', kanal: v.volume },
    ...v.gauges.map((s) => ({ name: `Verpressen: ${s.label}`, kanal: s })),
    ...v.chartTraces.map((s) => ({ name: `Verpressen-Chart: ${s.label}`, kanal: s })),
  ];
}

describe('the drilling screens resolve every channel', () => {
  it('on a rig whose topics were wired on site', () => {
    // What the Sensorzuordnung produces: an opaque topic bound to a CSV
    // sensor. The server tags the reading with the sensor name and nothing in
    // the topic resembles it — the case the reference box never exercises.
    const readings = new Map<string, SensorReading>();
    kanaele().forEach(({ kanal }, i) => {
      readings.set(`plc/ch${i}`, lese(`plc/ch${i}`, kanal.sensor.toLowerCase()));
    });

    const blind = kanaele().filter(
      ({ kanal }) => sensorValue(buildSensorValues(readings), kanal.sensor, kanal.topic) === undefined,
    );
    expect(blind.map((k) => k.name)).toEqual([]);
  });

  it('on the reference box, whose topics the shipped map resolves', () => {
    // `Bohrgeraet/Tiefe` → `Bohrtiefe` and so on, so the sensor name carries
    // this one too. The `topic` fallback is for a kiosk where that resolve
    // does not happen at all — a bench setup or a replay file.
    const readings = new Map<string, SensorReading>();
    kanaele().forEach(({ kanal }) => {
      // Verbatim, because two of them are full topics with a slash in them
      // (`Spuelpumpe/Volumen`) and a prefix would change what the last
      // segment is.
      const topic = kanal.topic ?? kanal.sensor;
      readings.set(topic, lese(topic, null));
    });

    const blind = kanaele().filter(
      ({ kanal }) => sensorValue(buildSensorValues(readings), kanal.sensor, kanal.topic) === undefined,
    );
    expect(blind.map((k) => k.name)).toEqual([]);
  });

  it('names the depth sensor the Injektionsbohren CSV defines', () => {
    // `Tiefe` is DSV's name for it. Resolving a sensor by a hardcoded name is
    // only safe when the name is the one that Verfahren actually declares —
    // see findSensorNameByRole in the server's sensor-meta.ts.
    expect(INJEKTIONSBOHREN_BOHREN.depth.sensor).toBe('Bohrtiefe');
    expect(INJEKTIONSBOHREN_VERPRESSEN.depth.sensor).toBe('Bohrtiefe');
  });
});
