import type { FastifyInstance } from 'fastify';
import { getLogEntries } from '../logger.js';

export function registerLogRoutes(app: FastifyInstance): void {
  app.get('/api/logs', async (request, reply) => {
    const { limit, level, module } = request.query as {
      limit?: string;
      level?: string;
      module?: string;
    };

    const parsed = limit ? parseInt(limit, 10) : undefined;
    return reply.send(
      getLogEntries({
        limit: parsed && !isNaN(parsed) ? parsed : undefined,
        level,
        module,
      }),
    );
  });
}
