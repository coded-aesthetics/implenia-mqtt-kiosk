import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import {
  updater,
  parseVersionFromTarName,
  findUsbUpdates,
  verifyChecksum,
  githubApiHeaders,
  githubAssetHeaders,
} from './updater.js';

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

/**
 * The distinction that cost every GitHub update.
 *
 * `/releases/assets/<id>` serves the asset's JSON metadata under the API's
 * Accept and its bytes only under octet-stream, so downloading with the wrong
 * one writes a JSON document into `app-vX.tar.gz` — 200, a body, a plausible
 * size, and a checksum comparison between two blobs of metadata. The failure
 * is invisible without the checksum and impossible to tell from a corrupt
 * download with it.
 */
describe('GitHub request headers', () => {
  it('asks for the bytes when downloading an asset', () => {
    expect(githubAssetHeaders().Accept).toBe('application/octet-stream');
  });

  it('asks for JSON when reading the API', () => {
    expect(githubApiHeaders().Accept).toBe('application/vnd.github.v3+json');
  });

  it('authenticates both, since the repo is private', () => {
    expect(githubApiHeaders('t0ken').Authorization).toBe('token t0ken');
    expect(githubAssetHeaders('t0ken').Authorization).toBe('token t0ken');
  });

  it('omits Authorization entirely without a token', () => {
    expect('Authorization' in githubAssetHeaders()).toBe(false);
    expect('Authorization' in githubApiHeaders(undefined)).toBe(false);
  });

  it('identifies itself, which the GitHub API requires', () => {
    expect(githubAssetHeaders()['User-Agent']).toBe('implenia-kiosk-updater');
  });
});

/**
 * A failed apply has to say so.
 *
 * `update-applying` is emitted before the work starts and used to be a one-way
 * latch — nothing cleared it — so any failure left the header announcing a
 * restart that was never coming, with no way back but a page reload. On a
 * construction site that is the dead end the resilience rules forbid, and
 * until the asset-header fix above it was what *every* GitHub update did.
 */
describe('a failed apply reports itself', () => {
  let tmpDir: string;
  let originalPaths: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-fail-'));
    originalPaths = config.USB_UPDATE_PATHS;
    (config as { USB_UPDATE_PATHS: string }).USB_UPDATE_PATHS = tmpDir;
  });

  afterEach(() => {
    (config as { USB_UPDATE_PATHS: string }).USB_UPDATE_PATHS = originalPaths;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits update-failed with a German reason when the stick is gone', async () => {
    const tarPath = path.join(tmpDir, 'app-v99.0.0.tar.gz');
    fs.writeFileSync(tarPath, 'payload');
    expect(updater.checkUsb()).toBe('99.0.0');

    // The drive is pulled between the offer and the tap — the ordinary way this
    // fails in the field.
    fs.unlinkSync(tarPath);

    const events: string[] = [];
    const onApplying = () => events.push('applying');
    const onFailed = (reason: string) => events.push(`failed:${reason}`);
    updater.on('update-applying', onApplying);
    updater.on('update-failed', onFailed);
    try {
      await updater.downloadAndApply();
    } finally {
      updater.off('update-applying', onApplying);
      updater.off('update-failed', onFailed);
    }

    expect(events[0]).toBe('applying');
    expect(events[1]).toMatch(/^failed:/);
    // German and actionable: whoever tapped is standing at the machine.
    expect(events[1]).toContain('USB-Stick');
  });
});
