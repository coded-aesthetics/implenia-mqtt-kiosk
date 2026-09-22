import { describe, it, expect } from 'vitest';
import {
  applyCalibration, isNeutral, validateCalibration, tareOffset, NEUTRAL,
} from './calibration.js';

describe('linear calibration', () => {
  it('leaves a reading alone when nothing is configured', () => {
    expect(applyCalibration(42.5, NEUTRAL)).toBe(42.5);
    expect(isNeutral(NEUTRAL)).toBe(true);
  });

  it('scales', () => {
    // The G08 case: the carriage travels ~2.6 m per metre of hole.
    expect(applyCalibration(10, { scale: 0.3793, offset: 0 })).toBeCloseTo(3.793, 6);
  });

  it('offsets', () => {
    expect(applyCalibration(10, { scale: 1, offset: -1.5 })).toBe(8.5);
  });

  it('applies the scale before the offset', () => {
    // `raw × scale + offset`, not `(raw + offset) × scale` — the two differ and
    // a technician reading the formula off the screen has to get the same
    // number the kiosk does.
    expect(applyCalibration(10, { scale: 2, offset: 3 })).toBe(23);
  });

  it('passes a missing reading through untouched', () => {
    // NaN is what a rig sends when it has no value; scaling it would turn a
    // gap into a number.
    expect(Number.isNaN(applyCalibration(NaN, { scale: 2, offset: 1 }))).toBe(true);
  });

  it('recognises a calibration that does nothing', () => {
    expect(isNeutral({ scale: 1, offset: 0 })).toBe(true);
    expect(isNeutral({ scale: 1, offset: 0.1 })).toBe(false);
    expect(isNeutral({ scale: 0.5, offset: 0 })).toBe(false);
  });
});

describe('calibration validation', () => {
  it('accepts a factor and an offset', () => {
    const result = validateCalibration(0.3793, -1.2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ scale: 0.3793, offset: -1.2 });
  });

  it('accepts strings, because that is what a form sends', () => {
    const result = validateCalibration('2', '0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scale).toBe(2);
  });

  it('refuses a factor of zero', () => {
    // Every reading would collapse to the offset, and the original value could
    // not be recovered from what gets stored.
    const result = validateCalibration(0, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('nicht 0');
    expect(result.error).toContain('1');
  });

  it('refuses values that are not numbers', () => {
    expect(validateCalibration('zwei', 0).ok).toBe(false);
    expect(validateCalibration(1, 'null').ok).toBe(false);
  });

  it('allows a negative factor', () => {
    // An inverted channel is a real thing, and inverting it is exactly what
    // this screen is for.
    expect(validateCalibration(-1, 0).ok).toBe(true);
  });
});

describe('taring a sensor', () => {
  it('cancels the current reading', () => {
    const result = tareOffset(3.4, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(-3.4);
    expect(applyCalibration(3.4, { scale: 1, offset: result.offset })).toBe(0);
  });

  it('cancels the scaled reading, not the raw one', () => {
    // The offset is added after the scale, so zeroing a scaled channel has to
    // cancel `rohwert × faktor` — cancelling the raw value would leave the
    // sensor reading something other than 0.
    const result = tareOffset(10, 0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(-5);
    expect(applyCalibration(10, { scale: 0.5, offset: result.offset })).toBe(0);
  });

  it('keeps the offset readable', () => {
    // -(0.1 × 3) is -0.30000000000000004 in floating point, and that is what
    // would land in the field a technician then has to read.
    const result = tareOffset(0.1, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(-0.3);
  });

  it('refuses when no value is arriving', () => {
    for (const raw of [null, undefined, NaN]) {
      const result = tareOffset(raw, 1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('kein Messwert');
    }
  });

  it('refuses a factor that cannot be applied', () => {
    expect(tareOffset(3.4, 0).ok).toBe(false);
    expect(tareOffset(3.4, NaN).ok).toBe(false);
  });

  it('is a no-op for a sensor that already reads zero', () => {
    const result = tareOffset(0, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(0);
  });
});
