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

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

class UpdateManager extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentVersion: string;
  private _updateAvailable: string | null = null;

  constructor() {
    super();
    const pkgPath = path.join(process.cwd(), 'server', 'package.json');
    const fallbackPath = path.join(process.cwd(), 'package.json');
    const resolvedPath = fs.existsSync(pkgPath) ? pkgPath : fallbackPath;
    const pkg = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    this.currentVersion = pkg.version;
    console.log(`[Updater] Current version: ${this.currentVersion}`);
  }

  get updateAvailable(): string | null {
    return this._updateAvailable;
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

  private get downloadHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/octet-stream',
      'User-Agent': 'implenia-kiosk-updater',
    };
    if (config.GITHUB_TOKEN) {
      h['Authorization'] = `token ${config.GITHUB_TOKEN}`;
    }
    return h;
  }

  async checkForUpdate(): Promise<string | null> {
    if (!connectivity.isOnline()) return null;

    try {
      const url = `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/latest`;
      const res = await fetch(url, { headers: this.apiHeaders });

      if (!res.ok) {
        console.error(`[Updater] GitHub API responded ${res.status}`);
        return null;
      }

      const release: GitHubRelease = await res.json() as GitHubRelease;
      const remoteVersion = release.tag_name.replace(/^v/, '');

      if (semver.gt(remoteVersion, this.currentVersion)) {
        console.log(`[Updater] New version available: ${remoteVersion}`);
        this._updateAvailable = remoteVersion;
        this.emit('update-available', remoteVersion);
        return remoteVersion;
      }

      return null;
    } catch (err) {
      console.error('[Updater] Check failed:', (err as Error).message);
      return null;
    }
  }

  async downloadAndApply(): Promise<void> {
    if (!this._updateAvailable || !connectivity.isOnline()) return;

    const version = this._updateAvailable;
    this.emit('update-applying');
    console.log(`[Updater] Starting download for v${version}...`);

    try {
      const url = `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/latest`;
      const res = await fetch(url, { headers: this.apiHeaders });
      const release: GitHubRelease = await res.json() as GitHubRelease;

      const tarAsset = release.assets.find((a) => a.name.endsWith('.tar.gz'));
      const checksumAsset = release.assets.find((a) => a.name === 'checksum.sha256');

      if (!tarAsset) {
        console.error('[Updater] No .tar.gz asset found in release');
        return;
      }

      const tmpDir = '/tmp';
      const tarPath = path.join(tmpDir, `app-update-${version}.tar.gz`);

      // Download tar.gz using browser_download_url (public) — no auth header needed
      console.log(`[Updater] Downloading ${tarAsset.browser_download_url}...`);
      const downloadRes = await fetch(tarAsset.browser_download_url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'implenia-kiosk-updater' },
      });

      if (!downloadRes.ok || !downloadRes.body) {
        console.error(`[Updater] Download failed: ${downloadRes.status} ${downloadRes.statusText}`);
        return;
      }

      const nodeStream = Readable.fromWeb(downloadRes.body as import('node:stream/web').ReadableStream);
      await pipeline(nodeStream, createWriteStream(tarPath));

      const fileSize = fs.statSync(tarPath).size;
      console.log(`[Updater] Downloaded ${tarAsset.name} (${fileSize} bytes)`);

      // Verify checksum if available
      if (checksumAsset) {
        console.log('[Updater] Verifying checksum...');
        const checksumRes = await fetch(checksumAsset.browser_download_url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'implenia-kiosk-updater' },
        });
        const expectedChecksum = (await checksumRes.text()).trim().split(/\s+/)[0];

        const fileBuffer = fs.readFileSync(tarPath);
        const actualChecksum = createHash('sha256').update(fileBuffer).digest('hex');

        if (actualChecksum !== expectedChecksum) {
          console.error(`[Updater] Checksum mismatch! Expected ${expectedChecksum}, got ${actualChecksum}`);
          fs.unlinkSync(tarPath);
          return;
        }
        console.log('[Updater] Checksum verified');
      }

      // Extract over current installation
      const appDir = process.cwd();
      console.log(`[Updater] Extracting to ${appDir}...`);
      execSync(`tar -xzf ${tarPath} -C ${appDir}`, { stdio: 'pipe' });
      console.log(`[Updater] Update ${version} extracted`);

      // Clean up tarball
      fs.unlinkSync(tarPath);

      // Signal graceful restart
      console.log('[Updater] Restarting via PM2...');
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    } catch (err) {
      console.error('[Updater] Update failed:', (err as Error).message);
    }
  }

  start(): void {
    setTimeout(() => this.checkForUpdate(), 10_000);

    this.timer = setInterval(
      () => this.checkForUpdate(),
      config.UPDATE_CHECK_INTERVAL_MS
    );
    console.log('[Updater] Update checker started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const updater = new UpdateManager();
