/**
 * Format a numeric value for display in the UI.
 * Uses German locale (comma as decimal separator) and rounds to 2 decimal places by default.
 *
 * @param value - The value to format (number or string that can be parsed as number)
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string or '–' if the value is invalid
 *
 * @example
 * formatNumber(1234.5678) // "1.234,57"
 * formatNumber("42.1") // "42,10"
 * formatNumber(NaN) // "–"
 * formatNumber(1234.5678, 3) // "1.234,568"
 */
export function formatNumber(value: number | string, decimals = 2): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;

  if (!Number.isFinite(num)) {
    return '–';
  }

  return num.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Check if a value should be considered "no value" and displayed as '–'.
 */
export function isNoValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' || s === 'NaN' || s === '-Infinity' || s === 'Infinity' || s === 'null';
  }
  if (typeof v === 'number') return !Number.isFinite(v);
  return false;
}
