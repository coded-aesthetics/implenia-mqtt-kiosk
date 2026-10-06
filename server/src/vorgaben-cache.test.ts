import { describe, it, expect, beforeAll } from 'vitest';

let db: typeof import('./db.js');

beforeAll(async () => {
  db = await import('./db.js');

  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

const VORGABEN = {
  float_sensors: { 'Tiefe Geologie 1': 4.5, 'Tiefe Geologie 2': 11.2 },
  int_sensors: { 'Geologie 1': 3, 'Geologie 2': 7 },
  string_sensors: { Ausführungsdatum: null },
};

describe('vorgaben cache', () => {
  it('returns null for an element it has never seen', () => {
    expect(db.getElementVorgaben('never-seen')).toBeNull();
  });

  it('round-trips the vorgaben a shift assignment carried', () => {
    // The whole point: a pillar resumed days later still has its geology
    // profile and Soll values, which only live in the shift assignment that
    // the element has since dropped out of.
    db.setElementVorgaben('P-101', VORGABEN);
    expect(db.getElementVorgaben('P-101')).toEqual(VORGABEN);
  });

  it('overwrites on re-fetch so a portal edit is not pinned forever', () => {
    db.setElementVorgaben('P-102', VORGABEN);
    const edited = { ...VORGABEN, float_sensors: { 'Tiefe Geologie 1': 9.9 } };
    db.setElementVorgaben('P-102', edited);
    expect(db.getElementVorgaben('P-102')).toEqual(edited);
  });

  it('keeps elements apart', () => {
    db.setElementVorgaben('P-103', VORGABEN);
    db.setElementVorgaben('P-104', { float_sensors: { 'Tiefe Geologie 1': 1 } });
    expect(db.getElementVorgaben('P-103')).toEqual(VORGABEN);
    expect(db.getElementVorgaben('P-104')).toEqual({ float_sensors: { 'Tiefe Geologie 1': 1 } });
  });

  it('survives an element name with characters that need encoding', () => {
    // Element names come off the wire and have carried slashes and spaces
    // before; the cache key is the raw name, not a URL-encoded one.
    const name = 'Pfahl 7/2 (Süd)';
    db.setElementVorgaben(name, VORGABEN);
    expect(db.getElementVorgaben(name)).toEqual(VORGABEN);
  });
});
