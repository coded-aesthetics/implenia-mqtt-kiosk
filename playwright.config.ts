import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Smoke tests: the catastrophic-failure net, not an E2E suite.
 *
 * Per CLAUDE.md these stay few and broad — a boot at 1024x768, the shell
 * rendering, no console errors. What they add beyond the unit suites is the one
 * thing no unit test can see: **real layout**. The kiosk runs on a 1024x768
 * industry monitor with no scrolling allowed, and a bar that silently grows a
 * second row costs the drilling profile the space the layout depends on.
 *
 * The server runs against a throwaway database, seeded by `e2e/seed.mjs`.
 * `DB_PATH` is never allowed to be a real `kiosk.db` — the same rule as the
 * vitest config, for the same reason.
 */

const SMOKE_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-smoke-')),
  'smoke.db',
);
const PORT = 3458;

export default defineConfig({
  testDir: './e2e',
  // Serial: they share one server and one database.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /**
         * The stock industry monitor, and every assertion here is about this
         * size.
         *
         * **After** the device spread, not before and not in the top-level
         * `use`: `devices['Desktop Chrome']` carries its own 1280x720
         * viewport, which silently overrode it — so these tests ran at a
         * resolution the kiosk never uses, which is the one thing they exist
         * to check.
         */
        viewport: { width: 1024, height: 768 },
      },
    },
  ],
  webServer: {
    // Built output, not tsx: the smoke test should exercise what ships.
    command: `node e2e/seed.mjs ${SMOKE_DB} && node server/dist/index.js`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DB_PATH: SMOKE_DB,
      PORT: String(PORT),
      // No broker, no API, no serial — a smoke test must not need a site.
      MQTT_URL: '',
      IMPLENIA_API_URL: '',
    },
  },
});
