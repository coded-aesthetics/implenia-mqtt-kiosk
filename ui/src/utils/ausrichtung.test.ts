import { describe, it, expect } from 'vitest';
import {
  kuerzesterWeg, norm360, bewerteStatus, bewerteHorizontal, bewerteVertikal,
  ausrichtungErforderlich, ausrichtungMoeglich, sollImBild, sensorFuerRolle,
  MAX_VERTIKAL,
  TOLERANZ_HORIZONTAL, TOLERANZ_VERTIKAL, NAH_SCHWELLE,
} from './ausrichtung';
import type { VorgabenData } from '../hooks/useImplenia';

function vorgaben(float: Record<string, number>): VorgabenData {
  return { float_sensors: float } as unknown as VorgabenData;
}

describe('norm360', () => {
  it('folds a full turn away', () => {
    expect(norm360(0)).toBe(0);
    expect(norm360(360)).toBe(0);
    expect(norm360(725)).toBe(5);
  });

  it('brings a negative angle into 0..360', () => {
    expect(norm360(-10)).toBe(350);
    expect(norm360(-370)).toBe(350);
  });
});

describe('kuerzesterWeg', () => {
  it('is signed: positive clockwise, negative counter-clockwise', () => {
    expect(kuerzesterWeg(136.7, 142)).toBeCloseTo(5.3, 6);
    expect(kuerzesterWeg(142, 136.7)).toBeCloseTo(-5.3, 6);
  });

  it('takes the short way over 0/360 instead of turning the machine around', () => {
    expect(kuerzesterWeg(358, 2)).toBeCloseTo(4, 6);
    expect(kuerzesterWeg(2, 358)).toBeCloseTo(-4, 6);
  });

  it('is 0 when the two angles are a full turn apart', () => {
    expect(kuerzesterWeg(10, 370)).toBeCloseTo(0, 6);
  });

  /*
   * Exactly opposite is a choice between two equal turns. It resolves to
   * +180 rather than -180 so the hint never flickers between "nach rechts"
   * and "nach links" while the machine sits still.
   */
  it('resolves the half turn to one direction', () => {
    expect(kuerzesterWeg(0, 180)).toBe(180);
    expect(kuerzesterWeg(180, 0)).toBe(180);
  });
});

describe('bewerteStatus', () => {
  it('counts the tolerance itself as aligned', () => {
    expect(bewerteStatus(1, 1)).toBe('ok');
    expect(bewerteStatus(-1, 1)).toBe('ok');
    expect(bewerteStatus(1.01, 1)).toBe('nah');
  });

  it('judges in degrees, not relative to the Soll', () => {
    // 2° off a Soll of 180 is 1% — and still a hole in the wrong direction.
    expect(bewerteHorizontal(178, 180).status).toBe('nah');
    // 0.5° off a Soll of 0 is not "infinitely wrong" either.
    expect(bewerteHorizontal(0.5, 0).status).toBe('ok');
  });

  it('separates almost-there from far-off at the threshold', () => {
    expect(bewerteStatus(NAH_SCHWELLE, TOLERANZ_HORIZONTAL)).toBe('nah');
    expect(bewerteStatus(NAH_SCHWELLE + 0.1, TOLERANZ_HORIZONTAL)).toBe('weit');
  });
});

describe('bewerteHorizontal', () => {
  it('says which way to turn, in German', () => {
    expect(bewerteHorizontal(136.7, 142).hinweis).toBe('5,3° nach rechts');
    expect(bewerteHorizontal(142, 136.7).hinweis).toBe('5,3° nach links');
  });

  it('names the state instead of a number once it is aligned', () => {
    expect(bewerteHorizontal(141.6, 142).hinweis).toBe('Ausgerichtet');
  });

  it('keeps the instruction on the short side of the wrap', () => {
    expect(bewerteHorizontal(358, 2).hinweis).toBe('4,0° nach rechts');
  });
});

describe('bewerteVertikal', () => {
  it('does not wrap: an inclination is not a direction', () => {
    expect(bewerteVertikal(12.1, 15).abweichung).toBeCloseTo(2.9, 6);
    expect(bewerteVertikal(15, 12.1).abweichung).toBeCloseTo(-2.9, 6);
  });

  it('tells the mast which way to move', () => {
    expect(bewerteVertikal(12.1, 15).hinweis).toBe('2,9° stärker neigen');
    expect(bewerteVertikal(15, 12.1).hinweis).toBe('2,9° steiler stellen');
  });

  it('uses its own, tighter tolerance', () => {
    expect(bewerteVertikal(15 - TOLERANZ_VERTIKAL, 15).status).toBe('ok');
    expect(bewerteVertikal(15 - TOLERANZ_VERTIKAL - 0.1, 15).status).toBe('nah');
  });
});

describe('ausrichtungErforderlich', () => {
  it('is required for a tilted mast', () => {
    expect(ausrichtungErforderlich(vorgaben({ Vertikalneigung: 15, Horizontalneigung: 142 }))).toBe(true);
  });

  it('is not required for a plumb hole, whatever its rotation says', () => {
    expect(ausrichtungErforderlich(vorgaben({ Vertikalneigung: 0, Horizontalneigung: 142 }))).toBe(false);
  });

  it('is required for a tilted mast pointing straight ahead', () => {
    expect(ausrichtungErforderlich(vorgaben({ Vertikalneigung: 15, Horizontalneigung: 0 }))).toBe(true);
  });

  it('is not required without a Vorgabe to align to', () => {
    expect(ausrichtungErforderlich(null)).toBe(false);
    expect(ausrichtungErforderlich(vorgaben({ Bohrtiefe: 12 }))).toBe(false);
  });

  it('counts a negative inclination, which is still a tilt', () => {
    expect(ausrichtungErforderlich(vorgaben({ Vertikalneigung: -8 }))).toBe(true);
  });
});

describe('sensorFuerRolle', () => {
  const sensoren = [
    { name: 'Bohrtiefe', role: 'depth' },
    { name: 'Richtung X', role: 'inclination_x' },
    { name: 'Richtung Y', role: 'inclination_y' },
  ];

  it('finds a sensor by role, whatever the Verfahren calls it', () => {
    expect(sensorFuerRolle(sensoren, 'inclination_x')).toBe('Richtung X');
    expect(sensorFuerRolle([{ name: 'Alpha', role: 'inclination_x' }], 'inclination_x')).toBe('Alpha');
  });

  it('returns null rather than guessing when the role is absent', () => {
    expect(sensorFuerRolle(sensoren, 'rotation')).toBeNull();
    expect(sensorFuerRolle(null, 'inclination_x')).toBeNull();
  });
});

describe('ausrichtungMoeglich', () => {
  const beide = [
    { name: 'Richtung X', role: 'inclination_x' },
    { name: 'Richtung Y', role: 'inclination_y' },
  ];

  it('is true only when both live angle roles exist', () => {
    expect(ausrichtungMoeglich(beide)).toBe(true);
  });

  it('is false for a Verfahren that declares the Vorgaben but not the sensors', () => {
    // Ankerbohren: the Vorgabe CSV carries Horizontal-/Vertikalneigung, the
    // herstellen CSV has no inclination row — the slot would have led to a
    // screen that can only say the feature is unavailable.
    expect(ausrichtungMoeglich([{ name: 'Bohrtiefe', role: 'depth' }])).toBe(false);
    expect(ausrichtungMoeglich([beide[0]])).toBe(false);
  });

  it('is false while the sensor list has not answered', () => {
    expect(ausrichtungMoeglich(null)).toBe(false);
  });
});

describe('sollImBild', () => {
  it('accepts a Soll the inclination dial can draw', () => {
    expect(sollImBild(0)).toBe(true);
    expect(sollImBild(17.5)).toBe(true);
    expect(sollImBild(MAX_VERTIKAL)).toBe(true);
  });

  it('rejects a Soll off either end of the scale', () => {
    // Clamping these onto the scale laid the dashed Soll mast over the real
    // one: the picture said aligned, the words said 8 degrees off.
    expect(sollImBild(-8)).toBe(false);
    expect(sollImBild(MAX_VERTIKAL + 0.1)).toBe(false);
  });

  it('rejects a missing Soll, so no target is drawn at 0', () => {
    expect(sollImBild(null)).toBe(false);
  });

  it('honours a narrower scale', () => {
    expect(sollImBild(75, 60)).toBe(false);
  });
});
