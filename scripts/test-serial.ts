#!/usr/bin/env tsx
/**
 * Elvis Serial Port Diagnostic Tool
 *
 * Tests serial connection and shows raw data + parsed frames
 * Usage: tsx scripts/test-serial.ts [port] [baud]
 */

import { SerialPort } from 'serialport';
import { ReadlineParser } from 'serialport';
import { parseElvisFrame } from '../server/src/elvis-parser.js';

const port = process.argv[2] || '/dev/ttyUSB0';
const baud = parseInt(process.argv[3] || '9600', 10);

console.log(`🔌 Connecting to ${port} at ${baud} baud...`);
console.log(`   Press Ctrl+C to exit\n`);

const serial = new SerialPort({ path: port, baudRate: baud });
const parser = serial.pipe(new ReadlineParser({ delimiter: '\r' }));

let frameCount = 0;
let errorCount = 0;
let byteCount = 0;

serial.on('open', () => {
  console.log('✅ Port opened successfully');
  console.log('   Waiting for data...\n');
});

serial.on('error', (err) => {
  console.error('❌ Serial error:', err.message);
  process.exit(1);
});

serial.on('data', (buf: Buffer) => {
  byteCount += buf.length;
  const timestamp = new Date().toLocaleTimeString('de-DE');

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[${timestamp}] Raw data chunk (${buf.length} bytes, total: ${byteCount}):`);
  console.log(`  ASCII: "${buf.toString('utf8')}"`);
  console.log(`  HEX:   ${buf.toString('hex').match(/.{1,2}/g)?.join(' ') || ''}`);

  // Show special characters
  const chars = buf.toString('utf8').split('').map((c, i) => {
    const code = c.charCodeAt(0);
    if (code === 13) return '\\r';
    if (code === 10) return '\\n';
    if (code === 9) return '\\t';
    if (code < 32 || code > 126) return `[0x${code.toString(16).padStart(2, '0')}]`;
    return c;
  }).join('');
  console.log(`  CHARS: ${chars}`);
});

parser.on('data', (line: string) => {
  const timestamp = new Date().toLocaleTimeString('de-DE');
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[${timestamp}] Raw data received (${line.length} chars):`);
  console.log(`  ASCII: "${line}"`);

  // Show hex dump for non-printable chars
  const hex = Buffer.from(line).toString('hex').match(/.{1,2}/g)?.join(' ') || '';
  console.log(`  HEX:   ${hex}`);

  // Show character-by-character breakdown for first 100 chars
  if (line.length > 0 && line.length <= 100) {
    const charBreakdown = line.split('').map((c, i) => {
      const code = c.charCodeAt(0);
      if (code < 32 || code > 126) {
        return `[0x${code.toString(16).padStart(2, '0')}]`;
      }
      return c;
    }).join('');
    console.log(`  CHARS: ${charBreakdown}`);
  }

  const parsed = parseElvisFrame(line + '\r');
  if (parsed) {
    frameCount++;
    console.log(`  ✅ Parsed frame #${frameCount}:`);
    console.log(`     Address: ${parsed.address}`);
    console.log(`     Values: [${parsed.values.map(v => v.toFixed(2)).join(', ')}]`);
  } else {
    errorCount++;
    console.log(`  ❌ Parse failed (error #${errorCount})`);
    console.log(`     Expected format: # <addr> <15 hex floats> <checksum>`);
  }
});

process.on('SIGINT', () => {
  console.log(`\n\n📈 Session summary:`);
  console.log(`   Total bytes: ${byteCount}`);
  console.log(`   Valid frames: ${frameCount}`);
  console.log(`   Parse errors: ${errorCount}`);
  console.log(`   Success rate: ${frameCount + errorCount > 0 ? ((frameCount / (frameCount + errorCount)) * 100).toFixed(1) : 0}%`);
  serial.close();
  process.exit(0);
});
