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
    return { valid: false, error: 'Invalid shift assignment: not a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.measuring_devices)) {
    return { valid: false, error: 'Invalid shift assignment: missing measuring_devices array' };
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
