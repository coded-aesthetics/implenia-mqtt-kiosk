import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { connectivity } from '../connectivity.js';
import { mqttClient } from '../mqtt.js';
import { updater } from '../updater.js';
import { getStats } from '../db.js';

const startTime = Date.now();

function getVersion(): string {
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

export function registerStatusRoutes(app: FastifyInstance): void {
  app.get('/status', async (_request, reply) => {
    return reply.send({
      version: getVersion(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      connectivity: connectivity.getState(),
      mqttConnected: mqttClient.connected,
      queue: getStats(),
      updateAvailable: updater.updateAvailable !== null,
    });
  });
}
