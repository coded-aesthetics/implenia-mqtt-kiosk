import type { FastifyInstance } from 'fastify';
import { fetchImplenia, getApiConfig, type ApiError } from '../implenia-api.js';
import { fetchHerstellenSensors } from '../herstellen-sensors.js';
import { getMeta, setMeta, deleteMeta } from '../db.js';
import { validateShiftImport, resolveShiftAssignment } from '../shift-import.js';
import { createLogger } from '../logger.js';

const log = createLogger('implenia');

const IMPORT_KEY = 'imported_shift_assignment';

export function registerImpleniaRoutes(app: FastifyInstance): void {
  // Shift assignment: return import if available, otherwise proxy to API
  app.get('/api/shift-assignment', async (request, reply) => {
    const resolved = resolveShiftAssignment(getMeta(IMPORT_KEY));
    if (resolved) {
      return reply.send({ ...resolved.data, source: resolved.source });
    }

    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    try {
      const data = await fetchImplenia('/shift-assignment/unfinished-elements?include_vorgaben=true') as { unfinished_elements: Array<Record<string, unknown>> };
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
}
