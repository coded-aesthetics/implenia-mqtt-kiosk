import { describe, it, expect } from 'vitest';
import { darfNeuLaden } from './sw-update';

describe('darfNeuLaden', () => {
  it('allows the first automatic reload', () => {
    expect(darfNeuLaden(1_000_000, null)).toBe(true);
  });

  it('refuses a second one inside the window', () => {
    // The loop guard: a worker reinstalling on every load would make a
    // keyboard-less kiosk unusable.
    expect(darfNeuLaden(1_000_000, 999_000)).toBe(false);
    expect(darfNeuLaden(1_000_000, 970_001)).toBe(false);
  });

  it('allows one again once the window has passed', () => {
    expect(darfNeuLaden(1_000_000, 970_000)).toBe(true);
    expect(darfNeuLaden(1_000_000, 500_000)).toBe(true);
  });
});
