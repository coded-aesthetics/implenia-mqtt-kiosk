import type { FastifyInstance } from 'fastify';
import { getMeta, setMeta, deleteMeta } from '../db.js';
import { getApiConfig } from '../implenia-api.js';
import { config as envConfig } from '../config.js';

export function registerConfigRoutes(app: FastifyInstance): void {
  app.get('/api/config', async (_request, reply) => {
    const cfg = getApiConfig();
    const runtimeUrl = getMeta('implenia_api_url');
    return reply.send({
      hasApiKey: cfg !== null,
      apiUrl: runtimeUrl ?? envConfig.IMPLENIA_API_URL ?? null,
      apiUrlSource: runtimeUrl ? 'runtime' : envConfig.IMPLENIA_API_URL ? 'env' : null,
    });
  });

  app.post('/api/config', async (request, reply) => {
    const { apiKey, apiUrl } = request.body as {
      apiKey?: string;
      apiUrl?: string;
    };

    if (!apiKey || apiKey.trim().length === 0) {
      return reply.status(400).send({ error: 'apiKey is required' });
    }

    setMeta('implenia_api_key', apiKey.trim());
    if (apiUrl && apiUrl.trim().length > 0) {
      setMeta('implenia_api_url', apiUrl.trim());
    }

    console.log('[Config] API key updated via config page');
    return reply.send({ ok: true });
  });

  app.put('/api/config/api-url', async (request, reply) => {
    const { apiUrl } = request.body as { apiUrl?: string };

    if (!apiUrl || apiUrl.trim().length === 0) {
      return reply.status(400).send({ error: 'apiUrl is required' });
    }

    try {
      new URL(apiUrl.trim());
    } catch {
      return reply.status(400).send({ error: 'Ungültige URL' });
    }

    setMeta('implenia_api_url', apiUrl.trim());
    console.log('[Config] API URL updated via config page');
    return reply.send({ ok: true });
  });

  app.delete('/api/config', async (_request, reply) => {
    deleteMeta('implenia_api_key');
    deleteMeta('implenia_api_url');
    console.log('[Config] API key removed via config page');
    return reply.send({ ok: true });
  });
}
