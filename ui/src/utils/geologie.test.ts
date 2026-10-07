import { describe, it, expect } from 'vitest';
import {
  vomServer, naechsteGrenze, kurzLabel, farbeVon, nameVon, istHindernis,
  zumCommit, BODENARTEN, HINDERNISSE,
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
