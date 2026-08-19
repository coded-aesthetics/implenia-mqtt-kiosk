import { describe, it, expect } from 'vitest';
import { validateShiftImport, resolveShiftAssignment } from './shift-import.js';

// ── validateShiftImport ─────────────────────────────────────────────────────

describe('validateShiftImport', () => {
  const validPayload = {
    personnel_id: 'p1',
    day_of_execution: '2026-08-19',
    machine: { id: 'm1', inventory_id: 'INV-001', serial_no: 'SN-001', machine_type_id: 'dsv' },
    personnel: { id: 'p1', first_name: 'Max', last_name: 'Mustermann' },
    measuring_devices: [
      { id: 'md1', name: 'Säule 42', description: 'Test', vorgaben: { float_sensors: { 'Druck': 200 } } },
    ],
  };

  it('accepts a valid shift assignment', () => {
    const result = validateShiftImport(validPayload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.measuring_devices).toHaveLength(1);
      expect(result.data.measuring_devices[0].name).toBe('Säule 42');
    }
  });

  it('accepts an empty measuring_devices array', () => {
    const result = validateShiftImport({ measuring_devices: [] });
    expect(result.valid).toBe(true);
  });

  it('rejects null', () => {
    const result = validateShiftImport(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('not a JSON object');
  });

  it('rejects undefined', () => {
    const result = validateShiftImport(undefined);
    expect(result.valid).toBe(false);
  });

  it('rejects a string', () => {
    const result = validateShiftImport('not an object');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('not a JSON object');
  });

  it('rejects an object without measuring_devices', () => {
    const result = validateShiftImport({ personnel_id: 'p1' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('missing measuring_devices');
  });

  it('rejects when measuring_devices is not an array', () => {
    const result = validateShiftImport({ measuring_devices: 'not-an-array' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('missing measuring_devices');
  });
});

// ── resolveShiftAssignment ──────────────────────────────────────────────────

describe('resolveShiftAssignment', () => {
  it('returns null when no import exists', () => {
    expect(resolveShiftAssignment(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveShiftAssignment('')).toBeNull();
  });

  it('returns parsed data with source "import" for valid JSON', () => {
    const stored = JSON.stringify({ measuring_devices: [{ id: 'md1', name: 'S1' }] });
    const result = resolveShiftAssignment(stored);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('import');
    expect(result!.data.measuring_devices).toHaveLength(1);
  });

  it('returns null for corrupted JSON', () => {
    expect(resolveShiftAssignment('{invalid json')).toBeNull();
  });

  it('preserves all fields from the stored JSON', () => {
    const original = { day_of_execution: '2026-08-19', measuring_devices: [], extra: 'field' };
    const result = resolveShiftAssignment(JSON.stringify(original));
    expect(result!.data.day_of_execution).toBe('2026-08-19');
    expect(result!.data.extra).toBe('field');
  });
});
