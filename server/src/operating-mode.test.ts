import { describe, it, expect } from 'vitest';
import {
  hasPipeHandling, isOperatingMode, isRetracting, normalizeOperatingMode,
  type OperatingMode,
} from './ingestion.js';

/**
 * The operating-mode predicates that govern Rohrverlängerung clipping.
 *
 * Pinned because the UI's phase control is a stepper that advances one phase at
 * a time, which means **skipping a phase is done by stepping through it**. The
 * three post-drilling phases are therefore uniform in how depth is tracked
 * (`isRetracting`), and only differ where the machine does: pipes are added in
 * Bohren and removed in Auffüllen, and no pipe is handled in Austausch or
 * Einbauen, whose clamp rests closed through the whole phase.
 *
 * What that costs the stepper is bounded and worth stating: passing through
 * Austausch on the way to Auffüllen passes through a phase that clips nothing,
 * so a pipe change spanning those taps could leak a phantom reading or two.
 * Clipping all three instead cost the entire Austausch depth series — 3 848 of
 * 3 886 readings on the captured rig — which is the worse trade by far.
 */

const NACH_DEM_BOHREN: OperatingMode[] = ['austausch', 'einbauen', 'auffuellen'];

describe('operating-mode predicates', () => {
  it('tracks depth the same way in every post-drilling phase', () => {
    for (const m of NACH_DEM_BOHREN) {
      expect(isRetracting(m), m).toBe(true);
    }
  });

  it('handles pipes only where the machine does', () => {
    // Bohren adds them in 2 m or 3 m increments, Auffüllen removes them the
    // same way. The clamp closing means a pipe change in those two and nothing
    // in the others.
    expect(hasPipeHandling('bohren')).toBe(true);
    expect(hasPipeHandling('auffuellen')).toBe(true);
    expect(hasPipeHandling('austausch')).toBe(false);
    expect(hasPipeHandling('einbauen')).toBe(false);
  });

  it('separates drilling from the phases after it', () => {
    expect(isRetracting('bohren')).toBe(false);
  });

  it('accepts exactly the four modes', () => {
    for (const m of ['bohren', ...NACH_DEM_BOHREN]) {
      expect(isOperatingMode(m), m).toBe(true);
    }
    expect(isOperatingMode('verpressen')).toBe(false);
    expect(isOperatingMode('')).toBe(false);
  });

  it('still migrates the legacy `verpressen` rows', () => {
    // Renamed in b3a825a; sessions recorded before it are still in the field.
    expect(normalizeOperatingMode('verpressen')).toBe('austausch');
    expect(normalizeOperatingMode('bohren')).toBe('bohren');
    expect(normalizeOperatingMode('unsinn')).toBeNull();
  });
});
