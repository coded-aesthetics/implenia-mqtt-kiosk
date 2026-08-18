export interface ElvisFrame {
  address: string;
  analogInputs: number[];
  elvisDepth: number;
  elvisPullSpeed: number;
  elvisRpm: number;
  canDepth: number;
  canPullSpeed: number;
  canAngle: number;
  canRpm: number;
}

const EXPECTED_FIELD_COUNT = 15;
const HEX_FLOAT_PATTERN = /^[0-9A-Fa-f]{8}$/;

export function hexToFloat(hex: string): number {
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return new DataView(bytes.buffer).getFloat32(0, false);
}

export function computeChecksum(content: string): number {
  let sum = 0;
  for (let i = 0; i < content.length; i++) {
    sum += content.charCodeAt(i);
  }
  return sum & 0xFFFF;
}

export function parseElvisFrame(line: string): ElvisFrame | null {
  const stripped = line.replace(/\r$/, '');
  if (stripped.length < 5) return null;

  const checksumHex = stripped.slice(-4);
  if (!(/^[0-9A-Fa-f]{4}$/.test(checksumHex))) return null;

  const content = stripped.slice(0, -4);

  const expected = parseInt(checksumHex, 16);
  const actual = computeChecksum(content);
  if (expected !== actual) return null;

  const parts = content.trim().split(/\s+/);
  if (parts.length !== EXPECTED_FIELD_COUNT + 2) return null;
  if (parts[0] !== '#') return null;

  const address = parts[1];
  const hexValues = parts.slice(2);

  for (const hex of hexValues) {
    if (!HEX_FLOAT_PATTERN.test(hex)) return null;
  }

  const floats = hexValues.map(hexToFloat);

  return {
    address,
    analogInputs: floats.slice(0, 8),
    elvisDepth: floats[8],
    elvisPullSpeed: floats[9],
    elvisRpm: floats[10],
    canDepth: floats[11],
    canPullSpeed: floats[12],
    canAngle: floats[13],
    canRpm: floats[14],
  };
}
