import type { FastifyInstance } from 'fastify';
import { connectivity } from '../connectivity.js';
import { mqttClient } from '../mqtt.js';
import { updater } from '../updater.js';
import { getStats } from '../db.js';

const startTime = Date.now();

export function registerStatusRoutes(app: FastifyInstance): void {
  app.get('/status', async (_request, reply) => {
    const pkg = await import('../../package.json', { with: { type: 'json' } });

    return reply.send({
      version: pkg.default.version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      connectivity: connectivity.getState(),
      mqttConnected: mqttClient.connected,
      queue: getStats(),
      updateAvailable: updater.updateAvailable !== null,
    });
  });
}
