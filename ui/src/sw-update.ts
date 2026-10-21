/**
 * Reload the page by itself when a new service worker takes over.
 *
 * **There is no keyboard on site.** A kiosk left running a stale UI after an
 * update cannot be rescued by F5 — the machine is a touchscreen and the people
 * in front of it are wearing gloves. So the app has to notice and do it
 * itself.
 *
 * What it closes: the updater swaps `ui/dist`, PM2 restarts, the WebSocket
 * reconnects and the UI reloads itself (`useWebSocket.ts`). That navigation can
 * still be answered by the *outgoing* service worker, which hands back the
 * shell it already had — so the page comes up on the old bundle while `/status`
 * reports the new version. The new worker installs during that page's life and
 * claims control a moment later (`skipWaiting` + `clientsClaim`), which is
 * exactly the event below, and the reload it triggers lands on the new build.
 *
 * It is a race, not a certainty — the new worker sometimes wins and serves the
 * navigation itself, in which case nothing here fires. Being a race is why it
 * cannot be left to chance.
 *
 * Not precaching the shell (`vite.config.ts`) is the other half: it is what
 * makes *this* reload fetch fresh HTML rather than repeating the old one.
 */

/** At most one automatic reload per this window, whatever the worker does. */
const MINDESTABSTAND_MS = 30_000;
const SPEICHER_SCHLUESSEL = 'sw-auto-reload';

export function reloadWhenWorkerTakesOver(): void {
  if (!('serviceWorker' in navigator)) return;

  /*
   * Only when a worker was *already* in control as this page loaded.
   *
   * On a first-ever visit `controller` is null and `clientsClaim` fires
   * `controllerchange` for the initial install — reloading there would restart
   * a page that is already running the current build, on every fresh profile
   * and after every cache clear.
   */
  if (!navigator.serviceWorker.controller) return;

  let schonGeladen = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (schonGeladen) return;
    if (!darfNeuLaden(Date.now(), letzterReload())) return;
    schonGeladen = true;
    merkeReload(Date.now());
    window.location.reload();
  });
}

/**
 * Whether an automatic reload is allowed now.
 *
 * The guard exists because a reload loop on a kiosk is far worse than a stale
 * clock: a worker that reinstalled on every load would make the screen
 * unusable with no keyboard to break the cycle. A stale UI keeps recording and
 * uploading; a looping one records nothing.
 */
export function darfNeuLaden(jetzt: number, letzter: number | null): boolean {
  if (letzter === null) return true;
  return jetzt - letzter >= MINDESTABSTAND_MS;
}

/** `sessionStorage` can throw or come back empty; a failure must not block the reload. */
function letzterReload(): number | null {
  try {
    const roh = sessionStorage.getItem(SPEICHER_SCHLUESSEL);
    if (!roh) return null;
    const wert = Number(roh);
    return Number.isFinite(wert) ? wert : null;
  } catch {
    return null;
  }
}

function merkeReload(jetzt: number): void {
  try {
    sessionStorage.setItem(SPEICHER_SCHLUESSEL, String(jetzt));
  } catch {
    // No storage, no guard — the reload still happens. One stale screen is a
    // worse outcome than a loop that cannot occur without a broken worker.
  }
}
