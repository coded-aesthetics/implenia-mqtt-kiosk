/**
 * Which construction site this kiosk is currently working on.
 *
 * An element is known to the kiosk only by its name, and element names repeat
 * across sites — a bridge is a row of piers, each pier is its own BIM widget
 * with its own API key, and every one of them has a `P-01`. Everything the
 * kiosk remembers per element was keyed by that name alone, so moving the
 * machine to the next pier carried the previous one's state over: its finished
 * elements stayed in the „Abgeschlossene Elemente" row, its recordings marked
 * the new pier's identically-named pillars as begun, and — silently — its
 * cached platform sensor ids were available to be pinned into a session
 * started offline, which uploads a pier's measurements onto the pier next to
 * it.
 *
 * The site is therefore identified, and every one of those stores is scoped to
 * it. **The identity is the API key**, because that is what actually changes
 * when the machine moves: one key per construction phase per site, switched on
 * the way to the next pier. Nothing is fetched to establish it, which matters
 * — the question "which site am I on" is asked by the element list, so an
 * answer that needed the network would be unavailable exactly when the kiosk
 * is doing its offline job.
 *
 * The API URL is deliberately *not* part of it. A kiosk's URL comes from
 * `.env` on some machines, and folding it in would mean a provisioning change
 * to that file silently re-scoped a machine's whole history. Two platforms
 * issuing the same key is not a thing that happens; an `.env` edit is.
 */

import { createHash } from 'node:crypto';
import { getApiConfig } from './implenia-api.js';
import { adoptCurrentSite, currentSiteId, setSiteCredentials } from './db.js';
import { forgetElementDevices } from './element-device.js';
import { createLogger } from './logger.js';

const log = createLogger('site');

/**
 * The site id for an API key: a truncated SHA-256 of it.
 *
 * Hashed rather than stored, because this value ends up in log lines, in
 * `recording_sessions.site_id` and in meta keys — all of which service
 * personnel read, and none of which should be somewhere a credential can be
 * copied out of. Truncated because 16 hex characters is 64 bits, and the
 * number of keys one kiosk sees in its life is measured in dozens.
 */
export function siteFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * Point the kiosk at the site its configured API key belongs to.
 *
 * Called at startup and after the key is saved. Returns true when the site
 * actually changed.
 *
 * **A missing key leaves the site alone**, rather than returning the kiosk to
 * the unscoped `default`. Entering a wrong key runs
 * `POST /api/config` → validate → `DELETE /api/config/api-key` (see
 * VerbindungConfig), so a typo would otherwise orphan the real site's history
 * until somebody happened to retype the right key. The site id means "the last
 * key this kiosk was given", and a kiosk with no key shows the „Kein
 * API-Schlüssel konfiguriert" notice in place of the element list anyway.
 */
export function syncSite(): boolean {
  const cfg = getApiConfig();
  if (!cfg) return false;

  const siteId = siteFingerprint(cfg.apiKey);

  /*
   * Record the key before anything else, and on every call rather than only on
   * a change.
   *
   * This is what lets a pier's measurements still be uploaded after the crew
   * has moved on (site-credentials.ts) — the site id is a one-way hash and
   * cannot produce a key. Unconditionally, because the API *URL* can be changed
   * without changing the site id (it is deliberately not part of the hash), and
   * a stored URL left pointing at the previous backend would send a left-behind
   * pier's data to the wrong platform.
   */
  setSiteCredentials(siteId, cfg.apiUrl, cfg.apiKey);

  const previous = currentSiteId();
  if (siteId === previous) return false;

  adoptCurrentSite(siteId);
  /*
   * Element→device ids are keyed by `(site, name)` themselves, so this is no
   * longer what keeps the piers apart — a left-behind pier's upload resolves
   * under its own key and needs its own entry (see site-credentials.ts). It
   * stays because the map is unbounded and a machine that works down a bridge
   * would otherwise hold every pillar of every pier it has visited; the
   * resolve is one request, and anything making it is online by definition.
   */
  forgetElementDevices();
  log.info('Site changed from %s to %s', previous, siteId);
  return true;
}
