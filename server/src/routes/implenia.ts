import type { FastifyInstance } from 'fastify';
import { fetchImplenia, getApiConfig, type ApiError } from '../implenia-api.js';
import { fetchHerstellenSensors } from '../herstellen-sensors.js';

export function registerImpleniaRoutes(app: FastifyInstance): void {
  // Proxy: shift assignment for today (or given date)
  app.get('/api/shift-assignment', async (request, reply) => {
    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    const { date } = request.query as { date?: string };
    const today = date || new Date().toISOString().split('T')[0];

    try {
      const data = await fetchImplenia(`/shift-assignment?date=${today}`);
      return reply.send(data);
    } catch (err) {
      const status = (err as ApiError).statusCode;
      if (status === 404) {
        return reply.status(404).send({ error: 'not_found', date: today });
      }
      console.error('[Implenia] shift-assignment error:', (err as Error).message);
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  // Proxy: vorgabe (specification) parameters for an element
  // GET /api/elements/:elementName/vorgaben
  app.get('/api/elements/:elementName/vorgaben', async (request, reply) => {
    if (!getApiConfig()) {
      return reply.status(503).send({ error: 'Implenia API not configured' });
    }
    const { elementName } = request.params as { elementName: string };

    try {
      const data = await fetchImplenia(
        `/api/v1/measuring-device/self/child/name:${encodeURIComponent(elementName)}/child/name:vorgaben/sensors/latest`,
      );
      return reply.send(data);
    } catch (err) {
      console.error(`[Implenia] vorgaben for ${elementName} error:`, (err as Error).message);
      return reply.status(502).send({ error: (err as Error).message });
    }
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
      const encoded = encodeURIComponent(elementName);
      const data = await fetchImplenia(
        `/api/v1/measuring-device/name:${encoded}/readings/batch`,
        {
          method: 'POST',
          body: {
            string_sensors: { Kommentar: text.trim() },
            timestamp: new Date().toISOString(),
          },
        },
      );
      return reply.send(data);
    } catch (err) {
      console.error(`[Implenia] comment for ${elementName} error:`, (err as Error).message);
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
