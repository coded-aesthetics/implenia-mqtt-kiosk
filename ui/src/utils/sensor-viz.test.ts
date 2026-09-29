import { describe, it, expect } from 'vitest';
import { clampFrac, statusColor, thresholdColor, autoLabelStep } from './sensor-viz';

describe('clampFrac', () => {
  it('returns 0 when min === max', () => {
    expect(clampFrac(5, 5, 5)).toBe(0);
  });

  it('returns 0 when min > max', () => {
    expect(clampFrac(5, 10, 5)).toBe(0);
  });

  it('clamps below min to 0', () => {
    expect(clampFrac(-1, 0, 100)).toBe(0);
  });

  it('clamps above max to 1', () => {
    expect(clampFrac(150, 0, 100)).toBe(1);
  });

  it('returns fraction for value in range', () => {
    expect(clampFrac(50, 0, 100)).toBe(0.5);
  });
});

describe('statusColor', () => {
  it('returns success when soll is null', () => {
    expect(statusColor(42, null)).toBe('var(--color-success)');
  });

  it('returns success when soll is undefined', () => {
    expect(statusColor(42, undefined)).toBe('var(--color-success)');
  });

  it('returns success when soll is 0 and value is 0', () => {
    expect(statusColor(0, 0)).toBe('var(--color-success)');
  });

  it('returns danger when soll is 0 and value is not 0', () => {
    expect(statusColor(5, 0)).toBe('var(--color-danger)');
  });

  it('returns success within 10% of soll', () => {
    expect(statusColor(95, 100)).toBe('var(--color-success)');
  });

  it('returns warning between 10% and 25% of soll', () => {
    expect(statusColor(80, 100)).toBe('var(--color-warning)');
  });

  it('returns danger beyond 25% of soll', () => {
    expect(statusColor(50, 100)).toBe('var(--color-danger)');
  });
});

describe('thresholdColor', () => {
  it('returns success when thresholds are null', () => {
    expect(thresholdColor(999, null)).toBe('var(--color-success)');
  });

  it('returns success when thresholds are undefined', () => {
    expect(thresholdColor(999, undefined)).toBe('var(--color-success)');
  });

  it('returns success below warning', () => {
    expect(thresholdColor(400, { warning: 500, danger: 2000 })).toBe('var(--color-success)');
  });

  it('returns warning at warning threshold', () => {
    expect(thresholdColor(500, { warning: 500, danger: 2000 })).toBe('var(--color-warning)');
  });

  it('returns warning between warning and danger', () => {
    expect(thresholdColor(1500, { warning: 500, danger: 2000 })).toBe('var(--color-warning)');
  });

  it('returns danger at danger threshold', () => {
    expect(thresholdColor(2000, { warning: 500, danger: 2000 })).toBe('var(--color-danger)');
  });

  it('returns danger above danger threshold', () => {
    expect(thresholdColor(5000, { warning: 500, danger: 2000 })).toBe('var(--color-danger)');
  });
});

describe('autoLabelStep', () => {
  it('returns 1 when range is 0', () => {
    expect(autoLabelStep(0)).toBe(1);
  });

  it('returns 1 when range is negative', () => {
    expect(autoLabelStep(-5)).toBe(1);
  });

  it('returns a sensible step for range 100', () => {
    const step = autoLabelStep(100);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(100);
  });

  it('returns a sensible step for range 1', () => {
    const step = autoLabelStep(1);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(1);
  });
});
