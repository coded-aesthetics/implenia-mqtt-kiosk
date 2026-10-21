import type { FastifyInstance } from 'fastify';
import { fetchImplenia, getApiConfig, type ApiError } from '../implenia-api.js';
import {
  cacheImportedSensors, resolveHerstellenSensors, resolveVorgabenSensors,
  SensorDefsUnavailableError,
} from '../herstellen-sensors.js';
import {
  getMeta, setMeta, deleteMeta, setElementVorgaben, getElementVorgaben,
  getCompletedElements,
} from '../db.js';
import { validateShiftImport, resolveShiftAssignment } from '../shift-import.js';
import {
  SHIFT_CACHE_KEY, cacheServesFailure, parseShiftCache, pruneCompleted, serialiseShiftCache,
} from '../shift-cache.js';
import {
  completionStamp,
  findCompletionSensorName,
  writeElementCompletion,
} from '../element-completion.js';
import { withElementDevice } from '../element-device.js';
import { createLogger } from '../logger.js';

const log = createLogger('implenia');

const IMPORT_KEY = 'imported_shift_assignment';

/**
 * Whether the stored import's sensor definitions have been cached since boot.
 *
 * The import caches them itself, so this is only for a file imported by an
 * earlier version of this kiosk — which is the normal case right after an
 * auto-update, mid-shift, on a site that is offline. Once per process rather
 * than on every read: this endpoint is hit on every page load, and rewriting
 * fifty elements' definitions each time would be a few hundred kilobytes of
 * pointless disk writes on hardware that has better things to do.
 *
 * Set from the result, never before the attempt. A write that failed — a disk
 * briefly full is the realistic one — used to latch this to true anyway, and
 * since a kiosk only restarts on an update or a crash, the whole shift then
 * ran without the definitions the import exists to provide. Nothing retried,
 * nothing on screen said so.
 */
let importedSensorsCached = false;

export function registerImpleniaRoutes(app: FastifyInstance): void {
  // Shift assignment: return import if available, otherwise proxy to API
  app.get('/api/shift-assignment', async (request, reply) => {
    const resolved = resolveShiftAssignment(getMeta(IMPORT_KEY));
    if (resolved) {
      cacheVorgaben(resolved.data.measuring_devices);
      if (!importedSensorsCached) {
        importedSensorsCached = cacheImportedSensors(resolved.data.measuring_devices) > 0;
      }
      return reply.send({ ...resolved.data, source: resolved.source });
    }

    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    try {
      const data = await fetchImplenia('/shift-assignment/unfinished-elements?include_vorgaben=true') as { unfinished_elements: Array<Record<string, unknown>> };
      cacheVorgaben(data.unfinished_elements);
      cacheShiftAssignment(data.unfinished_elements);
      return reply.send({ measuring_devices: data.unfinished_elements, source: 'api' });
    } catch (err) {
      const upstream = (err as ApiError).statusCode;

      /*
       * The platform did not answer — serve what it last said.
       *
       * Before the error, not after: a 502 with a usable list behind it is not
       * an error the worker needs to see, it is the kiosk doing its job
       * offline. The response says `source: 'cache'` and when the list was
       * taken, and the element list puts that on screen beside the import
       * button, so nobody mistakes it for today's.
       */
      if (cacheServesFailure(err)) {
        const cached = parseShiftCache(getMeta(SHIFT_CACHE_KEY));
        if (cached) {
          const devices = pruneCompleted(cached, getCompletedElements());
          log.warn(
            'shift-assignment unreachable (%s) — serving the list cached at %s (%d element(s))',
            (err as Error).message, new Date(cached.fetchedAt).toISOString(), devices.length,
          );
          return reply.send({
            measuring_devices: devices,
            source: 'cache',
            cachedAt: cached.fetchedAt,
          });
        }
      }

      if (upstream === 404) {
        return reply.status(404).send({ error: 'not_found' });
      }
      log.error('shift-assignment error: %s', (err as Error).message);
      const forwarded = upstream && upstream >= 400 && upstream < 600 ? upstream : 502;
      return reply.status(forwarded).send({ error: (err as Error).message });
    }
  });

  /*
   * Import a shift assignment from a JSON file.
   *
   * The body limit is raised well past Fastify's 1 MiB default because the
   * file now carries each element's sensor definitions, production and
   * Vorgabe: ~21 KB of pretty-printed JSON for a DSV element, so a shift
   * assignment of around fifty pillars would otherwise be rejected with a
   * 413 — on the one path that exists for a site with no connectivity. 16 MiB
   * covers roughly 750 elements, and the cost is a transient buffer on an
   * import that happens once a shift.
   */
  app.post('/api/shift-assignment/import', {
    bodyLimit: 16 * 1024 * 1024,
  }, async (request, reply) => {
    const result = validateShiftImport(request.body);
    if (!result.valid) {
      return reply.status(400).send({ error: result.error });
    }
    setMeta(IMPORT_KEY, JSON.stringify(result.data));

    /*
     * The sensor definitions are the half of this file that makes an offline
     * site able to *record*, not merely to list its elements: they carry the
     * platform's sensor ids, which is what `beginRecording` would otherwise
     * have to fetch. Cached here rather than read back out of the stored file
     * at start time so that an element still works once it drops out of the
     * shift assignment — the same reason the Vorgaben are cached.
     *
     * A file exported before implenia-web carried the field caches nothing and
     * is still a perfectly good import; it just leaves the offline start to
     * whatever the kiosk has seen online.
     */
    const cached = cacheImportedSensors(result.data.measuring_devices);
    importedSensorsCached = cached > 0;
    if (cached > 0) {
      log.info('Cached sensor definitions for %d element(s) from the import', cached);
    } else {
      log.warn(
        'Imported Schichtauftrag carries no sensor definitions — '
        + 'offline recording will only work for elements seen online before',
      );
    }

    return reply.send({ ok: true, sensorsCached: cached });
  });

  // Clear an imported shift assignment
  app.delete('/api/shift-assignment/import', async (_request, reply) => {
    deleteMeta(IMPORT_KEY);
    // The cached definitions stay: they are what lets an element already
    // recorded here be resumed offline, and clearing the import is about which
    // elements are on the list, not about forgetting their sensors.
    importedSensorsCached = false;
    return reply.send({ ok: true });
  });

  // Vorgaben last seen for an element, for elements no longer in the shift
  // assignment. Served from the local cache on purpose: resuming a pillar is
  // exactly the moment a site is likely to be offline.
  app.get('/api/elements/:elementName/vorgaben', async (request, reply) => {
    const { elementName } = request.params as { elementName: string };
    const vorgaben = getElementVorgaben(elementName);
    if (!vorgaben) {
      return reply.status(404).send({ error: 'Keine Vorgaben für dieses Element gespeichert.' });
    }
    return reply.send({ vorgaben });
  });

  /*
   * Sensor definitions for an element's vorgaben device (includes units).
   * GET /api/elements/:elementName/vorgaben/sensors
   *
   * From the platform, or from the local cache when it cannot be reached —
   * the element screen labels every Soll value from this, and
   * `useVorgabenSensors` swallows a failure into an empty list, so a 502 here
   * is a screen whose Soll values silently lose their units. The cached
   * *values* have been served locally since the Vorgaben cache went in; this
   * is the half that says what they are called.
   */
  app.get('/api/elements/:elementName/vorgaben/sensors', async (request, reply) => {
    const { elementName } = request.params as { elementName: string };

    try {
      return reply.send(await resolveVorgabenSensors(elementName));
    } catch (err) {
      if (err instanceof SensorDefsUnavailableError) {
        return reply.status(503).send({ error: err.message });
      }
      log.error('vorgaben sensors for %s error: %s', elementName, (err as Error).message);
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  // Post a voice comment to an element's Kommentar string sensor
  app.post('/api/comment/:elementName', async (request, reply) => {
    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    const { elementName } = request.params as { elementName: string };
    const { text } = request.body as { text?: string };

    if (!text || !text.trim()) {
      return reply.status(400).send({ error: 'text is required' });
    }

    try {
      // By resolved device id: the batch endpoint takes `self` or an id, never
      // `name:<element>`. See element-device.ts.
      const data = await withElementDevice(elementName, (deviceId) =>
        fetchImplenia(
          `/api/v1/measuring-device/${deviceId}/readings/batch`,
          {
            method: 'POST',
            body: {
              string_sensors: { Kommentar: text.trim() },
              timestamp: new Date().toISOString(),
            },
          },
        ),
      );
      return reply.send(data);
    } catch (err) {
      log.error('comment for %s error: %s', elementName, (err as Error).message);
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  /*
   * Herstellen (production) sensors = all element sensors − vorgaben sensors.
   * GET /api/elements/:elementName/sensors
   *
   * From the platform, or from the local cache when it cannot be reached —
   * the same resolution a recording start uses, and deliberately the same
   * function, so the two cannot drift apart. This is what the element screens
   * read to know which sensors exist, what they are called and which of them
   * is a hero tile; without it they render nothing at all, because
   * `useHerstellenSensors` swallows the failure and returns an empty list.
   *
   * Note there is no `getApiConfig()` guard any more. A kiosk that was never
   * given API credentials, and works entirely off an imported Schichtauftrag,
   * is exactly the case that needs this to answer.
   */
  app.get('/api/elements/:elementName/sensors', async (request, reply) => {
    const { elementName } = request.params as { elementName: string };

    try {
      const data = await resolveHerstellenSensors(elementName);
      return reply.send(data);
    } catch (err) {
      if (err instanceof SensorDefsUnavailableError) {
        return reply.status(503).send({ error: err.message });
      }
      log.error('sensors for %s error: %s', elementName, (err as Error).message);
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  app.post('/api/elements/:elementName/complete', async (request, reply) => {
    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia-API ist nicht konfiguriert.' });
    }
    const { elementName } = request.params as { elementName: string };

    const completionSensor = findCompletionSensorName();
    if (!completionSensor) {
      return reply.status(404).send({
        error: 'Dieses Verfahren unterstützt keine Fertigmeldung (kein Sensor mit Rolle „is_completed").',
      });
    }

    // A fresh stamp, so implenia-web re-materializes this element's derived
    // values even if it was already completed earlier today.
    const stamp = completionStamp();
    try {
      await writeElementCompletion(elementName, completionSensor, stamp);
      log.info('Element "%s" marked as complete (Ausführungsdatum = %s)', elementName, stamp);
      return reply.send({ ok: true, date: stamp });
    } catch (err) {
      log.error('Failed to mark element "%s" as complete: %s', elementName, (err as Error).message);
      // Wrapped: an upstream message like "Implenia API 502: <html>" reaches
      // the worker's screen, and the rules say what they see has to be German
      // and tell them what to do. The raw text stays for service personnel.
      return reply.status(502).send({
        error:
          'Fertigmeldung fehlgeschlagen. Die Messwerte sind hochgeladen — bitte erneut ' +
          `versuchen, sobald die Verbindung wieder steht. (${(err as Error).message})`,
      });
    }
  });

  app.delete('/api/elements/:elementName/complete', async (request, reply) => {
    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia-API ist nicht konfiguriert.' });
    }
    const { elementName } = request.params as { elementName: string };

    const completionSensor = findCompletionSensorName();
    if (!completionSensor) {
      return reply.status(404).send({
        error: 'Dieses Verfahren unterstützt keine Fertigmeldung (kein Sensor mit Rolle „is_completed").',
      });
    }

    try {
      // Empty string, not null — and dated at the sentinel so it overwrites the
      // date this element was completed with. See element-completion.ts.
      await writeElementCompletion(elementName, completionSensor, '');
      log.info('Element "%s" completion cleared (Ausführungsdatum reset)', elementName);
      return reply.send({ ok: true });
    } catch (err) {
      log.error('Failed to clear completion for element "%s": %s', elementName, (err as Error).message);
      return reply.status(502).send({
        error:
          'Element konnte nicht wiederaufgenommen werden. Es kann trotzdem weiter ' +
          'aufgezeichnet werden — der nächste Upload meldet es erneut fertig. ' +
          `(${(err as Error).message})`,
      });
    }
  });
}

/**
 * Remember the list itself, so an unreachable backend tomorrow still has one.
 *
 * Only ever written from a *successful* platform response: an import has its
 * own storage and the cache must not be overwritten by the list the kiosk is
 * already falling back to, which would keep moving `fetchedAt` forward and
 * make a week-old list claim to be from this morning.
 */
function cacheShiftAssignment(devices: unknown): void {
  const serialised = serialiseShiftCache(devices, Date.now());
  if (!serialised) return;
  try {
    setMeta(SHIFT_CACHE_KEY, serialised);
  } catch (err) {
    log.warn('Could not cache the shift assignment: %s', (err as Error).message);
  }
}

/**
 * Store the vorgaben of every element in a shift assignment.
 *
 * Tolerant by design: a malformed entry is skipped rather than failing the
 * request, because the shift assignment is what the worker needs on screen and
 * the cache only matters later.
 */
function cacheVorgaben(devices: unknown): void {
  if (!Array.isArray(devices)) return;
  for (const device of devices) {
    const name = (device as { name?: unknown })?.name;
    const vorgaben = (device as { vorgaben?: unknown })?.vorgaben;
    if (typeof name !== 'string' || !name || !vorgaben) continue;
    try {
      setElementVorgaben(name, vorgaben);
    } catch (err) {
      log.warn('Could not cache vorgaben for "%s": %s', name, (err as Error).message);
    }
  }
}
