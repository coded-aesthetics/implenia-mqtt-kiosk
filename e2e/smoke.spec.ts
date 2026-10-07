import { test, expect, type Page } from '@playwright/test';

/**
 * Three broad checks at 1024x768, the stock industry monitor.
 *
 * Not a layout test suite. These exist so a release cannot ship an app that
 * fails to boot, is missing its assets, or runs off the edge of the screen —
 * the failures unit tests cannot see and that would strand a worker in front of
 * a blank kiosk.
 *
 * Kept deliberately few and structural. An assertion that pins one particular
 * arrangement in pixels would fail the next time somebody legitimately moves a
 * button, and a smoke test that cries wolf stops being read. Where exact
 * heights matter they are recorded in README.md and CLAUDE.md as prose, not
 * frozen here.
 */

interface Watched {
  /** Uncaught exceptions and real console errors. */
  jsErrors: string[];
  /** Non-API requests that failed — a broken build or a missing asset. */
  assetFailures: string[];
}

/**
 * Watch for the failures that matter, and only those.
 *
 * The browser logs *every* 4xx/5xx response as a console error, so a literal
 * "no console errors" would fail on an unconfigured kiosk answering 503 from
 * `/api/shift-assignment` — which is correct, deliberate degradation, not a
 * fault. Asset requests are kept strict, because a 404 on a JS chunk is exactly
 * the catastrophic failure these tests exist to catch.
 */
function watch(page: Page): Watched {
  const w: Watched = { jsErrors: [], assetFailures: [] };

  page.on('pageerror', (err) => w.jsErrors.push(`uncaught: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (msg.text().includes('Failed to load resource')) return; // see page.on('response')
    w.jsErrors.push(msg.text());
  });
  page.on('response', (res) => {
    if (res.status() < 400) return;
    const { pathname } = new URL(res.url());
    if (pathname.startsWith('/api/')) return; // degradation, not breakage
    w.assetFailures.push(`${res.status()} ${pathname}`);
  });

  return w;
}

/**
 * The drilling screen.
 *
 * The leading `#` is load-bearing: routing is hash-based (`useHashRouter`), so
 * `/bohren/P-01` is served the SPA shell and then parsed as the *home* route —
 * which silently measures the element list instead of the drilling screen.
 */
const DRILLING = '/#/bohren/P-01';

/** The recording bar is driven by a WebSocket push, so wait for the live state. */
async function waitForRecordingBar(page: Page) {
  await expect(page.getByRole('button', { name: 'Beenden' }))
    .toBeVisible({ timeout: 15_000 });
}

test('the shell boots with no script errors and no missing assets', async ({ page }) => {
  const w = watch(page);

  await page.goto('/');
  await waitForRecordingBar(page);

  await expect(page.locator('img[alt="Implenia"]')).toBeVisible();
  await expect(page.locator('main')).toBeVisible();

  expect(w.jsErrors, w.jsErrors.join('\n')).toEqual([]);
  expect(w.assetFailures, w.assetFailures.join('\n')).toEqual([]);
});

test('nothing overflows the viewport', async ({ page }) => {
  await page.goto(DRILLING);
  await waitForRecordingBar(page);

  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));

  // A worker-facing screen that scrolls is a layout bug, not a feature.
  expect(m.scrollWidth, 'horizontal overflow').toBeLessThanOrEqual(m.clientWidth);
  expect(m.scrollHeight, 'vertical overflow').toBeLessThanOrEqual(m.clientHeight);
});

test('the recording bar stays a single row while recording', async ({ page }) => {
  await page.goto(DRILLING);
  await waitForRecordingBar(page);

  const controls = [
    page.getByTestId('geologie-schicht'),
    page.getByTestId('geologie-hindernis'),
    page.getByRole('button', { name: 'Beenden' }),
  ];
  for (const c of controls) await expect(c).toBeVisible();

  const boxes = await Promise.all(controls.map(async (c) => (await c.boundingBox())!));
  const tops = boxes.map((b) => b.y);

  // One row: every control shares a vertical band. Compared loosely, because
  // controls of different heights legitimately sit at slightly different tops.
  //
  // Note the geology button is in its idle state here — the suggestion needs a
  // *live* depth reading, and there is no data source in this environment. That
  // costs this assertion nothing: both states carry the same `minWidth: 150`,
  // so if the idle bar fits on one row the suggesting bar does too. The
  // suggestion rule itself is unit-tested (`naechsteGrenze`).
  const spread = Math.max(...tops) - Math.min(...tops);
  expect(spread, `bar wrapped onto separate rows (tops: ${tops.join(', ')})`)
    .toBeLessThan(20);

  // Still glove-sized targets after being packed into one row.
  for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(48);
});
