import type { FastifyInstance } from 'fastify';
import { fetchImplenia, getApiConfig, type ApiError } from '../implenia-api.js';
import { fetchHerstellenSensors, type SensorDefs } from '../herstellen-sensors.js';
import { getMeta, setMeta, deleteMeta, setElementVorgaben, getElementVorgaben } from '../db.js';
import { validateShiftImport, resolveShiftAssignment } from '../shift-import.js';
import {
  completionStamp,
  findCompletionSensorName,
  writeElementCompletion,
} from '../element-completion.js';
import { withElementDevice } from '../element-device.js';
import { createLogger } from '../logger.js';

const log = createLogger('implenia');

const IMPORT_KEY = 'imported_shift_assignment';

export function registerImpleniaRoutes(app: FastifyInstance): void {
  // Shift assignment: return import if available, otherwise proxy to API
  app.get('/api/shift-assignment', async (request, reply) => {
    const resolved = resolveShiftAssignment(getMeta(IMPORT_KEY));
    if (resolved) {
      cacheVorgaben(resolved.data.measuring_devices);
      return reply.send({ ...resolved.data, source: resolved.source });
    }

    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    try {
      const data = await fetchImplenia('/shift-assignment/unfinished-elements?include_vorgaben=true') as { unfinished_elements: Array<Record<string, unknown>> };
      cacheVorgaben(data.unfinished_elements);
      return reply.send({ measuring_devices: data.unfinished_elements, source: 'api' });
    } catch (err) {
      const upstream = (err as ApiError).statusCode;
      if (upstream === 404) {
        return reply.status(404).send({ error: 'not_found' });
      }
      log.error('shift-assignment error: %s', (err as Error).message);
      const forwarded = upstream && upstream >= 400 && upstream < 600 ? upstream : 502;
      return reply.status(forwarded).send({ error: (err as Error).message });
    }
  });

  // Import a shift assignment from a JSON file
  app.post('/api/shift-assignment/import', async (request, reply) => {
    const result = validateShiftImport(request.body);
    if (!result.valid) {
      return reply.status(400).send({ error: result.error });
    }
    setMeta(IMPORT_KEY, JSON.stringify(result.data));
    return reply.send({ ok: true });
  });

  // Clear an imported shift assignment
  app.delete('/api/shift-assignment/import', async (_request, reply) => {
    deleteMeta(IMPORT_KEY);
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

  // Proxy: sensor definitions for an element's vorgaben device (includes units)
  // GET /api/elements/:elementName/vorgaben/sensors
  app.get('/api/elements/:elementName/vorgaben/sensors', async (request, reply) => {
    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    const { elementName } = request.params as { elementName: string };

    try {
      const data = await fetchImplenia(
        `/api/v1/measuring-device/self/child/name:${encodeURIComponent(elementName)}/child/name:vorgaben`,
      );
      return reply.send(data);
    } catch (err) {
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

  // Herstellen (production) sensors = all element sensors − vorgaben sensors
  // GET /api/elements/:elementName/sensors
  app.get('/api/elements/:elementName/sensors', async (request, reply) => {
    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    const { elementName } = request.params as { elementName: string };

    try {
      const data = await fetchHerstellenSensors(elementName);
      return reply.send(data);
    } catch (err) {
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
      return reply.status(502).send({ error: (err as Error).message });
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
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
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
