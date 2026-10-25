/**
 * Resolving an element name to its platform device id.
 *
 * Writes that target an element as a whole — the `Ausführungsdatum` stamp, a
 * voice comment — go through
 * `POST /api/v1/measuring-device/{device_id}/readings/batch`, and the kiosk
 * knows elements only by name. It resolves the name to an id and writes by id
 * rather than passing `name:<element>` as the device_id, even though the
 * backend now accepts that reference form: it was added to `resolveDeviceID`
 * only after this kiosk shipped, and a kiosk self-updates hourly while the
 * backend is deployed separately, so the field runs both versions at once.
 * Resolve-then-write works against either.
 *
 * Before that backend change the reference form worked on the hierarchy routes
 * (`…/child/{child_ref}`, its grandchild and `…/sensors/latest` variants, and
 * `…/resolve`) but not on the batch endpoint, which handed the path segment
 * straight to `ValidateDeviceAccess` and so answered
 * `401 device access error: device not found: name:F-23` — the element existed,
 * the lookup form did not.
 *
 * Ids are cached in memory only, never in SQLite. Everything that writes by
 * element happens online by definition (completion follows a successful upload,
 * the clear follows an operator tap, comments are posted live), so a persisted
 * id would buy nothing and would add a second source of truth that goes stale
 * when an element device is rebuilt in the platform — the kind of silent
 * write-path failure this module exists to prevent. The session sensor map is
 * persisted for the opposite reason: the upload must survive restarts and run
 * hours later.
 */

import { fetchImplenia, type ApiError } from './implenia-api.js';
import { effectiveSiteId } from './site-credentials.js';
import { createLogger } from './logger.js';

const log = createLogger('element-device');

/**
 * Cached ids, keyed by **site and** element name.
 *
 * The name alone is not an identity — a bridge's piers each have a `P-01` (see
 * site.ts) — and clearing the map on a key change is not enough on its own any
 * more: an upload of a session recorded on a pier the kiosk has left runs under
 * *that* pier's key, so both sites' answers are now in flight within one
 * process. Keyed by name only, the previous pier's resolve would be handed back
 * for the current pier's element, and the next `Ausführungsdatum` written to
 * the wrong pillar — with a 200 and nothing to notice.
 *
 * The unit separator is there because an element name comes off the wire and
 * has carried spaces and slashes before; it is the one byte it cannot contain.
 */
const deviceIds = new Map<string, string>();

function cacheKey(elementName: string): string {
  return `${effectiveSiteId()}\u001f${elementName}`;
}

/**
 * The platform answered, and knows no device for this element.
 *
 * Deliberately distinct from a transport failure on the same request: this one
 * *is* an answer, and no amount of retrying changes it until the Schichtauftrag
 * does. The CSV upload needs the distinction. Its endpoint is addressed per
 * element device, so an element that does not resolve leaves it with nothing to
 * post to at all, while the per-sensor route is addressed by sensor id and
 * needs no device — which makes this a reason to hand the whole session to that
 * route, not a reason to mark every chunk failed on every attempt forever.
 */
export class ElementNotResolvableError extends Error {
  readonly elementUnresolved = true;
}

/** Whether a thrown error is `ElementNotResolvableError`. */
export function isElementNotResolvable(err: unknown): boolean {
  return (err as { elementUnresolved?: boolean } | null)?.elementUnresolved === true;
}

/** Status codes that can mean "the id we cached is no longer this element's". */
const STALE_ID_STATUS = new Set([401, 403, 404]);

async function resolveElementDeviceId(elementName: string): Promise<string> {
  const key = cacheKey(elementName);
  const cached = deviceIds.get(key);
  if (cached) return cached;

  const encoded = encodeURIComponent(elementName);
  const res = await fetchImplenia<{ device_id?: string }>(
    `/api/v1/measuring-device/self/child/name:${encoded}/resolve`,
  );
  const deviceId = res?.device_id;
  if (!deviceId) {
    throw new ElementNotResolvableError(
      `Element „${elementName}" ist in der Implenia-Plattform nicht auffindbar. ` +
      'Bitte den Schichtauftrag prüfen.',
    );
  }

  deviceIds.set(key, deviceId);
  log.debug('Resolved element "%s" to device %s', elementName, deviceId);
  return deviceId;
}

/**
 * Run a write against an element's device, resolving its id first.
 *
 * Retries once when the write is rejected in a way that can mean the cached id
 * is stale *and* re-resolving actually yields a different id — so a genuine
 * auth failure is reported as-is instead of being sent twice.
 */
export async function withElementDevice<T>(
  elementName: string,
  write: (deviceId: string) => Promise<T>,
): Promise<T> {
  const deviceId = await resolveElementDeviceId(elementName);
  try {
    return await write(deviceId);
  } catch (err) {
    const status = (err as ApiError).statusCode;
    if (!status || !STALE_ID_STATUS.has(status)) throw err;

    deviceIds.delete(cacheKey(elementName));
    let fresh: string;
    try {
      fresh = await resolveElementDeviceId(elementName);
    } catch {
      throw err; // Report the write's failure, not the retry's.
    }
    if (fresh === deviceId) throw err;

    log.info(
      'Element "%s" moved to device %s — retrying the write',
      elementName,
      fresh,
    );
    return write(fresh);
  }
}

/** Drop a cached id. For tests and for the reset path. */
export function forgetElementDevices(): void {
  deviceIds.clear();
}
