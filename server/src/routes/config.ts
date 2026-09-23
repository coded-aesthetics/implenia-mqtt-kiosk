import type { FastifyInstance } from 'fastify';
import { getMeta, setMeta, deleteMeta, getUnsafeDataSummary, resetKiosk } from '../db.js';
import { getApiConfig, fetchImplenia } from '../implenia-api.js';
import { config as envConfig } from '../config.js';
import { ingestion, DataIngestion } from '../ingestion.js';
import { deviceSource } from '../device-source.js';
import { abortRecording } from '../recording.js';
import { clearCalibrationCache } from '../calibration.js';
import { clearResolverCache } from '../topic-resolver.js';
import {
  TRANSPORTS, getTransport, isTransportConfigured, isValidTransport, setTransport,
  TransportAlreadySetError, clearTransportCache,
} from '../transport.js';
import { clearVerfahrenCache } from '../sensor-meta.js';
import { createLogger } from '../logger.js';
import { registerMqttConfigRoutes } from './config-mqtt.js';
import { registerRohrwechselConfigRoutes } from './config-rohrwechsel.js';
import { registerCalibrationRoutes } from './config-calibration.js';
import { registerTopicOverrideRoutes } from './config-topics.js';

// Logs as 'config', not as this file's name: /api/logs?module=config is how
// service personnel filter these, and splitting the file must not split that.
const log = createLogger('config');

/**
 * The /api/config surface.
 *
 * What stays here is what the kiosk is: its Implenia credentials, its
 * transport, and the reset that returns it to a blank machine. The parts that
 * configure one subsystem each live beside this file and are registered below,
 * so this stays a map of the surface rather than all of it.
 */
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

  // ── Transport ───────────────────────────────────────────────────────────

  app.get('/api/config/transport', async () => {
    const transport = getTransport();
    return {
      transport,
      label: TRANSPORTS[transport],
      // False until the wizard actually asked — the value is a default, not a
      // choice, and the UI should say so.
      configured: isTransportConfigured(),
      available: Object.entries(TRANSPORTS).map(([key, label]) => ({ key, label })),
    };
  });

  // Write-once, like the Verfahren — see transport.ts.
  app.put<{ Body: { transport?: string } }>(
    '/api/config/transport',
    async (request, reply) => {
      const transport = request.body?.transport;
      if (!transport || !isValidTransport(transport)) {
        return reply.status(400).send({
          error: 'Bitte eine gültige Datenquelle wählen: ' + Object.values(TRANSPORTS).join(' oder ') + '.',
        });
      }

      try {
        setTransport(transport);
      } catch (err) {
        if (err instanceof TransportAlreadySetError) {
          return reply.status(409).send({
            error:
              `Die Datenquelle ist bereits auf „${TRANSPORTS[err.current]}" festgelegt ` +
              'und kann nicht geändert werden. Um eine andere Datenquelle zu wählen, ' +
              'muss die Software zurückgesetzt werden.',
            current: err.current,
          });
        }
        throw err;
      }

      // Swap the live source so the choice takes effect without a restart.
      ingestion.setSource(DataIngestion.sourceFor(transport));

      return reply.send({ transport, label: TRANSPORTS[transport] });
    },
  );

  // ── Reset ───────────────────────────────────────────────────────────────

  app.get('/api/config/reset', async () => {
    const unsafe = getUnsafeDataSummary();
    return {
      allowed: unsafe.readings === 0,
      unsafe,
      preserves: ['API-Schlüssel', 'Server-Adresse'],
    };
  });

  app.post('/api/config/reset', async (_request, reply) => {
    const unsafe = getUnsafeDataSummary();
    if (unsafe.readings > 0) {
      // Refusing, not warning: losing recorded measurements is the one
      // outcome this software must never produce.
      return reply.status(409).send({
        error:
          `Zurücksetzen nicht möglich: ${unsafe.readings} Messwerte aus ` +
          `${unsafe.sessions} Aufzeichnung(en) sind weder hochgeladen noch exportiert. ` +
          'Bitte zuerst hochladen oder als Datei exportieren.',
        unsafe,
      });
    }

    // Detach the live recording *before* its session row disappears. An
    // ingestion layer still pointing at a deleted session writes readings
    // against a missing parent, and that foreign-key error is thrown from the
    // source's synchronous handler — it would kill the process as soon as the
    // next message arrived.
    abortRecording();

    resetKiosk();
    // In-memory caches would otherwise keep serving the old setup; clearing
    // them here is why the in-app reset needs no restart.
    clearVerfahrenCache();
    clearTransportCache();
    clearResolverCache();
    clearCalibrationCache();
    deviceSource.clearMappingCache();
    ingestion.setSource(DataIngestion.sourceFor(getTransport()));
    // setSource is a no-op when the transport is unchanged (the common case),
    // so cycle the source explicitly: otherwise the MQTT client keeps the old
    // site's connection and subscription, and the restarted wizard lists
    // topics from a broker this kiosk is no longer being set up for.
    ingestion.restartSource();

    log.info('Kiosk setup reset');
    return reply.send({ ok: true });
  });

  app.delete('/api/config/api-key', async (_request, reply) => {
    deleteMeta('implenia_api_key');
    log.info('API key removed via config page');
    return reply.send({ ok: true });
  });

  // ── Subsystems ──────────────────────────────────────────────────────────

  registerMqttConfigRoutes(app);
  registerRohrwechselConfigRoutes(app);
  registerCalibrationRoutes(app);
  registerTopicOverrideRoutes(app);
}
