/**
 * Running a request against a site the kiosk is no longer on.
 *
 * A session's measurements upload to the sensor ids of the site they were
 * recorded on, and the platform will only accept them from *that site's* key.
 * So an upload is not addressed by "the configured credentials" but by "the
 * credentials of this session's site" — which for the session being recorded
 * right now are the same thing, and for a pier the crew left this morning are
 * not.
 *
 * Before this, a pending session kept being retried under the new pier's key:
 * 401 on every connectivity transition and every boot, for the life of the
 * machine, with nothing on screen and the only way out retyping the old key by
 * hand. Which is a real thing to ask of nobody — the keys come from the portal
 * and a crew on a bridge has one per pier.
 *
 * **Why an ambient context rather than a parameter.** One upload fans out to
 * the CSV batch endpoint, the per-sensor batch endpoint, the element→device
 * resolve in `element-device.ts` and the `Ausführungsdatum` write in
 * `element-completion.ts`, each with its own layers and its own cache. Threaded
 * as an argument, every one of them has to pass it on correctly or it silently
 * reverts to the current key — and "silently sends to the wrong site" is the
 * failure mode this whole area exists to prevent. `AsyncLocalStorage` makes the
 * default correct for the entire call tree, and it is per-async-context, so the
 * stop route's upload and the connectivity sweep cannot read each other's.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { currentSiteId, getSiteCredentials, DEFAULT_SITE, type SiteCredentials } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('site-credentials');

export interface SiteOverride extends SiteCredentials {
  siteId: string;
}

const context = new AsyncLocalStorage<SiteOverride>();

/** The credentials this request must use instead of the configured ones. */
export function siteOverride(): SiteOverride | null {
  return context.getStore() ?? null;
}

/**
 * Which site the work in hand belongs to — the override's, else the kiosk's.
 *
 * Anything caching a platform answer per element name needs this rather than
 * `currentSiteId()`, or an upload running under a previous pier's key fills
 * that cache with the previous pier's answers under the current pier's name.
 */
export function effectiveSiteId(): string {
  return siteOverride()?.siteId ?? currentSiteId();
}

/**
 * Run `fn` against a site's own credentials.
 *
 * A no-op — not a failure — in the three cases where there is nothing to
 * override with, each of which keeps the previous behaviour exactly:
 *
 * - the site is the one the kiosk is on, which is every live upload;
 * - the session predates site ids, or was recorded with no key configured
 *   (`default`), so there is no site to be the credentials *of*;
 * - the site is known but its key was never stored — a session recorded
 *   before `site_credentials` existed. It uploads under the current key, which
 *   is what it would have done anyway.
 */
export function withSiteCredentials<T>(
  siteId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!siteId || siteId === DEFAULT_SITE || siteId === currentSiteId()) return fn();

  const credentials = getSiteCredentials(siteId);
  if (!credentials) {
    log.warn(
      'No stored credentials for site %s — running under the configured key instead',
      siteId,
    );
    return fn();
  }

  log.info('Running against site %s rather than the configured one', siteId);
  return context.run({ ...credentials, siteId }, fn);
}
