import type { FastifyInstance } from 'fastify';
import { getRecentReadings, getStats } from '../db.js';

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
}
