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
    url: string;
    browser_download_url: string;
  }>;
}

const TAR_PATTERN = /^app-v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)\.tar\.gz$/;

/** Headers for reading the GitHub API — releases, tags, metadata. */
export function githubApiHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'implenia-kiosk-updater',
  };
  if (token) h['Authorization'] = `token ${token}`;
  return h;
}

/**
 * Headers for downloading a release *asset*, which is not the same request as
 * reading the release.
 *
 * The assets live at `/releases/assets/<id>`, and that endpoint serves two
 * different things depending on Accept: with the v3+json above it answers the
 * asset's **metadata**, and only `application/octet-stream` gets its bytes.
 * Downloading with the API headers therefore succeeds — 200, a body, a
 * plausible size — and writes a JSON document into `app-vX.tar.gz`.
 *
 * That is how this shipped, and the checksum is what caught it: the expected
 * hash was parsed out of the checksum asset's metadata (a JSON blob, so the
 * first whitespace-delimited token of it) and compared against the hash of the
 * tar asset's metadata. Both halves wrong, mismatching, and every GitHub
 * update on every kiosk stopped there — the USB path, which reads the file off
 * the stick, was unaffected and is why this went unnoticed.
 *
 * `browser_download_url` would also serve the bytes, but it redirects to a
 * signed S3 URL that rejects the request if the Authorization header follows
 * it, so the asset API plus this Accept is the one combination that works for
 * a private repo.
 */
export function githubAssetHeaders(token?: string): Record<string, string> {
  return { ...githubApiHeaders(token), Accept: 'application/octet-stream' };
}

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

  /**
   * GitHub release polling needs owner + repo. They ship with the release
   * image; when they are missing the kiosk still updates from USB.
   */
  private get githubConfigured(): boolean {
    return Boolean(config.GITHUB_OWNER && config.GITHUB_REPO);
  }

  private get apiHeaders(): Record<string, string> {
    return githubApiHeaders(config.GITHUB_TOKEN);
  }

  private get assetHeaders(): Record<string, string> {
    return githubAssetHeaders(config.GITHUB_TOKEN);
  }

  /**
   * Give up on an apply, and say so.
   *
   * `update-applying` was a one-way latch: it is emitted before the download
   * and nothing ever cleared it, so a failure left the version indicator
   * reading "Update läuft — App startet neu" until somebody reloaded the page.
   * The kiosk was fine; the header was lying, and the only honest-looking
   * recovery was to wait for a restart that was never coming. That is the dead
   * end the resilience rules exist to forbid — and with the asset-header bug
   * above it was the *normal* outcome of tapping the update.
   *
   * The reason is German and user-facing: whoever tapped is standing in front
   * of the machine, and the next step differs per failure.
   */
  private failApply(reason: string, detail?: string): void {
    log.error('Update failed: %s%s', reason, detail ? ` — ${detail}` : '');
    this.emit('update-failed', reason);
  }

  private setUpdate(info: UpdateInfo): void {
    // Only upgrade — never replace a pending update with an older version
    if (this._pendingUpdate && !semver.gt(info.version, this._pendingUpdate.version)) return;

    this._pendingUpdate = info;
    this.emit('update-available', info.version, info.source);
  }

  async checkGitHub(): Promise<string | null> {
    if (!this.githubConfigured) return null;
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
      const reason = 'Update konnte nicht entpackt werden. Datei möglicherweise beschädigt.';
      this.failApply(reason, (err as Error).message);
      return { ok: false, error: reason };
    }
  }

  private async applyFromUsb(version: string, tarPath: string, checksumPath?: string): Promise<void> {
    this.emit('update-applying');
    log.info('Applying USB update v%s from %s...', version, tarPath);

    try {
      if (!fs.existsSync(tarPath)) {
        this.failApply(
          'Die Update-Datei ist nicht mehr da. Bitte den USB-Stick wieder einstecken.',
          `missing ${tarPath}`,
        );
        return;
      }

      if (checksumPath) {
        log.info('Verifying checksum...');
        if (!verifyChecksum(tarPath, checksumPath)) {
          this.failApply(
            'Die Update-Datei auf dem Stick ist beschädigt. Bitte den Stick neu beschreiben.',
            'checksum mismatch',
          );
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
      this.failApply(
        'Das Update konnte nicht entpackt werden. Bitte den Stick neu beschreiben.',
        (err as Error).message,
      );
    }
  }

  private async applyFromGitHub(version: string): Promise<void> {
    // Both of these used to return silently, before the `update-applying` the
    // UI listens for — so the tap landed, the server agreed to apply, and the
    // indicator sat there unchanged. "Nothing happened" is the one answer a
    // button may never give.
    if (!this.githubConfigured) {
      this.failApply(
        'Dieser Kiosk weiß nicht, woher Updates kommen. Das muss im Setup eingetragen werden.',
        'GITHUB_OWNER/GITHUB_REPO unset',
      );
      return;
    }
    if (!connectivity.isOnline()) {
      this.failApply('Keine Internetverbindung. Das Update braucht eine Verbindung.');
      return;
    }

    this.emit('update-applying');
    log.info('Starting download for v%s...', version);

    try {
      const url = `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/latest`;
      const res = await fetch(url, { headers: this.apiHeaders });
      const release: GitHubRelease = await res.json() as GitHubRelease;

      const tarAsset = release.assets.find((a) => a.name.endsWith('.tar.gz'));
      const checksumAsset = release.assets.find((a) => a.name === 'checksum.sha256');

      if (!tarAsset) {
        this.failApply(
          `Die Version ${version} enthält kein installierbares Paket. Bitte Bescheid geben.`,
          'no .tar.gz asset in release',
        );
        return;
      }

      const tmpDir = '/tmp';
      const tarPath = path.join(tmpDir, `app-update-${version}.tar.gz`);

      log.info('Downloading %s...', tarAsset.name);
      const downloadRes = await fetch(tarAsset.url, {
        redirect: 'follow',
        headers: this.assetHeaders,
      });

      if (!downloadRes.ok || !downloadRes.body) {
        this.failApply(
          'Das Update konnte nicht geladen werden. Bitte die Internetverbindung prüfen und erneut versuchen.',
          `HTTP ${downloadRes.status} ${downloadRes.statusText}`,
        );
        return;
      }

      const nodeStream = Readable.fromWeb(downloadRes.body as import('node:stream/web').ReadableStream);
      await pipeline(nodeStream, createWriteStream(tarPath));

      const fileSize = fs.statSync(tarPath).size;
      log.info('Downloaded %s (%d bytes)', tarAsset.name, fileSize);

      if (checksumAsset) {
        log.info('Verifying checksum...');
        const checksumRes = await fetch(checksumAsset.url, {
          redirect: 'follow',
          headers: this.assetHeaders,
        });
        const expectedChecksum = (await checksumRes.text()).trim().split(/\s+/)[0];

        const fileBuffer = fs.readFileSync(tarPath);
        const actualChecksum = createHash('sha256').update(fileBuffer).digest('hex');

        if (actualChecksum !== expectedChecksum) {
          fs.unlinkSync(tarPath);
          this.failApply(
            'Das Update wurde unvollständig geladen. Bitte erneut versuchen.',
            `checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
          );
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
      this.failApply(
        'Das Update konnte nicht installiert werden. Bitte erneut versuchen.',
        (err as Error).message,
      );
    }
  }

  start(): void {
    if (config.NODE_ENV === 'development') {
      log.info('Update checker disabled in development mode');
      return;
    }

    if (!this.githubConfigured) {
      log.warn('GITHUB_OWNER/GITHUB_REPO not set — GitHub update checks disabled, USB updates still active');
    }

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
