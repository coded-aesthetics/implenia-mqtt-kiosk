#!/usr/bin/env npx tsx
/**
 * MQTT Sensor Simulator
 *
 * Reads a -herstellen.csv file and continuously publishes random sensor
 * values via MQTT, matching the type and unit of each sensor.
 *
 * Usage:
 *   npx tsx scripts/simulate-sensors.ts <path-to-csv> [options]
 *
 * Options:
 *   --broker  MQTT broker URL     (default: mqtt://127.0.0.1:1883)
 *   --prefix  MQTT topic prefix   (default: sensors)
 *   --interval  Publish interval in ms (default: 1000)
 *
 * Examples:
 *   npx tsx scripts/simulate-sensors.ts /path/to/dsv-sensors-herstellen.csv
 *   npx tsx scripts/simulate-sensors.ts /path/to/ankerbohren-sensors-herstellen.csv --interval 500
 */

import fs from 'node:fs';
import mqtt from 'mqtt';

// --- CLI argument parsing ---

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--'));

if (!csvPath) {
  console.error('Usage: npx tsx scripts/simulate-sensors.ts <path-to-csv> [--broker url] [--prefix topic] [--interval ms]');
  process.exit(1);
}

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const brokerUrl = getArg('broker', 'mqtt://127.0.0.1:1883');
const topicPrefix = getArg('prefix', 'sensors');
const intervalMs = parseInt(getArg('interval', '1000'), 10);

// --- CSV parsing ---

interface Sensor {
  name: string;
  type: 'Double' | 'Integer' | 'Text';
  unit: string;
}

function parseCsv(filePath: string): Sensor[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  // Skip header
  return lines.slice(1)
    .map((line) => {
      const [name, type, unit] = line.split(',').map((s) => s.trim());
      if (!name || !type) return null;
      return {
        name,
        type: type as Sensor['type'],
        unit: unit || '',
      };
    })
    .filter((s): s is Sensor => s !== null);
}

// --- Value generation based on unit/type ---

interface ValueRange {
  min: number;
  max: number;
  decimals: number;
}

const UNIT_RANGES: Record<string, ValueRange> = {
  'm':       { min: 0, max: 50, decimals: 2 },
  'bar':     { min: 0, max: 400, decimals: 1 },
  'kN':      { min: 0, max: 500, decimals: 1 },
  'Nm':      { min: 0, max: 100, decimals: 1 },
  '1/min':   { min: 0, max: 200, decimals: 1 },
  'l/min':   { min: 0, max: 500, decimals: 1 },
  'l':       { min: 0, max: 10000, decimals: 0 },
  'cm/min':  { min: 0, max: 100, decimals: 1 },
  '°':       { min: 0, max: 360, decimals: 2 },
  'Nm³/h':   { min: 0, max: 100, decimals: 1 },
};

const DEFAULT_DOUBLE_RANGE: ValueRange = { min: 0, max: 100, decimals: 2 };

// Keep running state per sensor so values drift realistically
const sensorState = new Map<string, number>();

function generateValue(sensor: Sensor): string {
  if (sensor.type === 'Text') {
    const texts: Record<string, string[]> = {
      'Ausführungsdatum': [new Date().toISOString().split('T')[0]],
      'Kommentar': ['Normal', 'Störung', 'Wartung', 'OK'],
      'Geologie': ['Kies', 'Sand', 'Ton', 'Fels', 'Schluff'],
      'Bohrdauer': ['00:15:30', '00:22:45', '00:08:12', '00:45:00'],
      'Düsdauer': ['00:10:00', '00:18:30', '00:25:15'],
      'Precut-Dauer': ['00:05:00', '00:12:30', '00:08:45'],
    };
    const options = texts[sensor.name] || ['---'];
    return options[Math.floor(Math.random() * options.length)];
  }

  // ~5% chance of a "no value" reading
  if (Math.random() < 0.05) {
    const nullVariants = ['null', 'NaN', '-Infinity', 'Infinity', '""', 'missing'];
    return nullVariants[Math.floor(Math.random() * nullVariants.length)];
  }

  const range = UNIT_RANGES[sensor.unit] || DEFAULT_DOUBLE_RANGE;
  const prev = sensorState.get(sensor.name);

  let value: number;
  if (prev !== undefined) {
    // Drift from previous value by up to 5% of range
    const drift = (range.max - range.min) * 0.05 * (Math.random() * 2 - 1);
    value = Math.max(range.min, Math.min(range.max, prev + drift));
  } else {
    // Initial value: random within range
    value = range.min + Math.random() * (range.max - range.min);
  }

  if (sensor.type === 'Integer') {
    value = Math.round(value);
  } else {
    value = parseFloat(value.toFixed(range.decimals));
  }

  sensorState.set(sensor.name, value);
  return String(value);
}

// --- Main ---

const sensors = parseCsv(csvPath);

if (sensors.length === 0) {
  console.error('No sensors found in CSV file.');
  process.exit(1);
}

console.log(`Loaded ${sensors.length} sensors from ${csvPath}`);
console.log(`Connecting to ${brokerUrl}...`);

const client = mqtt.connect(brokerUrl, {
  reconnectPeriod: 5000,
});

client.on('connect', () => {
  console.log(`Connected. Publishing every ${intervalMs}ms to ${topicPrefix}/...\n`);

  const header = 'Sensor'.padEnd(40) + 'Value'.padStart(12) + '  ' + 'Unit';
  console.log(header);
  console.log('-'.repeat(header.length));

  let cycle = 0;

  setInterval(() => {
    if (cycle > 0) {
      // Print separator between cycles
      console.log('');
    }
    cycle++;

    for (const sensor of sensors) {
      const raw = generateValue(sensor);
      const topic = `${topicPrefix}/${sensor.name}`;

      // Build payload based on the generated value
      let payload: string;
      let displayValue: string;

      switch (raw) {
        case 'null':
          payload = JSON.stringify({ value: null, unit: sensor.unit });
          displayValue = 'null';
          break;
        case 'NaN':
          payload = JSON.stringify({ value: 'NaN', unit: sensor.unit });
          displayValue = 'NaN';
          break;
        case '-Infinity':
          payload = JSON.stringify({ value: '-Infinity', unit: sensor.unit });
          displayValue = '-Infinity';
          break;
        case 'Infinity':
          payload = JSON.stringify({ value: 'Infinity', unit: sensor.unit });
          displayValue = 'Infinity';
          break;
        case '""':
          payload = JSON.stringify({ value: '', unit: sensor.unit });
          displayValue = '""';
          break;
        case 'missing':
          payload = JSON.stringify({ unit: sensor.unit });
          displayValue = '(missing)';
          break;
        default:
          if (sensor.type === 'Text') {
            payload = JSON.stringify({ value: raw, unit: sensor.unit });
          } else {
            payload = JSON.stringify({ value: parseFloat(raw), unit: sensor.unit });
          }
          displayValue = sensor.unit ? `${raw} ${sensor.unit}` : raw;
      }

      client.publish(topic, payload);
      console.log(`  ${sensor.name.padEnd(40)}${displayValue.padStart(16)}`);
    }
  }, intervalMs);
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

process.on('SIGINT', () => {
  console.log('\nStopping simulator...');
  client.end();
  process.exit(0);
});
