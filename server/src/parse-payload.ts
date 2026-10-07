/**
 * Parse a raw MQTT payload string into numeric and text values.
 *
 * MQTT payloads are raw values (e.g. "12.5", "Kies", "", "NaN") — NOT JSON.
 * Unit information comes from the Implenia API sensor definitions, not from the payload.
 */
const NON_FINITE = new Set([
  'nan', '-nan', '+nan',
  'inf', '-inf', '+inf',
  'infinity', '-infinity', '+infinity',
  'null',
]);

export function parsePayload(payload: string): { valueNumeric: number | null; valueText: string | null } {
  const trimmed = payload.trim();

  // Empty or missing
  if (trimmed === '' || trimmed === '""') {
    return { valueNumeric: null, valueText: null };
  }

  // Explicit non-finite values → null numeric.
  //
  // Matched case-insensitively and across spellings because the marker depends
  // on who formatted it: JS writes `NaN`/`Infinity`, Go `NaN`/`+Inf`/`-Inf`, C
  // and the ESP32 toolchain `nan`/`inf`. A spelling that slips through here is
  // not stored as "no value" but as the *text* "nan", which later fails a float
  // sensor's upload with a 422 and takes the whole batch down with it.
  if (NON_FINITE.has(trimmed.toLowerCase())) {
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
