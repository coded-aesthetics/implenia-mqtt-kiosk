import { describe, it, expect } from 'vitest';
import { MAX_KORREKTUR_CM, naechsteKorrektur, nurTieferMoeglich } from './tiefenkorrektur';

/** The correction after pressing a sequence of step buttons, in metres. */
function druecke(tiefe: number, schritteCm: number[]): number[] {
  let cm = 0;
  return schritteCm.map((s) => {
    cm = naechsteKorrektur(cm, s, tiefe);
    return cm / 100;
  });
}

/** ...and what „Neue Tiefe" shows after each of them. */
function neueTiefe(tiefe: number, schritteCm: number[]): number[] {
  return druecke(tiefe, schritteCm).map((d) => Math.round((tiefe + d) * 100) / 100);
}

describe('naechsteKorrektur', () => {
  it('steps in both directions and stops the depth at zero', () => {
    expect(neueTiefe(3.5, [-100, -100, -100, -100, -100, 100]))
      .toEqual([2.5, 1.5, 0.5, 0, 0, 1]);
  });

  it('adds up the small steps to the centimetre', () => {
    expect(druecke(10, [10, 10, 1, -1, -10])).toEqual([0.1, 0.2, 0.21, 0.2, 0.1]);
  });

  /*
   * The field bug, 2026-10-26: "die Tiefe wird immer auf Null gesetzt, egal
   * welchen Knopf ich drücke". The lower bound was a plain `-tiefe`, which is
   * a *positive* number as soon as the rig reports a depth above ground — so
   * every press was pushed up to exactly `-tiefe` and „Neue Tiefe" read 0,00 m
   * whichever button it was.
   */
  it('leaves a negative reported depth alone until the operator adds to it', () => {
    // Pressing „Flacher" cannot help here and must not pretend to: the depth
    // is already above ground, so the correction stays where it was.
    expect(neueTiefe(-3.2, [-100, -10, -1])).toEqual([-3.2, -3.2, -3.2]);
    // „Tiefer" is the direction that exists, and it starts from what the rig
    // actually reports rather than from a correction nobody dialled in.
    expect(neueTiefe(-3.2, [100, 100, 100, 100])).toEqual([-2.2, -1.2, -0.2, 0.8]);
  });

  it('never arms Übernehmen with a correction nobody pressed for', () => {
    // The first press used to jump the correction to +3,20 m — in the opposite
    // direction to the button — and one more tap would have moved the hole by
    // it. A „Flacher" press on such a rig now changes nothing at all.
    expect(naechsteKorrektur(0, -100, -3.2)).toBe(0);
    expect(naechsteKorrektur(0, -1, -0.05)).toBe(0);
  });

  it('treats a rig reporting exactly zero the same way', () => {
    expect(druecke(0, [-100, -10, 100, 100])).toEqual([0, 0, 1, 2]);
  });

  it('caps the correction at what the server accepts, both ways', () => {
    expect(naechsteKorrektur(MAX_KORREKTUR_CM, 100, 60)).toBe(MAX_KORREKTUR_CM);
    expect(naechsteKorrektur(-MAX_KORREKTUR_CM, -100, 999)).toBe(-MAX_KORREKTUR_CM);
  });

  it('reads a missing depth as nothing to correct', () => {
    // The screen shows its own notice instead of the buttons in this state;
    // the bound still may not invent a correction if one slips through.
    expect(naechsteKorrektur(0, -100, null)).toBe(0);
    expect(naechsteKorrektur(0, 100, null)).toBe(100);
  });
});

describe('nurTieferMoeglich', () => {
  it('is true exactly where the Flacher buttons cannot move the depth', () => {
    expect(nurTieferMoeglich(-3.2)).toBe(true);
    expect(nurTieferMoeglich(0)).toBe(true);
    expect(nurTieferMoeglich(0.01)).toBe(false);
    expect(nurTieferMoeglich(12)).toBe(false);
    expect(nurTieferMoeglich(null)).toBe(false);
  });
});
