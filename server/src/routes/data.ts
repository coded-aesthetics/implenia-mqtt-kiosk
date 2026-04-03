import type { FastifyInstance } from 'fastify';
import { updater } from '../updater.js';

export function registerDataRoutes(app: FastifyInstance): void {
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
