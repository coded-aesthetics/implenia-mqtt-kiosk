import { describe, it, expect } from 'vitest';
import { isRecordableSensor } from './herstellen-sensors.js';

const noVorgaben = new Set<string>();

function sensor(source: string | null, id = 's1') {
  return { id, meta: source === null ? null : { source } };
}

describe('isRecordableSensor', () => {
  it('records machine and kiosk-derived values', () => {
    expect(isRecordableSensor(sensor('mqtt'), noVorgaben)).toBe(true);
    expect(isRecordableSensor(sensor('kiosk'), noVorgaben)).toBe(true);
  });

  it('records worker-entered values', () => {
    // The regression: Injektionsbohren's Status is Quelle=user and drives
    // every phase-segmented KPI. Excluding it meant the reading was stored
    // with a null sensor_id and silently never uploaded.
    expect(isRecordableSensor(sensor('user'), noVorgaben)).toBe(true);
  });

  it('leaves platform-computed values alone', () => {
    // `server` sensors are derived after upload; sending them back would be
    // the kiosk overwriting the platform's own results.
    expect(isRecordableSensor(sensor('server'), noVorgaben)).toBe(false);
  });

  it('ignores an unknown source rather than guessing', () => {
    expect(isRecordableSensor(sensor('carrier-pigeon'), noVorgaben)).toBe(false);
  });

  describe('legacy devices without meta', () => {
    it('records anything that is not a vorgaben sensor', () => {
      expect(isRecordableSensor(sensor(null, 'a'), noVorgaben)).toBe(true);
    });

    it('excludes vorgaben sensors', () => {
      expect(isRecordableSensor(sensor(null, 'a'), new Set(['a']))).toBe(false);
    });
  });
});
