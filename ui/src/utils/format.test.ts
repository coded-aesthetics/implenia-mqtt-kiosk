import { describe, it, expect } from 'vitest';
import { formatNumber, isNoValue } from './format';

describe('formatNumber', () => {
  it('formats numbers with 2 decimal places by default', () => {
    expect(formatNumber(1234.5678)).toBe('1.234,57');
    expect(formatNumber(42)).toBe('42,00');
    expect(formatNumber(0.123)).toBe('0,12');
  });

  it('formats string numbers', () => {
    expect(formatNumber('1234.5678')).toBe('1.234,57');
    expect(formatNumber('42')).toBe('42,00');
  });

  it('respects custom decimal places', () => {
    expect(formatNumber(1234.5678, 3)).toBe('1.234,568');
    expect(formatNumber(42, 0)).toBe('42');
    expect(formatNumber(1.2345, 1)).toBe('1,2');
  });

  it('returns – for invalid values', () => {
    expect(formatNumber(NaN)).toBe('–');
    expect(formatNumber(Infinity)).toBe('–');
    expect(formatNumber(-Infinity)).toBe('–');
    expect(formatNumber('invalid')).toBe('–');
  });

  it('handles negative numbers', () => {
    expect(formatNumber(-1234.56)).toBe('-1.234,56');
    expect(formatNumber('-42.1')).toBe('-42,10');
  });

  it('handles zero', () => {
    expect(formatNumber(0)).toBe('0,00');
    expect(formatNumber('0')).toBe('0,00');
  });

  it('uses comma as decimal separator (German format)', () => {
    expect(formatNumber(1.5)).toContain(',');
    expect(formatNumber(1.5)).not.toContain('.');
  });

  it('uses period as thousands separator (German format)', () => {
    expect(formatNumber(1234.5)).toContain('1.234');
  });
});

describe('isNoValue', () => {
  it('returns true for null and undefined', () => {
    expect(isNoValue(null)).toBe(true);
    expect(isNoValue(undefined)).toBe(true);
  });

  it('returns true for invalid number strings', () => {
    expect(isNoValue('NaN')).toBe(true);
    expect(isNoValue('Infinity')).toBe(true);
    expect(isNoValue('-Infinity')).toBe(true);
    expect(isNoValue('null')).toBe(true);
    expect(isNoValue('')).toBe(true);
    expect(isNoValue('   ')).toBe(true);
  });

  it('returns true for invalid numbers', () => {
    expect(isNoValue(NaN)).toBe(true);
    expect(isNoValue(Infinity)).toBe(true);
    expect(isNoValue(-Infinity)).toBe(true);
  });

  it('returns false for valid values', () => {
    expect(isNoValue(0)).toBe(false);
    expect(isNoValue(42)).toBe(false);
    expect(isNoValue(-42)).toBe(false);
    expect(isNoValue('42')).toBe(false);
    expect(isNoValue('text')).toBe(false);
  });
});
