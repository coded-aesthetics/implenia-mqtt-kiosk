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

/**
 * Group an AnyDesk id in threes, the way AnyDesk itself writes it.
 *
 * Grouped from the right, so a 9-digit and a 10-digit id both read naturally
 * ("123 456 789", "1 234 567 890"). It is read out over the phone, which is
 * the whole reason it is grouped at all.
 */
export function formatAnydeskId(id: string): string {
  const digits = id.replace(/\D/g, '');
  if (digits.length === 0) return '';
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups.join(' ');
}
