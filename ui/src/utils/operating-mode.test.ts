import { describe, it, expect } from 'vitest';
import {
  MODE_LABELS, PHASE_ORDER, VERPRESSEN_MODES,
  hasPipeHandling, isVerpressenMode, nextPhase, previousPhase,
} from './operating-mode';

/**
 * The phase sequence a pillar runs through.
 *
 * Pinned because the phase control is a stepper now: it shows where you are and
 * offers one step forward, which only works if "forward" is well defined and
 * the ends of the sequence are dead ends rather than wraps.
 */

describe('PHASE_ORDER', () => {
  it('is drilling, exchange, core, fill', () => {
    expect(PHASE_ORDER).toEqual(['bohren', 'austausch', 'einbauen', 'auffuellen']);
  });

  it('names every mode exactly once', () => {
    expect(new Set(PHASE_ORDER).size).toBe(PHASE_ORDER.length);
  });

  it('has a label for every phase', () => {
    for (const p of PHASE_ORDER) {
      expect(MODE_LABELS[p], `no label for ${p}`).toBeTruthy();
    }
  });

  it('starts with drilling and covers the post-drilling phases after it', () => {
    expect(PHASE_ORDER[0]).toBe('bohren');
    expect(PHASE_ORDER.slice(1)).toEqual([...VERPRESSEN_MODES]);
  });
});

describe('nextPhase', () => {
  it('walks the sequence forward', () => {
    expect(nextPhase('bohren')).toBe('austausch');
    expect(nextPhase('austausch')).toBe('einbauen');
    expect(nextPhase('einbauen')).toBe('auffuellen');
  });

  it('is null at the end — the stepper must not wrap round to drilling', () => {
    expect(nextPhase('auffuellen')).toBeNull();
  });
});

describe('previousPhase', () => {
  it('walks the sequence back', () => {
    expect(previousPhase('auffuellen')).toBe('einbauen');
    expect(previousPhase('einbauen')).toBe('austausch');
    expect(previousPhase('austausch')).toBe('bohren');
  });

  it('is null at the start', () => {
    expect(previousPhase('bohren')).toBeNull();
  });
});

describe('the sequence is traversable end to end', () => {
  it('reaches the last phase from the first, one step at a time', () => {
    const walked: string[] = ['bohren'];
    let at = nextPhase('bohren');
    while (at) {
      walked.push(at);
      at = nextPhase(at);
    }
    expect(walked).toEqual([...PHASE_ORDER]);
  });

  it('steps back to the first phase from the last', () => {
    const walked: string[] = ['auffuellen'];
    let at = previousPhase('auffuellen');
    while (at) {
      walked.push(at);
      at = previousPhase(at);
    }
    expect(walked).toEqual([...PHASE_ORDER].reverse());
  });
});

describe('why skipping a phase is harmless', () => {
  it('groups every post-drilling phase together', () => {
    // Part of what makes "tap forward twice to skip" acceptable. The other
    // half is server-side, where clipping actually happens — see
    // ingestion.test.ts.
    for (const m of VERPRESSEN_MODES) {
      expect(hasPipeHandling(m), m).toBe(true);
      expect(isVerpressenMode(m), m).toBe(true);
    }
  });

  it('separates drilling from them', () => {
    expect(isVerpressenMode('bohren')).toBe(false);
    // Drilling still handles pipes — that is what Rohrverlängerung clips on.
    expect(hasPipeHandling('bohren')).toBe(true);
  });
});
