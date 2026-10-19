import { describe, it, expect } from 'vitest';
import {
  layoutFor,
  separatorFor,
  charFor,
  insert,
  backspace,
  rowsFor,
  TEXT_ROWS,
  SYMBOL_ROWS,
  numpadRows,
  type Key,
} from './touchKeyboard';

describe('layoutFor', () => {
  it('gives number fields the numpad', () => {
    expect(layoutFor({ type: 'number' })).toBe('numpad');
    expect(layoutFor({ inputMode: 'decimal' })).toBe('numpad');
    expect(layoutFor({ inputMode: 'numeric' })).toBe('numpad');
  });

  it('gives text, url, password and textareas the letters', () => {
    expect(layoutFor({ type: 'text' })).toBe('text');
    expect(layoutFor({ inputMode: 'url' })).toBe('text');
    expect(layoutFor({ type: 'password' })).toBe('text');
    expect(layoutFor({ tagName: 'TEXTAREA' })).toBe('text');
  });
});

describe('separatorFor', () => {
  // The app's own decimal fields keep the raw string and normalise ',' to '.'
  // themselves (CalibrationPage.parseNumber, RohrwechselSettings).
  it('is a comma for the app-parsed decimal fields', () => {
    expect(separatorFor({ inputMode: 'decimal' })).toBe(',');
  });

  // Not a period: HTML value sanitization empties a type=number input whenever
  // its value is not a valid number, and "1." always is one on the way to
  // "1.2" — so the browser answers el.value as "" and the next digit starts
  // over. A separator key there produces "2" out of 1, '.', 2.
  it('is null for type=number, which can hold no intermediate decimal', () => {
    expect(separatorFor({ type: 'number' })).toBeNull();
  });

  it('puts the separator and a minus on the pad when the field takes them', () => {
    const labels = numpadRows(',').flat().map((k) => (k.kind === 'char' ? k.label : k.kind));
    expect(labels).toContain(',');
    expect(labels).toContain('-');
  });

  it('gives a digits-only pad when it does not', () => {
    const labels = numpadRows(null).flat().map((k) => (k.kind === 'char' ? k.label : k.kind));
    expect(labels).not.toContain(',');
    expect(labels).not.toContain('.');
    expect(labels).not.toContain('-');
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) expect(labels).toContain(d);
    expect(labels).toContain('backspace');
    expect(labels).toContain('done');
  });
});

describe('charFor', () => {
  it('shifts letters', () => {
    expect(charFor({ kind: 'char', label: 'q' }, false)).toBe('q');
    expect(charFor({ kind: 'char', label: 'q' }, true)).toBe('Q');
    expect(charFor({ kind: 'char', label: 'ü' }, true)).toBe('Ü');
  });

  it('uses an explicit shifted character where upper case is wrong', () => {
    expect(charFor({ kind: 'char', label: 'ß', shifted: 'ß' }, true)).toBe('ß');
    expect(charFor({ kind: 'char', label: '-', shifted: '_' }, true)).toBe('_');
  });

  it('produces a space for the space key and nothing for the rest', () => {
    expect(charFor({ kind: 'space' }, false)).toBe(' ');
    expect(charFor({ kind: 'backspace' }, false)).toBeNull();
    expect(charFor({ kind: 'done' }, false)).toBeNull();
    expect(charFor({ kind: 'layout', to: 'text', label: 'ABC' }, false)).toBeNull();
  });
});

describe('insert', () => {
  it('inserts at the caret', () => {
    expect(insert({ value: 'Fels', start: 4, end: 4 }, '!')).toEqual({
      value: 'Fels!', start: 5, end: 5,
    });
  });

  it('inserts in the middle', () => {
    expect(insert({ value: 'Fes', start: 2, end: 2 }, 'l')).toEqual({
      value: 'Fels', start: 3, end: 3,
    });
  });

  it('replaces a selection', () => {
    expect(insert({ value: 'Sand', start: 0, end: 4 }, 'Fels')).toEqual({
      value: 'Fels', start: 4, end: 4,
    });
  });
});

describe('backspace', () => {
  it('deletes the character before the caret', () => {
    expect(backspace({ value: 'Fels', start: 4, end: 4 })).toEqual({
      value: 'Fel', start: 3, end: 3,
    });
  });

  it('deletes before the caret, not at the end', () => {
    expect(backspace({ value: 'Fells', start: 4, end: 4 })).toEqual({
      value: 'Fels', start: 3, end: 3,
    });
  });

  it('deletes a selection', () => {
    expect(backspace({ value: 'Sand und Fels', start: 0, end: 9 })).toEqual({
      value: 'Fels', start: 0, end: 0,
    });
  });

  // A naive slice(0, -1) wraps round here and eats the last character of a
  // value the worker never asked to change.
  it('does nothing at position 0', () => {
    expect(backspace({ value: 'Fels', start: 0, end: 0 })).toEqual({
      value: 'Fels', start: 0, end: 0,
    });
  });

  it('does nothing on an empty value', () => {
    expect(backspace({ value: '', start: 0, end: 0 })).toEqual({ value: '', start: 0, end: 0 });
  });
});

describe('layouts', () => {
  const chars = (rows: Key[][]) =>
    rows.flat().filter((k): k is Extract<Key, { kind: 'char' }> => k.kind === 'char');

  it('every layout can be left again', () => {
    expect(SYMBOL_ROWS.flat().some((k) => k.kind === 'layout' && k.to === 'text')).toBe(true);
    expect(TEXT_ROWS.flat().some((k) => k.kind === 'layout' && k.to === 'symbols')).toBe(true);
  });

  it('every layout can be dismissed and corrected', () => {
    for (const rows of [TEXT_ROWS, SYMBOL_ROWS, numpadRows(','), numpadRows(null)]) {
      expect(rows.flat().some((k) => k.kind === 'done')).toBe(true);
      expect(rows.flat().some((k) => k.kind === 'backspace')).toBe(true);
    }
  });

  it('carries the umlauts and ß a German description needs', () => {
    const labels = chars(TEXT_ROWS).map((k) => k.label);
    for (const ch of ['ä', 'ö', 'ü', 'ß']) expect(labels).toContain(ch);
  });

  it('carries what a broker URL and an API URL need', () => {
    const labels = chars(SYMBOL_ROWS).map((k) => k.label);
    for (const ch of [':', '/', '.', '-', '_', '@']) expect(labels).toContain(ch);
  });

  it('numpad has the minus a negative calibration offset needs', () => {
    expect(chars(numpadRows(',')).map((k) => k.label)).toContain('-');
  });

  it('rowsFor picks the layout', () => {
    expect(rowsFor('text', ',')).toBe(TEXT_ROWS);
    expect(rowsFor('symbols', ',')).toBe(SYMBOL_ROWS);
    expect(rowsFor('numpad', ',').flat().some((k) => k.kind === 'char' && k.label === ',')).toBe(true);
  });

  // 1024px wide, 16px of padding each side: 11 keys is 87px each, and the
  // glove minimum is 64px. A row that grew past 15 keys would break it.
  it('no row has so many keys that they fall under the 64px tap minimum', () => {
    for (const rows of [TEXT_ROWS, SYMBOL_ROWS, numpadRows(','), numpadRows(null)]) {
      for (const row of rows) {
        const units = row.reduce((sum, k) => sum + (k.flex ?? 1), 0);
        expect((1024 - 32) / units).toBeGreaterThanOrEqual(64);
      }
    }
  });
});
