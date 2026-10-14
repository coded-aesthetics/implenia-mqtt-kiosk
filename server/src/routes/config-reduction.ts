import type { FastifyInstance } from 'fastify';
import {
  GRANULARITIES, UPLOAD_MODES, getReductionConfig, holdMsFor, setReductionConfig,
  validateReduction, type ReductionInput,
} from '../reduction-config.js';
import { CHUNK_ROWS } from '../csv-upload.js';
import { createLogger } from '../logger.js';

// Logs as 'config', not as this file's name: /api/logs?module=config is how
// service personnel filter these, and splitting the file must not split that.
const log = createLogger('config');

/** How much a recording is reduced on its way out, and by which route. */
export function registerReductionConfigRoutes(app: FastifyInstance): void {
  app.get('/api/config/datenuebertragung', async () => {
    const cfg = getReductionConfig();
    return {
      ...cfg,
      holdMs: holdMsFor(cfg.uploadBucketMs),
      rowsPerChunk: CHUNK_ROWS,
      granularities: GRANULARITIES,
      uploadModes: Object.entries(UPLOAD_MODES).map(([key, label]) => ({ key, label })),
    };
  });

  app.post<{ Body: ReductionInput }>('/api/config/datenuebertragung', async (request, reply) => {
    const result = validateReduction(request.body ?? {});
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }
    setReductionConfig(result.value);
    log.info(
      'Datenübertragung: Export %d ms, Upload %d ms, Modus %s',
      result.value.exportBucketMs, result.value.uploadBucketMs, result.value.uploadMode,
    );
    return { ok: true, ...result.value };
  });
}
