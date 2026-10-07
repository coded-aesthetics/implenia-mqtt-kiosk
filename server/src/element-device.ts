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
import { createLogger } from './logger.js';

const log = createLogger('element-device');

const deviceIds = new Map<string, string>();

/** Status codes that can mean "the id we cached is no longer this element's". */
const STALE_ID_STATUS = new Set([401, 403, 404]);

async function resolveElementDeviceId(elementName: string): Promise<string> {
  const cached = deviceIds.get(elementName);
  if (cached) return cached;

  const encoded = encodeURIComponent(elementName);
  const res = await fetchImplenia<{ device_id?: string }>(
    `/api/v1/measuring-device/self/child/name:${encoded}/resolve`,
  );
  const deviceId = res?.device_id;
  if (!deviceId) {
    throw new Error(
      `Element „${elementName}" ist in der Implenia-Plattform nicht auffindbar. ` +
      'Bitte den Schichtauftrag prüfen.',
    );
  }

  deviceIds.set(elementName, deviceId);
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

    deviceIds.delete(elementName);
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
