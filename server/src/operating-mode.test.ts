import { describe, it, expect } from 'vitest';
import {
  hasPipeHandling, isOperatingMode, isRetracting, normalizeOperatingMode,
  type OperatingMode,
} from './ingestion.js';

/**
 * The operating-mode predicates that govern Rohrverlängerung clipping.
 *
 * Pinned because the UI's phase control is a stepper that advances one phase at
 * a time, which means **skipping a phase is done by stepping through it**. That
 * is only acceptable if passing through Austausch on the way to Einbauen
 * changes no behaviour — so the three post-drilling phases must stay
 * indistinguishable here. If one of them ever needs different clipping, the
 * stepper needs a way to skip without entering.
 */

const NACH_DEM_BOHREN: OperatingMode[] = ['austausch', 'einbauen', 'auffuellen'];

describe('operating-mode predicates', () => {
  it('treats every post-drilling phase identically', () => {
    for (const m of NACH_DEM_BOHREN) {
      expect(isRetracting(m), m).toBe(true);
      expect(hasPipeHandling(m), m).toBe(true);
    }
  });

  it('separates drilling from them, except for pipe handling', () => {
    expect(isRetracting('bohren')).toBe(false);
    // Drilling handles pipes too — that is what Rohrverlängerung clips on.
    expect(hasPipeHandling('bohren')).toBe(true);
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
