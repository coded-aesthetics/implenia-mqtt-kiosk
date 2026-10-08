import { describe, it, expect } from 'vitest';
import { ALLE_EINTRAEGE } from '@coded-aesthetics/din4023';
import { normalformen, sucheEintraege } from './geologie-suche';
import { WAEHLBAR } from './geologie';

/** The names a result list carries, for readable assertions. */
function namen(q: string, kandidaten = WAEHLBAR): string[] {
  return sucheEintraege(q, kandidaten).map((e) => e.name);
}

describe('normalformen', () => {
  it('offers both the stripped and the spelled-out umlaut', () => {
    expect(normalformen('Löß')).toEqual(['loss', 'loess']);
    expect(normalformen('Bänderton')).toEqual(['banderton', 'baenderton']);
  });

  it('collapses to one form when the word has no umlaut', () => {
    expect(normalformen('Sand')).toEqual(['sand']);
  });

  it('treats ß as ss in both forms', () => {
    expect(normalformen('Löß')[0]).toContain('ss');
    expect(normalformen('Löß')[1]).toContain('ss');
  });
});

describe('sucheEintraege', () => {
  it('finds Löß however the operator spells it', () => {
    // The reason both normal forms exist: neither fold alone answers all three.
    for (const q of ['Löß', 'Loess', 'Loss', 'lößl', 'loesslehm']) {
      expect(namen(q).length, q).toBeGreaterThan(0);
    }
    expect(namen('Löß')[0]).toBe('Löß');
    expect(namen('Loess')[0]).toBe('Löß');
    expect(namen('Loss')[0]).toBe('Löß');
  });

  it('puts the exact Kurzform first, not the names that merely contain it', () => {
    // Typing `T` is a supervisor writing `T` on paper, and it has to mean Ton.
    expect(namen('T')[0]).toBe('Ton');
    expect(namen('S')[0]).toBe('Sand');
    expect(namen('U')[0]).toBe('Schluff');
  });

  it('finds a word inside a compound name', () => {
    expect(namen('lehm')).toContain('Verwitterungslehm, Hanglehm');
    expect(namen('lehm')).toContain('Lößlehm');
    expect(namen('kreide')).toContain('Kreidestein');
  });

  it('finds the non-petrographic types the picker used to hide', () => {
    expect(namen('Auffüllung')).toEqual(['Auffüllung']);
    expect(namen('auffuellung')).toEqual(['Auffüllung']);
    expect(namen('Mutterboden')).toEqual(['Mutterboden']);
    expect(namen('Geschiebemergel')).toContain('Geschiebemergel');
  });

  it('matches a table or category word', () => {
    expect(namen('organisch')).toContain('Torf, Humus');
    expect(namen('Fels').length).toBeGreaterThan(10);
  });

  it('matches the GeoDIN code, which is what a protocol shows', () => {
    expect(namen('10')).toEqual(['Ton']);
    expect(sucheEintraege('60', ALLE_EINTRAEGE).map((e) => e.name))
      .toEqual(['Hindernis Beton']);
  });

  it('returns the candidates untouched and in order for an empty query', () => {
    expect(sucheEintraege('   ', WAEHLBAR)).toEqual([...WAEHLBAR]);
    expect(sucheEintraege('', WAEHLBAR).map((e) => e.nr))
      .toEqual(WAEHLBAR.map((e) => e.nr));
  });

  it('returns nothing rather than everything for a miss', () => {
    expect(namen('zzzz')).toEqual([]);
  });

  it('never leaves the candidate set it was given', () => {
    // The obstruction picker searches only obstructions; a query matching a
    // soil must not smuggle one in.
    const hindernisse = ALLE_EINTRAEGE.filter((e) => e.tabelle === 'Hindernis');
    expect(sucheEintraege('Sand', hindernisse)).toEqual([]);
  });
});
