import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import semver from 'semver';
import { config } from './config.js';
import { connectivity } from './connectivity.js';
import { createLogger } from './logger.js';

const log = createLogger('updater');

export type UpdateSource = 'github' | 'usb';

interface UpdateInfo {
  version: string;
  source: UpdateSource;
  tarPath?: string;
  checksumPath?: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

const TAR_PATTERN = /^app-v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)\.tar\.gz$/;

export function parseVersionFromTarName(filename: string): string | null {
  const match = TAR_PATTERN.exec(filename);
  return match ? match[1] : null;
}

export function findUsbUpdates(searchPaths: string[]): UpdateInfo[] {
  const results: UpdateInfo[] = [];

  for (const basePath of searchPaths) {
    if (!fs.existsSync(basePath)) continue;

    let scanDirs: string[];
    try {
      // Scan one level deep for mount points (e.g. /media/user/USBSTICK/)
      const entries = fs.readdirSync(basePath, { withFileTypes: true });
      const subDirs = entries
        .filter((e) => e.isDirectory())
        .flatMap((userDir) => {
          const userPath = path.join(basePath, userDir.name);
          try {
            return fs
              .readdirSync(userPath, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((mount) => path.join(userPath, mount.name));
          } catch {
            return [];
          }
        });
      // Also check the base path itself and its direct children
      scanDirs = [basePath, ...entries.filter((e) => e.isDirectory()).map((e) => path.join(basePath, e.name)), ...subDirs];
    } catch {
      continue;
    }

    for (const dir of scanDirs) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const version = parseVersionFromTarName(file);
          if (!version) continue;

          const tarPath = path.join(dir, file);
          const checksumPath = path.join(dir, 'checksum.sha256');
          const hasChecksum = fs.existsSync(checksumPath);

          results.push({
            version,
            source: 'usb',
            tarPath,
            checksumPath: hasChecksum ? checksumPath : undefined,
          });
        }
      } catch {
        continue;
      }
    }
  }

  return results;
}

export function verifyChecksum(tarPath: string, checksumPath: string): boolean {
  const checksumContent = fs.readFileSync(checksumPath, 'utf-8');
  const expectedHash = checksumContent.trim().split(/\s+/)[0];
  const fileBuffer = fs.readFileSync(tarPath);
  const actualHash = createHash('sha256').update(fileBuffer).digest('hex');
  return actualHash === expectedHash;
}

class UpdateManager extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentVersion: string;
  private _pendingUpdate: UpdateInfo | null = null;

  constructor() {
    super();
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    this.currentVersion = pkg.version;
    log.info('Current version: %s', this.currentVersion);
  }

  get updateAvailable(): string | null {
    return this._pendingUpdate?.version ?? null;
  }

  get updateSource(): UpdateSource | null {
    return this._pendingUpdate?.source ?? null;
  }

  private get apiHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'implenia-kiosk-updater',
    };
    if (config.GITHUB_TOKEN) {
      h['Authorization'] = `token ${config.GITHUB_TOKEN}`;
    }
    return h;
  }

  private setUpdate(info: UpdateInfo): void {
    // Only upgrade — never replace a pending update with an older version
    if (this._pendingUpdate && !semver.gt(info.version, this._pendingUpdate.version)) return;

    this._pendingUpdate = info;
    this.emit('update-available', info.version, info.source);
  }

  async checkGitHub(): Promise<string | null> {
    if (!connectivity.isOnline()) return null;

    try {
      const url = `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/latest`;
      const res = await fetch(url, { headers: this.apiHeaders });

      if (!res.ok) {
        log.error('GitHub API responded %d', res.status);
        return null;
      }

      const release: GitHubRelease = await res.json() as GitHubRelease;
      const remoteVersion = release.tag_name.replace(/^v/, '');

      if (semver.gt(remoteVersion, this.currentVersion)) {
        log.info('New version available on GitHub: %s', remoteVersion);
        this.setUpdate({ version: remoteVersion, source: 'github' });
        return remoteVersion;
      }

      return null;
    } catch (err) {
      log.error('GitHub check failed: %s', (err as Error).message);
      return null;
    }
  }

  checkUsb(): string | null {
    const searchPaths = config.USB_UPDATE_PATHS.split(',').map((p) => p.trim()).filter(Boolean);
    const candidates = findUsbUpdates(searchPaths);

    // Find the highest version that's newer than current
    let best: UpdateInfo | null = null;
    for (const candidate of candidates) {
      if (!semver.gt(candidate.version, this.currentVersion)) continue;
      if (!best || semver.gt(candidate.version, best.version)) {
        best = candidate;
      }
    }

    if (best) {
      log.info('New version available on USB: %s (%s)', best.version, best.tarPath);
      this.setUpdate(best);
      return best.version;
    }

    return null;
  }

  async checkForUpdate(): Promise<string | null> {
    // USB is checked regardless of connectivity
    const usbResult = this.checkUsb();

    // GitHub only when online
    const githubResult = await this.checkGitHub();

    return usbResult ?? githubResult;
  }

  async downloadAndApply(): Promise<void> {
    if (!this._pendingUpdate) return;

    const { version, source, tarPath: usbTarPath, checksumPath: usbChecksumPath } = this._pendingUpdate;

    if (source === 'github') {
      await this.applyFromGitHub(version);
    } else {
      await this.applyFromUsb(version, usbTarPath!, usbChecksumPath);
    }
  }

  async applyUploadedTar(tarBuffer: Buffer, filename: string): Promise<{ ok: boolean; error?: string; version?: string }> {
    const version = parseVersionFromTarName(filename);
    if (!version) {
      return { ok: false, error: 'Ungültiger Dateiname. Erwartet: app-vX.Y.Z.tar.gz' };
    }

    if (!semver.gt(version, this.currentVersion)) {
      return { ok: false, error: `Version ${version} ist nicht neuer als aktuelle Version ${this.currentVersion}` };
    }

    this.emit('update-applying');
    log.info('Applying uploaded update v%s from %s...', version, filename);

    try {
      const tmpPath = path.join('/tmp', `upload-update-${version}.tar.gz`);
      fs.writeFileSync(tmpPath, tarBuffer);

      const appDir = process.cwd();
      execSync(`tar -xzf "${tmpPath}" -C "${appDir}"`, { stdio: 'pipe' });
      log.info('Upload update %s extracted', version);

      fs.unlinkSync(tmpPath);

      log.info('Restarting via PM2...');
      setTimeout(() => {
        process.exit(0);
      }, 1000);

      return { ok: true, version };
    } catch (err) {
      log.error('Upload update failed: %s', (err as Error).message);
      return { ok: false, error: 'Update konnte nicht entpackt werden. Datei möglicherweise beschädigt.' };
    }
  }

  private async applyFromUsb(version: string, tarPath: string, checksumPath?: string): Promise<void> {
    this.emit('update-applying');
    log.info('Applying USB update v%s from %s...', version, tarPath);

    try {
      if (!fs.existsSync(tarPath)) {
        log.error('USB update file not found: %s — was the drive removed?', tarPath);
        return;
      }

      if (checksumPath) {
        log.info('Verifying checksum...');
        if (!verifyChecksum(tarPath, checksumPath)) {
          log.error('Checksum mismatch — update file may be corrupted');
          return;
        }
        log.info('Checksum verified');
      } else {
        log.info('No checksum file found — skipping verification');
      }

      const appDir = process.cwd();
      log.info('Extracting to %s...', appDir);
      execSync(`tar -xzf "${tarPath}" -C "${appDir}"`, { stdio: 'pipe' });
      log.info('Update %s extracted', version);

      log.info('Restarting via PM2...');
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    } catch (err) {
      log.error('USB update failed: %s', (err as Error).message);
    }
  }

  private async applyFromGitHub(version: string): Promise<void> {
    if (!connectivity.isOnline()) return;

    this.emit('update-applying');
    log.info('Starting download for v%s...', version);

    try {
      const url = `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/latest`;
      const res = await fetch(url, { headers: this.apiHeaders });
      const release: GitHubRelease = await res.json() as GitHubRelease;

      const tarAsset = release.assets.find((a) => a.name.endsWith('.tar.gz'));
      const checksumAsset = release.assets.find((a) => a.name === 'checksum.sha256');

      if (!tarAsset) {
        log.error('No .tar.gz asset found in release');
        return;
      }

      const tmpDir = '/tmp';
      const tarPath = path.join(tmpDir, `app-update-${version}.tar.gz`);

      log.info('Downloading %s...', tarAsset.browser_download_url);
      const downloadRes = await fetch(tarAsset.browser_download_url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'implenia-kiosk-updater' },
      });

      if (!downloadRes.ok || !downloadRes.body) {
        log.error('Download failed: %d %s', downloadRes.status, downloadRes.statusText);
        return;
      }

      const nodeStream = Readable.fromWeb(downloadRes.body as import('node:stream/web').ReadableStream);
      await pipeline(nodeStream, createWriteStream(tarPath));

      const fileSize = fs.statSync(tarPath).size;
      log.info('Downloaded %s (%d bytes)', tarAsset.name, fileSize);

      if (checksumAsset) {
        log.info('Verifying checksum...');
        const checksumRes = await fetch(checksumAsset.browser_download_url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'implenia-kiosk-updater' },
        });
        const expectedChecksum = (await checksumRes.text()).trim().split(/\s+/)[0];

        const fileBuffer = fs.readFileSync(tarPath);
        const actualChecksum = createHash('sha256').update(fileBuffer).digest('hex');

        if (actualChecksum !== expectedChecksum) {
          log.error('Checksum mismatch! Expected %s, got %s', expectedChecksum, actualChecksum);
          fs.unlinkSync(tarPath);
          return;
        }
        log.info('Checksum verified');
      }

      const appDir = process.cwd();
      log.info('Extracting to %s...', appDir);
      execSync(`tar -xzf ${tarPath} -C ${appDir}`, { stdio: 'pipe' });
      log.info('Update %s extracted', version);

      fs.unlinkSync(tarPath);

      log.info('Restarting via PM2...');
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    } catch (err) {
      log.error('Update failed: %s', (err as Error).message);
    }
  }

  start(): void {
    setTimeout(() => this.checkForUpdate(), 10_000);

    this.timer = setInterval(
      () => this.checkForUpdate(),
      config.UPDATE_CHECK_INTERVAL_MS
    );
    log.info('Update checker started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const updater = new UpdateManager();
