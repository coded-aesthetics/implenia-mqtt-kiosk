import { describe, it, expect } from 'vitest';
import { parsePayload } from './parse-payload.js';

describe('parsePayload', () => {
  it('reads a number', () => {
    expect(parsePayload('12.5')).toEqual({ valueNumeric: 12.5, valueText: null });
    expect(parsePayload(' -3 ')).toEqual({ valueNumeric: -3, valueText: null });
  });

  it('reads text', () => {
    expect(parsePayload('Kies')).toEqual({ valueNumeric: null, valueText: 'Kies' });
  });

  it('treats an empty payload as no value', () => {
    expect(parsePayload('')).toEqual({ valueNumeric: null, valueText: null });
    expect(parsePayload('   ')).toEqual({ valueNumeric: null, valueText: null });
    expect(parsePayload('""')).toEqual({ valueNumeric: null, valueText: null });
  });

  // The marker depends on who formatted the float: JS writes NaN/Infinity, Go
  // +Inf/-Inf, C and the ESP32 toolchain lowercase nan/inf. A spelling that
  // slips through is stored as the *text* "nan" and later fails the whole
  // batch upload of a float sensor with a 422.
  it.each([
    'NaN', 'nan', 'NAN', 'NaN ', '-nan', '+nan',
    'Infinity', 'infinity', '-Infinity', '+Infinity',
    'inf', 'Inf', '+Inf', '-Inf', 'INF',
    'null',
  ])('treats %s as no value, not as text', (payload) => {
    expect(parsePayload(payload)).toEqual({ valueNumeric: null, valueText: null });
  });

  it('still reads text that merely starts with a non-finite marker', () => {
    // "Infiltration" must not be swallowed by the Infinity check.
    expect(parsePayload('Infiltration')).toEqual({
      valueNumeric: null, valueText: 'Infiltration',
    });
    expect(parsePayload('nano')).toEqual({ valueNumeric: null, valueText: 'nano' });
  });
});
