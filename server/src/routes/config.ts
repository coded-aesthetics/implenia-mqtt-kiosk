import type { FastifyInstance } from 'fastify';
import { getMeta, setMeta, deleteMeta } from '../db.js';
import { getApiConfig, fetchImplenia } from '../implenia-api.js';
import { config as envConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('config');

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

    log.info('API key updated via config page');
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
    log.info('API URL updated via config page');
    return reply.send({ ok: true });
  });

  app.get('/api/config/validate', async (_request, reply) => {
    const cfg = getApiConfig();
    if (!cfg) {
      return reply.send({ ok: false, error: 'API-Schlüssel oder Server-Adresse nicht konfiguriert' });
    }

    try {
      const data = await fetchImplenia<{ name?: string }>('/api/v1/measuring-device/self');
      log.info('API validation: device check ok: %s', data.name ?? 'unnamed');

      // Verify this device can receive shift assignments (200 or 404 are acceptable)
      const today = new Date().toISOString().split('T')[0];
      try {
        await fetchImplenia(`/shift-assignment?date=${today}`);
      } catch (shiftErr) {
        const status = (shiftErr as import('../implenia-api.js').ApiError).statusCode;
        if (status !== 404) {
          log.warn('API validation: shift-assignment probe failed for %s: %s', data.name, (shiftErr as Error).message);
          return reply.send({
            ok: false,
            error: 'wrong_device_type',
            deviceName: data.name ?? null,
          });
        }
      }

      log.info('API validation successful: %s', data.name ?? 'unnamed');
      return reply.send({ ok: true, deviceName: data.name ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('API validation failed: %s', message);
      if (message.includes('401') || message.includes('403')) {
        return reply.send({ ok: false, error: 'Ungültiger API-Schlüssel' });
      }
      return reply.send({ ok: false, error: `Verbindung fehlgeschlagen: ${message}` });
    }
  });

  app.delete('/api/config/api-key', async (_request, reply) => {
    deleteMeta('implenia_api_key');
    log.info('API key removed via config page');
    return reply.send({ ok: true });
  });
}
