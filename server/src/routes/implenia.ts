import type { FastifyInstance } from 'fastify';
import { fetchImplenia, getApiConfig, type ApiError } from '../implenia-api.js';
import { fetchHerstellenSensors } from '../herstellen-sensors.js';
import { getMeta, setMeta, deleteMeta } from '../db.js';
import { validateShiftImport, resolveShiftAssignment } from '../shift-import.js';

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
    const { date } = request.query as { date?: string };
    const today = date || new Date().toISOString().split('T')[0];

    try {
      const data = await fetchImplenia(`/shift-assignment?date=${today}&include_vorgaben=true`);
      return reply.send({ ...(data as Record<string, unknown>), source: 'api' });
    } catch (err) {
      const status = (err as ApiError).statusCode;
      if (status === 404) {
        return reply.status(404).send({ error: 'not_found', date: today });
      }
      console.error('[Implenia] shift-assignment error:', (err as Error).message);
      return reply.status(502).send({ error: (err as Error).message });
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
      console.error(`[Implenia] vorgaben sensors for ${elementName} error:`, (err as Error).message);
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
      console.error(`[Implenia] sensors for ${elementName} error:`, (err as Error).message);
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
}
