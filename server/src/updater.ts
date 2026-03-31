import fs from 'node:fs';
import path from 'node:path';
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
    // Read version from the server package.json
    const pkgPath = path.join(process.cwd(), 'server', 'package.json');
    // Fallback to root package.json
    const fallbackPath = path.join(process.cwd(), 'package.json');
    const resolvedPath = fs.existsSync(pkgPath) ? pkgPath : fallbackPath;
    const pkg = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    this.currentVersion = pkg.version;
    console.log(`[Updater] Current version: ${this.currentVersion}`);
  }

  get updateAvailable(): string | null {
    return this._updateAvailable;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
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
      const res = await fetch(url, { headers: this.headers });

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

    try {
      const url = `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/latest`;
      const res = await fetch(url, { headers: this.headers });
      const release: GitHubRelease = await res.json() as GitHubRelease;

      // Find the tar.gz asset
      const tarAsset = release.assets.find((a) => a.name.endsWith('.tar.gz'));
      const checksumAsset = release.assets.find((a) => a.name === 'checksum.sha256');

      if (!tarAsset) {
        console.error('[Updater] No .tar.gz asset found in release');
        return;
      }

      const tmpDir = '/tmp';
      const tarPath = path.join(tmpDir, `app-update-${version}.tar.gz`);

      // Download tar.gz
      console.log(`[Updater] Downloading ${tarAsset.name}...`);
      const downloadRes = await fetch(tarAsset.browser_download_url, {
        headers: this.headers,
        redirect: 'follow',
      });

      if (!downloadRes.ok || !downloadRes.body) {
        console.error(`[Updater] Download failed: ${downloadRes.status}`);
        return;
      }

      await pipeline(downloadRes.body as unknown as NodeJS.ReadableStream, createWriteStream(tarPath));

      // Verify checksum if available
      if (checksumAsset) {
        console.log('[Updater] Verifying checksum...');
        const checksumRes = await fetch(checksumAsset.browser_download_url, {
          headers: this.headers,
          redirect: 'follow',
        });
        const expectedChecksum = (await checksumRes.text()).trim().split(/\s+/)[0];

        const fileBuffer = fs.readFileSync(tarPath);
        const actualChecksum = createHash('sha256').update(fileBuffer).digest('hex');

        if (actualChecksum !== expectedChecksum) {
          console.error('[Updater] Checksum mismatch! Aborting update.');
          fs.unlinkSync(tarPath);
          return;
        }
        console.log('[Updater] Checksum verified');
      }

      // Extract to staging directory
      const stagingDir = path.join(process.cwd(), '..', 'app-next');
      fs.mkdirSync(stagingDir, { recursive: true });
      execSync(`tar -xzf ${tarPath} -C ${stagingDir}`, { stdio: 'pipe' });

      // Write update-ready flag
      fs.writeFileSync(path.join(stagingDir, 'update-ready'), version);
      console.log(`[Updater] Update ${version} extracted and ready`);

      // Clean up tarball
      fs.unlinkSync(tarPath);

      // Signal graceful restart
      console.log('[Updater] Signaling restart...');
      setTimeout(() => {
        // Try SIGUSR2 for PM2 graceful reload
        try {
          process.kill(process.pid, 'SIGUSR2');
        } catch {
          // Fallback: exit and let process manager restart
          process.exit(0);
        }
      }, 1000);
    } catch (err) {
      console.error('[Updater] Update failed:', (err as Error).message);
    }
  }

  start(): void {
    // Initial check after a short delay
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
