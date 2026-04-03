import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { config } from './config.js';
import { connectivity } from './connectivity.js';
import { mqttClient } from './mqtt.js';
import { setupWebSocket, stopWebSocket } from './websocket.js';
import { updater } from './updater.js';
import { registerDataRoutes } from './routes/data.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerImpleniaRoutes } from './routes/implenia.js';
import { registerRecordingRoutes } from './routes/recording.js';
import { close as closeDb } from './db.js';

const app = Fastify({
  logger: config.NODE_ENV === 'development',
});

async function start(): Promise<void> {
  // Register plugins
  await app.register(fastifyWebsocket);

  // Serve the built UI in production
  const uiDistPath = path.join(process.cwd(), 'ui', 'dist');
  await app.register(fastifyStatic, {
    root: uiDistPath,
    prefix: '/',
    wildcard: false,
  });

  // Register routes
  registerDataRoutes(app);
  registerStatusRoutes(app);
  registerConfigRoutes(app);
  registerImpleniaRoutes(app);
  registerRecordingRoutes(app);
  setupWebSocket(app);

  // SPA fallback: serve index.html for unmatched routes
  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile('index.html');
  });

  // Start services
  connectivity.start();
  mqttClient.start();
  updater.start();

  // Start HTTP server
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`[Server] Listening on http://0.0.0.0:${config.PORT}`);
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Server] Received ${signal}, shutting down...`);
  updater.stop();
  stopWebSocket();
  mqttClient.stop();
  connectivity.stop();
  await app.close();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
