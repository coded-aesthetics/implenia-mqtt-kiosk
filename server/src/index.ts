import Fastify, { type FastifyBaseLogger } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { config } from './config.js';
import { createLogger, logger } from './logger.js';
import { connectivity } from './connectivity.js';
import { ingestion } from './ingestion.js';
import { setupWebSocket, stopWebSocket } from './websocket.js';
import { updater } from './updater.js';
import { registerDataRoutes } from './routes/data.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerImpleniaRoutes } from './routes/implenia.js';
import { registerRecordingRoutes } from './routes/recording.js';
import { ensureLogSensor } from './recording.js';
import { registerLogRoutes } from './routes/logs.js';
import { close as closeDb } from './db.js';

const log = createLogger('server');

const app = Fastify({ loggerInstance: logger as FastifyBaseLogger });

async function start(): Promise<void> {
  // Register plugins
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } });

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
  registerLogRoutes(app);
  setupWebSocket(app);

  // SPA fallback: serve index.html for unmatched routes
  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile('index.html');
  });

  // Start services
  connectivity.start();
  ingestion.start();
  updater.start();
  ensureLogSensor().catch(() => {});

  // Start HTTP server
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info('Listening on http://0.0.0.0:%d', config.PORT);
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  log.info('Received %s, shutting down...', signal);
  updater.stop();
  stopWebSocket();
  ingestion.stop();
  connectivity.stop();
  await app.close();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  log.fatal(err, 'Fatal error');
  process.exit(1);
});
