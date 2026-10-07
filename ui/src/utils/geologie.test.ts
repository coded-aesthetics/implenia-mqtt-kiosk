import { describe, it, expect } from 'vitest';
import { grundBei } from '@coded-aesthetics/din4023/profile';
import {
  vomServer, naechsteGrenze, kurzLabel, farbeVon, nameVon, istHindernis,
  zumCommit, vorgabeArten, MAX_SPALTEN_KACHELN, BODENARTEN, HINDERNISSE,
} from './geologie';

const SAND = 5;
const SCHLUFF = 9;
const TON = 10;
const BETON = 60;

/** Compact profile shape for assertions: "startDepth:nr" per layer. */
function umriss(schichten: readonly { tiefe: number; nr: number }[]): string[] {
  return schichten.map((s) => `${s.tiefe}:${s.nr}`);
}

describe('vomServer', () => {
  it('turns a Vorgabe-sourced boundary into a provisional one', () => {
    const p = vomServer({
      schichten: [
        { tiefe: 0, nr: SAND, quelle: 'vorgabe' },
        { tiefe: 2.5, nr: SCHLUFF, quelle: 'ist' },
        { tiefe: 7, nr: TON, quelle: 'vorgabe' },
      ],
      endTiefe: 10,
    })!;
    expect(umriss(p.schichten)).toEqual(['0:5', '2.5:9', '7:10']);
    expect(p.schichten.map((s) => !!s.vorlaeufig)).toEqual([true, false, true]);
    expect(p.endTiefe).toBe(10);
  });

  it('leaves an observed layer with no flag at all, not a false one', () => {
    // normalisiere treats absent and false alike, but an explicit false would
    // survive a round trip through JSON as a key that means nothing.
    const p = vomServer({
      schichten: [{ tiefe: 0, nr: SAND, quelle: 'ist' }],
      endTiefe: 5,
    })!;
    expect('vorlaeufig' in p.schichten[0]).toBe(false);
  });

  it('carries an obstruction through unchanged', () => {
    const p = vomServer({
      schichten: [
        { tiefe: 0, nr: SAND, quelle: 'vorgabe' },
        { tiefe: 4, nr: BETON, quelle: 'ist' },
        { tiefe: 4.4, nr: SAND, quelle: 'ist' },
      ],
      endTiefe: 9,
    })!;
    expect(umriss(p.schichten)).toEqual(['0:5', '4:60', '4.4:5']);
    expect(istHindernis(p.schichten[1].nr)).toBe(true);
  });

  it('is null when the server has no profile to show', () => {
    expect(vomServer(null)).toBeNull();
    expect(vomServer(undefined)).toBeNull();
    expect(vomServer({ schichten: [], endTiefe: 10 })).toBeNull();
  });

  it('round-trips back to the shape the commit sends', () => {
    const vom = {
      schichten: [
        { tiefe: 0, nr: SAND, quelle: 'vorgabe' as const },
        { tiefe: 3, nr: TON, quelle: 'ist' as const },
      ],
      endTiefe: 8,
    };
    expect(zumCommit(vomServer(vom)!.schichten)).toEqual([
      { tiefe: 0, nr: SAND, name: 'Sand', quelle: 'vorgabe' },
      { tiefe: 3, nr: TON, name: 'Ton', quelle: 'ist' },
    ]);
  });
});

describe('naechsteGrenze', () => {
  const schichten = [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }, { tiefe: 7, nr: TON }];

  it('announces a boundary the drilling is approaching', () => {
    expect(naechsteGrenze(schichten, 2.8)).toEqual({ tiefe: 3, nr: SCHLUFF });
  });

  it('still announces one just passed', () => {
    expect(naechsteGrenze(schichten, 3.2)).toEqual({ tiefe: 3, nr: SCHLUFF });
  });

  it('stays quiet in the middle of a layer', () => {
    expect(naechsteGrenze(schichten, 5)).toBeNull();
  });

  it('never announces the top of the hole', () => {
    expect(naechsteGrenze(schichten, 0)).toBeNull();
    expect(naechsteGrenze(schichten, 0.1)).toBeNull();
  });

  it('picks the nearer of two close boundaries', () => {
    const dicht = [{ tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }, { tiefe: 3.4, nr: TON }];
    expect(naechsteGrenze(dicht, 3.3)).toEqual({ tiefe: 3.4, nr: TON });
  });

  it('respects a custom window', () => {
    expect(naechsteGrenze(schichten, 2.5, 0.3)).toBeNull();
    expect(naechsteGrenze(schichten, 2.5, 0.6)).toEqual({ tiefe: 3, nr: SCHLUFF });
  });

  it('is quiet for a depth that is not a number', () => {
    expect(naechsteGrenze(schichten, NaN)).toBeNull();
  });

  it('is quiet for an empty profile', () => {
    expect(naechsteGrenze([], 3)).toBeNull();
  });
});

describe('the vocabulary', () => {
  it('offers the fifteen soils and six obstructions', () => {
    expect(BODENARTEN).toHaveLength(15);
    expect(HINDERNISSE).toHaveLength(6);
  });

  it('distinguishes obstructions by name, since they share one Kurzform', () => {
    // Every Hindernis entry has kurzform "Hi", so the Kurzform alone would make
    // six identical tiles.
    expect(HINDERNISSE.every((e) => e.kurzform === 'Hi')).toBe(true);
    expect(HINDERNISSE.map((e) => kurzLabel(e.nr))).toEqual([
      'Stahl', 'Beton', 'Holz', 'Sonstiges', 'Hohlräume', 'Findling',
    ]);
  });

  it('uses the DIN Kurzform for soils and rocks', () => {
    expect(kurzLabel(SAND)).toBe('S');
    expect(kurzLabel(SCHLUFF)).toBe('U');
  });

  it('names a ground type for the text series', () => {
    expect(nameVon(SAND)).toBe('Sand');
    expect(nameVon(BETON)).toBe('Hindernis Beton');
  });

  it('falls back readably for a number outside the tables', () => {
    expect(nameVon(999)).toBe('GeoDIN 999');
    expect(kurzLabel(999)).toBe('999');
  });

  it('gives obstructions a colour, since DIN 4023 gives them none', () => {
    expect(HINDERNISSE.every((e) => e.farbHex === undefined)).toBe(true);
    expect(farbeVon(BETON)).toBe('var(--surface-0)');
    expect(farbeVon(SAND)).toMatch(/^#/);
  });

  it('recognises an obstruction by number', () => {
    expect(istHindernis(BETON)).toBe(true);
    expect(istHindernis(SAND)).toBe(false);
    expect(istHindernis(999)).toBe(false);
  });
});

describe('zumCommit', () => {
  it('carries the provenance of every boundary', () => {
    expect(zumCommit([
      { tiefe: 0, nr: SAND, vorlaeufig: true },
      { tiefe: 2, nr: SCHLUFF },
    ])).toEqual([
      { tiefe: 0, nr: SAND, name: 'Sand', quelle: 'vorgabe' },
      { tiefe: 2, nr: SCHLUFF, name: 'Schluff', quelle: 'ist' },
    ]);
  });

  it('prefers a per-layer description over the DIN name', () => {
    expect(zumCommit([{ tiefe: 0, nr: SAND, beschreibung: 'Feinsand, humos' }])[0].name)
      .toBe('Feinsand, humos');
  });
});

describe('vorgabeArten', () => {
  it('lists the soil types the Vorgabe names, shallowest first', () => {
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF }, { tiefe: 7, nr: TON },
    ])).toEqual([SAND, SCHLUFF, TON]);
  });

  it('collapses a repeated type to one choice', () => {
    // S/U/S/T is three choices, not four: picking "the second sand" and "the
    // first sand" are the same act.
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: SCHLUFF },
      { tiefe: 4, nr: SAND }, { tiefe: 6, nr: TON },
    ])).toEqual([SAND, SCHLUFF, TON]);
  });

  it('orders by depth, not by the order the layers arrived in', () => {
    expect(vorgabeArten([
      { tiefe: 7, nr: TON }, { tiefe: 0, nr: SAND }, { tiefe: 3, nr: SCHLUFF },
    ])).toEqual([SAND, SCHLUFF, TON]);
  });

  it('leaves obstructions out — they have their own list', () => {
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 2, nr: BETON }, { tiefe: 2.4, nr: SCHLUFF },
    ])).toEqual([SAND, SCHLUFF]);
  });

  it('ignores unusable entries', () => {
    expect(vorgabeArten([
      { tiefe: 0, nr: SAND }, { tiefe: 1, nr: 0 },
      { tiefe: 2, nr: -1 }, { tiefe: 3, nr: 2.5 },
    ])).toEqual([SAND]);
  });

  it('is empty for an absent or empty profile', () => {
    expect(vorgabeArten(null)).toEqual([]);
    expect(vorgabeArten(undefined)).toEqual([]);
    expect(vorgabeArten([])).toEqual([]);
  });

  it('leaves room for the Andere tile within the column', () => {
    // The column holds eight 64px targets; the last is always Andere.
    expect(MAX_SPALTEN_KACHELN).toBe(7);
  });
});

describe('the ground an obstruction returns to', () => {
  /*
   * "Hindernis Ende" records one tap with no pick, which only works if the
   * right answer is knowable. It is: the obstruction interrupted a layer the
   * Vorgabe planned, and the Vorgabe holds only soils — never obstructions —
   * so the planned ground at the current depth is always a soil to resume.
   *
   * useGeologieErfassung derives it with grundBei; these pin what that means,
   * including the one case where it cannot answer and the picker has to open.
   */
  const vorgabe = [
    { tiefe: 0, nr: SAND },
    { tiefe: 3, nr: SCHLUFF },
    { tiefe: 7, nr: TON },
  ];

  it('resumes the layer the obstruction interrupted', () => {
    // Concrete met at 4.0 m, inside the planned schluff layer (3–7 m).
    expect(grundBei(vorgabe, 4.2)).toBe(SCHLUFF);
  });

  it('resumes the right layer when the obstruction spans a planned boundary', () => {
    // Met at 6.8 m, left at 7.2 m — below it the plan says ton, not schluff.
    expect(grundBei(vorgabe, 7.2)).toBe(TON);
  });

  it('never resumes into an obstruction, because the plan holds none', () => {
    const arten = vorgabeArten(vorgabe);
    expect(arten.some(istHindernis)).toBe(false);
    for (const tiefe of [0, 1.5, 3, 5, 7, 9]) {
      const nr = grundBei(vorgabe, tiefe);
      expect(nr === null || !istHindernis(nr), `at ${tiefe} m`).toBe(true);
    }
  });

  it('answers nothing above the first layer, which is what opens the picker', () => {
    expect(grundBei([{ tiefe: 2, nr: SAND }], 1)).toBeNull();
  });
});
