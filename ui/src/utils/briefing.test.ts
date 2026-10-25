import { describe, it, expect } from 'vitest';
import { briefingBeimOeffnen, hatBriefingInhalt, wertGroesse } from './briefing';
import type { VorgabenData } from '../hooks/useImplenia';

const VORGABEN: VorgabenData = {
  float_sensors: {
    Bohrlaenge: 43,
    Sollvolumen: 2500,
    Horizontalneigung: 12.5,
    Vertikalneigung: 8,
    'Tiefe Geologie 1': 2.5,
    'Tiefe Geologie 2': 36,
  },
  int_sensors: { 'Geologie 1': 45, 'Geologie 2': 20 },
};

/** A fresh Injektionsbohren element on its own route: the briefing's own case. */
function frisch(over: Partial<Parameters<typeof briefingBeimOeffnen>[0]> = {}) {
  return briefingBeimOeffnen({
    seite: 'element',
    verfahren: 'injektionsbohren',
    aufzeichnungLaeuft: false,
    bereitsAufgezeichnet: false,
    nochUnbekannt: false,
    vorgaben: VORGABEN,
    ...over,
  });
}

describe('briefingBeimOeffnen', () => {
  it('shows the briefing when a fresh element is opened', () => {
    expect(frisch()).toBe(true);
  });

  it('never shows it on the drilling route', () => {
    // `bohren/<name>` is "the drilling screen, directly" — it is what the
    // briefing's own forward button navigates to, so answering true here
    // would bounce the operator straight back.
    expect(frisch({ seite: 'bohren' })).toBe(false);
    expect(frisch({ seite: 'ausrichten' })).toBe(false);
    expect(frisch({ seite: 'home' })).toBe(false);
  });

  it('never shows it while a recording runs', () => {
    // The rig is in the hole. This is also what hands the screen over to the
    // drilling view the moment a recording is started from the briefing.
    expect(frisch({ aufzeichnungLaeuft: true })).toBe(false);
  });

  it('never shows it for an element this kiosk has already recorded', () => {
    // It is being resumed: drilling has started, and it reopens on the phase
    // its last session was in.
    expect(frisch({ bereitsAufgezeichnet: true })).toBe(false);
  });

  it('waits for the session lookup rather than guessing', () => {
    // `laedt` is not `bereitsAufgezeichnet: false` — answering early would
    // flash the briefing in front of a resumed element.
    expect(frisch({ nochUnbekannt: true })).toBe(false);
  });

  it('is Injektionsbohren only', () => {
    // DSV reads its Vorgaben in ElementDetail's own tab, and the sensor names
    // the screen draws are this Verfahren's contract.
    expect(frisch({ verfahren: 'dsv' })).toBe(false);
    expect(frisch({ verfahren: null })).toBe(false);
  });

  it('is skipped when there is nothing to brief', () => {
    expect(frisch({ vorgaben: null })).toBe(false);
    expect(frisch({ vorgaben: { float_sensors: { 'Druck Hammer': 180 } } })).toBe(false);
  });
});

describe('hatBriefingInhalt', () => {
  it('counts a planned depth on its own', () => {
    expect(hatBriefingInhalt({ float_sensors: { Bohrlaenge: 43 } })).toBe(true);
    expect(hatBriefingInhalt({ float_sensors: { Säulenhöhe: 12 } })).toBe(true);
  });

  it('counts a geology profile on its own', () => {
    expect(hatBriefingInhalt({ int_sensors: { 'Geologie 1': 5 } })).toBe(true);
  });

  it('ignores a geology code of zero, which means "not set"', () => {
    expect(hatBriefingInhalt({ int_sensors: { 'Geologie 1': 0 } })).toBe(false);
  });

  it('ignores a planned depth of zero', () => {
    expect(hatBriefingInhalt({ float_sensors: { Bohrlaenge: 0 } })).toBe(false);
  });

  it('does not count the values the screen draws beside them', () => {
    // Angles and coordinates alone are not a briefing — the hero and the
    // column are what the screen is built around.
    expect(hatBriefingInhalt({
      float_sensors: { Vertikalneigung: 8, 'Startpunkt X': 2681432.18 },
    })).toBe(false);
  });

  it('is false for absent vorgaben', () => {
    expect(hatBriefingInhalt(null)).toBe(false);
  });
});

describe('wertGroesse', () => {
  it('leaves an ordinary value at full size', () => {
    expect(wertGroesse('40,84', 5.5)).toBe('5.5rem');
    expect(wertGroesse('123,45', 5.5)).toBe('5.5rem');
  });

  /*
   * „2.500,00" is 434px in DejaVu Sans Bold at 5.5rem against a 385px cell —
   * see the function. The step is what keeps a four-digit Sollvolumen from
   * running into the Bohrlänge beside it on a kiosk, where nothing clips it
   * visibly except the container's `overflow: hidden`.
   */
  it('steps a four-digit value down to fit its cell', () => {
    expect(wertGroesse('2.500,00', 5.5)).toBe('4.125rem');
  });

  it('steps further when the number is longer still', () => {
    expect(wertGroesse('12.500,00', 5.5)).toBe('3.3rem');
  });

  it('scales from whatever size the row is set at', () => {
    expect(wertGroesse('-123,4°', 5)).toBe('3.75rem');
  });
});
