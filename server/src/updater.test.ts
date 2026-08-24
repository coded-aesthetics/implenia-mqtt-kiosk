import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseVersionFromTarName, findUsbUpdates, verifyChecksum } from './updater.js';

describe('parseVersionFromTarName', () => {
  it('extracts version from standard release filename', () => {
    expect(parseVersionFromTarName('app-v1.2.3.tar.gz')).toBe('1.2.3');
  });

  it('extracts version with prerelease tag', () => {
    expect(parseVersionFromTarName('app-v0.5.0-beta.1.tar.gz')).toBe('0.5.0-beta.1');
  });

  it('returns null for non-matching filenames', () => {
    expect(parseVersionFromTarName('README.md')).toBeNull();
    expect(parseVersionFromTarName('app-1.2.3.tar.gz')).toBeNull();
    expect(parseVersionFromTarName('app-v1.2.tar.gz')).toBeNull();
    expect(parseVersionFromTarName('random.tar.gz')).toBeNull();
  });
});

describe('findUsbUpdates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds tar.gz at direct path', () => {
    fs.writeFileSync(path.join(tmpDir, 'app-v2.0.0.tar.gz'), 'fake');
    const results = findUsbUpdates([tmpDir]);
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe('2.0.0');
    expect(results[0].source).toBe('usb');
    expect(results[0].checksumPath).toBeUndefined();
  });

  it('finds tar.gz with accompanying checksum', () => {
    fs.writeFileSync(path.join(tmpDir, 'app-v1.0.0.tar.gz'), 'fake');
    fs.writeFileSync(path.join(tmpDir, 'checksum.sha256'), 'abc123  app-v1.0.0.tar.gz');
    const results = findUsbUpdates([tmpDir]);
    expect(results).toHaveLength(1);
    expect(results[0].checksumPath).toBe(path.join(tmpDir, 'checksum.sha256'));
  });

  it('finds tar.gz nested under /media/user/USBSTICK/', () => {
    const mountDir = path.join(tmpDir, 'user', 'USBSTICK');
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(path.join(mountDir, 'app-v3.1.0.tar.gz'), 'fake');
    const results = findUsbUpdates([tmpDir]);
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe('3.1.0');
  });

  it('returns empty for nonexistent path', () => {
    expect(findUsbUpdates(['/nonexistent/path/xyz'])).toHaveLength(0);
  });

  it('finds multiple versions and returns all', () => {
    fs.writeFileSync(path.join(tmpDir, 'app-v1.0.0.tar.gz'), 'fake');
    fs.writeFileSync(path.join(tmpDir, 'app-v2.0.0.tar.gz'), 'fake');
    const results = findUsbUpdates([tmpDir]);
    expect(results).toHaveLength(2);
    const versions = results.map((r) => r.version).sort();
    expect(versions).toEqual(['1.0.0', '2.0.0']);
  });
});

describe('verifyChecksum', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-checksum-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true for matching checksum', () => {
    const content = Buffer.from('test archive content');
    const tarPath = path.join(tmpDir, 'app-v1.0.0.tar.gz');
    fs.writeFileSync(tarPath, content);

    const hash = createHash('sha256').update(content).digest('hex');
    const checksumPath = path.join(tmpDir, 'checksum.sha256');
    fs.writeFileSync(checksumPath, `${hash}  app-v1.0.0.tar.gz\n`);

    expect(verifyChecksum(tarPath, checksumPath)).toBe(true);
  });

  it('returns false for mismatched checksum', () => {
    const tarPath = path.join(tmpDir, 'app-v1.0.0.tar.gz');
    fs.writeFileSync(tarPath, 'actual content');

    const checksumPath = path.join(tmpDir, 'checksum.sha256');
    fs.writeFileSync(checksumPath, 'deadbeef00000000000000000000000000000000000000000000000000000000  app-v1.0.0.tar.gz\n');

    expect(verifyChecksum(tarPath, checksumPath)).toBe(false);
  });
});
