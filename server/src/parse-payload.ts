/**
 * Parse a raw MQTT payload string into numeric and text values.
 *
 * MQTT payloads are raw values (e.g. "12.5", "Kies", "", "NaN") — NOT JSON.
 * Unit information comes from the Implenia API sensor definitions, not from the payload.
 */
export function parsePayload(payload: string): { valueNumeric: number | null; valueText: string | null } {
  const trimmed = payload.trim();

  // Empty or missing
  if (trimmed === '' || trimmed === '""') {
    return { valueNumeric: null, valueText: null };
  }

  // Explicit non-finite values → null numeric
  if (trimmed === 'NaN' || trimmed === 'Infinity' || trimmed === '-Infinity' || trimmed === 'null') {
    return { valueNumeric: null, valueText: null };
  }

  // Try numeric
  const num = parseFloat(trimmed);
  if (Number.isFinite(num)) {
    return { valueNumeric: num, valueText: null };
  }

  // Text value
  return { valueNumeric: null, valueText: trimmed };
}
