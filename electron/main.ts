import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { copyFile, access } from 'node:fs/promises';
import path from 'node:path';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
let server: ChildProcess | null = null;

function resourcesDir(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), '..');
}

async function ensureEnvFile(): Promise<void> {
  const userData = app.getPath('userData');
  const dest = path.join(userData, '.env');
  try {
    await access(dest);
  } catch {
    // First run — seed from .env.example so the server can start
    const example = path.join(resourcesDir(), '.env.example');
    await copyFile(example, dest).catch(() => {});
  }
}

function startServer(): void {
  const root = resourcesDir();
  server = spawn(
    process.execPath,
    [path.join(root, 'server', 'dist', 'index.js')],
    {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(PORT),
        NODE_ENV: 'production',
        DB_PATH: path.join(app.getPath('userData'), 'kiosk.db'),
        ENV_DIR: app.getPath('userData'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  server.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/status`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not respond within ${timeoutMs / 1000}s`);
}

app.whenReady().then(async () => {
  await ensureEnvFile();
  startServer();
  await waitForServer();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(`http://localhost:${PORT}`);
});

app.on('before-quit', () => { server?.kill('SIGTERM'); });
app.on('window-all-closed', () => { server?.kill('SIGTERM'); app.quit(); });
