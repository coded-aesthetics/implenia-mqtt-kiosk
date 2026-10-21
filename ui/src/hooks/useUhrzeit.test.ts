import { describe, it, expect } from 'vitest';
import { formatiereUhrzeit, msBisZurNaechstenMinute } from './useUhrzeit';

describe('formatiereUhrzeit', () => {
  it('is 24-hour German, two digits, no seconds', () => {
    expect(formatiereUhrzeit(new Date(2026, 9, 21, 13, 20, 55))).toBe('13:20');
    // The one a 12-hour locale would get wrong, and the one a missing
    // `2-digit` would render as "9:05".
    expect(formatiereUhrzeit(new Date(2026, 9, 21, 17, 5, 0))).toBe('17:05');
    expect(formatiereUhrzeit(new Date(2026, 9, 21, 9, 5, 0))).toBe('09:05');
    expect(formatiereUhrzeit(new Date(2026, 9, 21, 0, 0, 0))).toBe('00:00');
  });
});

describe('msBisZurNaechstenMinute', () => {
  it('lands on the minute boundary rather than 60 s after mount', () => {
    expect(msBisZurNaechstenMinute(new Date(2026, 9, 21, 13, 20, 0, 0))).toBe(60_000);
    expect(msBisZurNaechstenMinute(new Date(2026, 9, 21, 13, 20, 20, 0))).toBe(40_000);
    expect(msBisZurNaechstenMinute(new Date(2026, 9, 21, 13, 20, 59, 500))).toBe(500);
  });

  it('never spins: a timer firing early still waits', () => {
    // 59.999 would otherwise schedule a 1 ms timeout, and a timer that fires a
    // hair before the boundary would re-render in a tight loop until the clock
    // caught up.
    expect(msBisZurNaechstenMinute(new Date(2026, 9, 21, 13, 20, 59, 999))).toBe(250);
  });
});
