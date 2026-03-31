import type { FastifyInstance } from 'fastify';
import { getRecentReadings, getStats } from '../db.js';
import { updater } from '../updater.js';

export function registerDataRoutes(app: FastifyInstance): void {
  app.get('/api/readings', async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const readings = getRecentReadings(limit ? parseInt(limit, 10) : 100);
    return reply.send(readings);
  });

  app.get('/api/stats', async (_request, reply) => {
    const stats = getStats();
    return reply.send(stats);
  });

  app.post('/api/update', async (_request, reply) => {
    if (!updater.updateAvailable) {
      return reply.status(404).send({ error: 'No update available' });
    }
    // Trigger download + apply in background
    updater.downloadAndApply().catch((err) => {
      console.error('[Updater] downloadAndApply error:', err);
    });
    return reply.send({ status: 'applying', version: updater.updateAvailable });
  });
}
