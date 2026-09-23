import { getActiveVerfahren, loadSensorCsv } from '../sensor-meta.js';

/**
 * Is this the name of a sensor the active Verfahren actually defines?
 *
 * Guards every route that binds something to a sensor name. A typo that got
 * through would not fail loudly — it would store a calibration or a topic
 * binding against a sensor that never exists, and the data would go missing
 * at upload time with nothing on screen to say why.
 *
 * Returns a result rather than replying itself, matching validateCalibration()
 * and validateRohrwechsel() elsewhere in this file.
 */
export type SensorCheck = { ok: true } | { ok: false; status: 400 | 409; error: string };

export function checkKnownSensor(sensorName: string): SensorCheck {
  const verfahren = getActiveVerfahren();
  if (!verfahren) {
    return {
      ok: false,
      status: 409,
      error: 'Es ist noch kein Verfahren eingerichtet. Bitte zuerst die Einrichtung abschließen.',
    };
  }
  if (!(loadSensorCsv(verfahren) ?? []).some((r) => r.name === sensorName)) {
    return {
      ok: false,
      status: 400,
      error: `„${sensorName}" ist kein Sensor dieses Verfahrens. Bitte einen Sensor aus der Liste wählen.`,
    };
  }
  return { ok: true };
}
