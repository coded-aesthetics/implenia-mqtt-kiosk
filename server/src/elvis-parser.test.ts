import { describe, it, expect } from 'vitest';
import { hexToFloat, computeChecksum, parseElvisFrame, type ElvisFrame } from './elvis-parser';

// ── Encoder (mirrors the ESP32 C code) ──────────────────────────────────────

function floatToHex(val: number): string {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, val, false);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

function uint16ToHex(val: number): string {
  return (val & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
}

function buildElvisLine(address: string, values: number[]): string {
  const hexParts = values.map((v) => floatToHex(v));
  const content = `# ${address} ${hexParts.join(' ')} `;
  const checksum = computeChecksum(content);
  return content + uint16ToHex(checksum) + '\r';
}

function allZeroValues(): number[] {
  return new Array(15).fill(0);
}

// ── hexToFloat ──────────────────────────────────────────────────────────────

describe('hexToFloat', () => {
  it('decodes 0.0', () => {
    expect(hexToFloat('00000000')).toBe(0);
  });

  it('decodes 1.0', () => {
    expect(hexToFloat('3F800000')).toBe(1);
  });

  it('decodes -1.0', () => {
    expect(hexToFloat('BF800000')).toBe(-1);
  });

  it('decodes 0.5', () => {
    expect(hexToFloat('3F000000')).toBe(0.5);
  });

  it('decodes 100.0', () => {
    expect(hexToFloat('42C80000')).toBe(100);
  });

  it('decodes a small value (0.001)', () => {
    expect(hexToFloat(floatToHex(0.001))).toBeCloseTo(0.001, 5);
  });

  it('decodes negative values', () => {
    expect(hexToFloat(floatToHex(-42.5))).toBeCloseTo(-42.5, 5);
  });

  it('handles lowercase hex', () => {
    expect(hexToFloat('3f800000')).toBe(1);
  });
});

// ── computeChecksum ─────────────────────────────────────────────────────────

describe('computeChecksum', () => {
  it('computes ASCII byte sum', () => {
    expect(computeChecksum('A')).toBe(65);
    expect(computeChecksum('AB')).toBe(65 + 66);
  });

  it('handles spaces and special chars', () => {
    expect(computeChecksum('# ')).toBe(35 + 32);
  });

  it('wraps at uint16 boundary', () => {
    const long = 'Z'.repeat(1000);
    const raw = 90 * 1000;
    expect(computeChecksum(long)).toBe(raw & 0xFFFF);
  });
});

// ── parseElvisFrame (round-trip) ─────────────────────────────────────────────

describe('parseElvisFrame', () => {
  it('parses an all-zero frame', () => {
    const line = buildElvisLine('#00', allZeroValues());
    const frame = parseElvisFrame(line);
    expect(frame).not.toBeNull();
    expect(frame!.address).toBe('#00');
    expect(frame!.analogInputs).toEqual(new Array(8).fill(0));
    expect(frame!.elvisDepth).toBe(0);
    expect(frame!.elvisPullSpeed).toBe(0);
    expect(frame!.elvisRpm).toBe(0);
    expect(frame!.canDepth).toBe(0);
    expect(frame!.canPullSpeed).toBe(0);
    expect(frame!.canAngle).toBe(0);
    expect(frame!.canRpm).toBe(0);
  });

  it('parses a frame with realistic values', () => {
    const values = [
      12.5, 3.2, 0, 0, 8.1, 0, 0, 0,   // analog inputs
      15.3,                               // elvis depth
      2.5,                                // elvis pull speed
      45.0,                               // elvis rpm
      15.1,                               // can depth
      2.4,                                // can pull speed
      3.7,                                // can angle
      44.0,                               // can rpm
    ];
    const line = buildElvisLine('#10', values);
    const frame = parseElvisFrame(line);

    expect(frame).not.toBeNull();
    expect(frame!.address).toBe('#10');
    expect(frame!.analogInputs[0]).toBeCloseTo(12.5, 5);
    expect(frame!.analogInputs[1]).toBeCloseTo(3.2, 5);
    expect(frame!.analogInputs[4]).toBeCloseTo(8.1, 5);
    expect(frame!.elvisDepth).toBeCloseTo(15.3, 5);
    expect(frame!.elvisPullSpeed).toBeCloseTo(2.5, 5);
    expect(frame!.elvisRpm).toBeCloseTo(45.0, 5);
    expect(frame!.canDepth).toBeCloseTo(15.1, 5);
    expect(frame!.canPullSpeed).toBeCloseTo(2.4, 5);
    expect(frame!.canAngle).toBeCloseTo(3.7, 5);
    expect(frame!.canRpm).toBeCloseTo(44.0, 5);
  });

  it('parses pump address (#10) and machine address (#00)', () => {
    const line1 = buildElvisLine('#00', allZeroValues());
    const line2 = buildElvisLine('#10', allZeroValues());
    expect(parseElvisFrame(line1)!.address).toBe('#00');
    expect(parseElvisFrame(line2)!.address).toBe('#10');
  });

  it('handles negative values', () => {
    const values = allZeroValues();
    values[8] = -5.0;  // negative depth
    const line = buildElvisLine('#00', values);
    const frame = parseElvisFrame(line);
    expect(frame).not.toBeNull();
    expect(frame!.elvisDepth).toBeCloseTo(-5.0, 5);
  });

  it('handles large values', () => {
    const values = allZeroValues();
    values[0] = 9999.99;
    values[10] = 3000.0;
    const line = buildElvisLine('#00', values);
    const frame = parseElvisFrame(line);
    expect(frame!.analogInputs[0]).toBeCloseTo(9999.99, 1);
    expect(frame!.elvisRpm).toBeCloseTo(3000.0, 5);
  });

  it('handles very small values', () => {
    const values = allZeroValues();
    values[9] = 0.001;
    const line = buildElvisLine('#00', values);
    const frame = parseElvisFrame(line);
    expect(frame!.elvisPullSpeed).toBeCloseTo(0.001, 5);
  });
});

// ── parseElvisFrame (rejection) ──────────────────────────────────────────────

describe('parseElvisFrame rejection', () => {
  it('rejects empty string', () => {
    expect(parseElvisFrame('')).toBeNull();
  });

  it('rejects too-short input', () => {
    expect(parseElvisFrame('ABC\r')).toBeNull();
  });

  it('rejects corrupted checksum', () => {
    const line = buildElvisLine('#00', allZeroValues());
    const corrupted = line.slice(0, -5) + 'FFFF\r';
    expect(parseElvisFrame(corrupted)).toBeNull();
  });

  it('rejects corrupted data (flipped byte)', () => {
    const line = buildElvisLine('#00', allZeroValues());
    const chars = [...line];
    chars[5] = chars[5] === 'A' ? 'B' : 'A';
    expect(parseElvisFrame(chars.join(''))).toBeNull();
  });

  it('rejects wrong field count (too few)', () => {
    const content = '# #00 00000000 00000000 ';
    const checksum = computeChecksum(content);
    const line = content + (checksum & 0xFFFF).toString(16).padStart(4, '0').toUpperCase() + '\r';
    expect(parseElvisFrame(line)).toBeNull();
  });

  it('rejects missing # prefix', () => {
    const values = allZeroValues();
    const hexParts = values.map((v) => floatToHex(v));
    const content = `X #00 ${hexParts.join(' ')} `;
    const checksum = computeChecksum(content);
    const line = content + (checksum & 0xFFFF).toString(16).padStart(4, '0').toUpperCase() + '\r';
    expect(parseElvisFrame(line)).toBeNull();
  });

  it('rejects non-hex float values', () => {
    const values = allZeroValues();
    const hexParts = values.map((v) => floatToHex(v));
    hexParts[3] = 'ZZZZZZZZ';
    const content = `# #00 ${hexParts.join(' ')} `;
    const checksum = computeChecksum(content);
    const line = content + (checksum & 0xFFFF).toString(16).padStart(4, '0').toUpperCase() + '\r';
    expect(parseElvisFrame(line)).toBeNull();
  });

  it('rejects non-hex checksum', () => {
    const line = buildElvisLine('#00', allZeroValues());
    const mangled = line.slice(0, -5) + 'ZZZZ\r';
    expect(parseElvisFrame(mangled)).toBeNull();
  });
});

// ── Round-trip fuzz ─────────────────────────────────────────────────────────

describe('round-trip fuzz', () => {
  it('encodes and decodes 50 random frames', () => {
    for (let i = 0; i < 50; i++) {
      const values = Array.from({ length: 15 }, () => (Math.random() - 0.5) * 2000);
      const addr = i % 2 === 0 ? '#00' : '#10';
      const line = buildElvisLine(addr, values);
      const frame = parseElvisFrame(line);

      expect(frame).not.toBeNull();
      expect(frame!.address).toBe(addr);
      for (let j = 0; j < 8; j++) {
        expect(frame!.analogInputs[j]).toBeCloseTo(values[j], 2);
      }
      expect(frame!.elvisDepth).toBeCloseTo(values[8], 2);
      expect(frame!.elvisPullSpeed).toBeCloseTo(values[9], 2);
      expect(frame!.elvisRpm).toBeCloseTo(values[10], 2);
      expect(frame!.canDepth).toBeCloseTo(values[11], 2);
      expect(frame!.canPullSpeed).toBeCloseTo(values[12], 2);
      expect(frame!.canAngle).toBeCloseTo(values[13], 2);
      expect(frame!.canRpm).toBeCloseTo(values[14], 2);
    }
  });
});
