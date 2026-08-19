#!/usr/bin/env npx tsx
/**
 * Elvis Serial Simulator
 *
 * Generates Elvis (ELWS) serial frames and writes them to stdout,
 * simulating two devices: a drilling rig and a pump.
 *
 * Each device sends 15 float values per frame. Values drift
 * realistically to simulate a drilling cycle.
 *
 * Usage:
 *   npx tsx scripts/simulate-elvis.ts [options]
 *
 * Options:
 *   --interval   Frame interval per device in ms (default: 500)
 *   --drill-addr Address for drilling rig (default: #00)
 *   --pump-addr  Address for pump (default: #10)
 *
 * Pipe through socat for a virtual serial port:
 *   socat PTY,link=/dev/ttyVirtual,raw,echo=0 EXEC:'npx tsx scripts/simulate-elvis.ts'
 */

// ── Encoder (mirrors the ESP32 C code) ──────────────────────────────────────

function floatToHex(val: number): string {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, val, false);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

function computeChecksum(content: string): number {
  let sum = 0;
  for (let i = 0; i < content.length; i++) {
    sum += content.charCodeAt(i);
  }
  return sum & 0xFFFF;
}

function buildFrame(address: string, values: number[]): string {
  const hexParts = values.map((v) => floatToHex(v));
  const content = `# ${address} ${hexParts.join(' ')} `;
  const checksum = computeChecksum(content);
  return content + (checksum & 0xFFFF).toString(16).padStart(4, '0').toUpperCase() + '\r';
}

// ── Value simulation ────────────────────────────────────────────────────────

function drift(current: number, min: number, max: number, maxStep: number): number {
  const step = (Math.random() * 2 - 1) * maxStep;
  return Math.max(min, Math.min(max, current + step));
}

interface DeviceState {
  address: string;
  label: string;
  values: number[];
}

function createDrillState(address: string): DeviceState {
  return {
    address,
    label: 'Drill',
    values: [
      0, 0, 0, 0, 0, 0, 0, 0,  // analog inputs — start idle
      0,    // [8]  depth-ish
      0,    // [9]  speed-ish
      0,    // [10] rpm-ish
      0,    // [11]
      0,    // [12]
      0,    // [13] angle-ish
      0,    // [14]
    ],
  };
}

function createPumpState(address: string): DeviceState {
  return {
    address,
    label: 'Pump',
    values: [
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0,
    ],
  };
}

function tickDrill(state: DeviceState): void {
  const v = state.values;
  // Simulate various channels drifting within plausible ranges
  for (let i = 0; i < 8; i++) {
    v[i] = drift(v[i], 0, 50, 1.5);
  }
  v[8]  = drift(v[8],  0, 40, 0.3);    // slowly increasing depth
  v[9]  = drift(v[9],  0, 15, 0.5);    // speed
  v[10] = drift(v[10], 0, 200, 5);     // rpm
  v[11] = drift(v[11], 0, 40, 0.3);
  v[12] = drift(v[12], 0, 15, 0.5);
  v[13] = drift(v[13], -5, 5, 0.2);    // angle near zero
  v[14] = drift(v[14], 0, 200, 5);
}

function tickPump(state: DeviceState): void {
  const v = state.values;
  for (let i = 0; i < 8; i++) {
    v[i] = drift(v[i], 0, 400, 10);    // pressures
  }
  v[8]  = drift(v[8],  0, 500, 15);    // flow
  v[9]  = drift(v[9],  0, 500, 15);
  v[10] = drift(v[10], 0, 100, 3);
  v[11] = drift(v[11], 0, 400, 10);
  v[12] = drift(v[12], 0, 500, 15);
  v[13] = drift(v[13], 0, 100, 3);
  v[14] = drift(v[14], 0, 10000, 200); // cumulative volume
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const intervalMs = parseInt(getArg('interval', '500'), 10);
const drillAddr = getArg('drill-addr', '#00');
const pumpAddr = getArg('pump-addr', '#10');

const drill = createDrillState(drillAddr);
const pump = createPumpState(pumpAddr);

const isTerminal = process.stdout.isTTY;

if (isTerminal) {
  console.error(`Elvis simulator — drill=${drillAddr} pump=${pumpAddr} interval=${intervalMs}ms`);
  console.error('Frames are written to stdout. Pipe to socat or redirect to test.\n');
}

let cycle = 0;

function tick(): void {
  tickDrill(drill);
  tickPump(pump);

  const drillFrame = buildFrame(drill.address, drill.values);
  const pumpFrame = buildFrame(pump.address, pump.values);

  process.stdout.write(drillFrame);
  process.stdout.write(pumpFrame);

  if (isTerminal && cycle % 10 === 0) {
    console.error(
      `[${cycle}] drill[8]=${drill.values[8].toFixed(1)}  pump[8]=${pump.values[8].toFixed(1)}`
    );
  }
  cycle++;
}

const timer = setInterval(tick, intervalMs);

process.on('SIGINT', () => {
  clearInterval(timer);
  if (isTerminal) console.error('\nStopped.');
  process.exit(0);
});
