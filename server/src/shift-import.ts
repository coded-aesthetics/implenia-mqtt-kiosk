export interface ValidShiftImport {
  measuring_devices: { id: string; name: string }[];
  [key: string]: unknown;
}

export type ValidationResult = {
  valid: true;
  data: ValidShiftImport;
} | {
  valid: false;
  error: string;
}

export function validateShiftImport(input: unknown): ValidationResult {
  if (input == null || typeof input !== 'object') {
    return { valid: false, error: 'Ungültiger Schichtauftrag: Die Datei enthält kein gültiges JSON-Objekt.' };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.measuring_devices)) {
    return { valid: false, error: 'Ungültiger Schichtauftrag: Das Feld "measuring_devices" fehlt oder ist kein Array. Bitte eine vom Implenia-Portal exportierte Datei verwenden.' };
  }
  return { valid: true, data: obj as ValidShiftImport };
}

export function resolveShiftAssignment(
  importedJson: string | undefined,
): { data: Record<string, unknown>; source: 'import' } | null {
  if (!importedJson) return null;
  try {
    const data = JSON.parse(importedJson);
    return { data, source: 'import' };
  } catch {
    return null;
  }
}
