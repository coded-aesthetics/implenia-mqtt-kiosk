import type { FastifyInstance } from 'fastify';
import { getObservedTopics } from '../db.js';
import { ingestion } from '../ingestion.js';
import { parsePayload } from '../parse-payload.js';
import {
  DEFAULT_CLAMP_TOPIC, getRohrwechselConfig, isClampTopic, setRohrwechselConfig,
  validateRohrwechsel,
} from '../rohrwechsel-config.js';
import { DEPTH_MODES } from '../rohrwechsel.js';
import { createLogger } from '../logger.js';

// Logs as 'config', not as this file's name: /api/logs?module=config is how
// service personnel filter these, and splitting the file must not split that.
const log = createLogger('config');

/** Klemmbacke configuration and the live clamp reading behind it. */
export function registerRohrwechselConfigRoutes(app: FastifyInstance): void {
  /**
   * Klemmbacke handling. Off until a topic is configured — a rig without a
   * clamp signal must keep behaving exactly as it did before this existed.
   */
  app.get('/api/config/rohrwechsel', async () => {
    const cfg = getRohrwechselConfig();
    return {
      ...cfg,
      defaultClampTopic: DEFAULT_CLAMP_TOPIC,
      depthModes: Object.entries(DEPTH_MODES).map(([key, label]) => ({ key, label })),
    };
  });

  /**
   * The live value of the topic being considered as the Klemmbacke signal,
   * matched with the same isClampTopic() the ingestion path uses.
   *
   * Resolved here rather than in the browser on purpose: the settings screen
   * used to carry its own copy of that matching rule, and a drift between the
   * two would show a technician a value the recorder is not actually reading —
   * on the screen whose whole job is confirming the right topic was picked.
   *
   * The topic comes in as a query parameter because the screen previews a
   * topic that is still being typed, before it has been saved.
   */
  app.get<{ Querystring: { topic?: string } }>(
    '/api/config/rohrwechsel/live',
    async (request) => {
      const wanted = request.query.topic?.trim();
      const miss = { topic: null, raw: null, ageMs: null };
      if (!wanted) return miss;

      const now = Date.now();
      // Ordered by topic name, so a wildcard-ish match picks the same one the
      // screen used to pick when it filtered the list itself.
      for (const t of getObservedTopics(now - 5 * 60_000)) {
        if (!isClampTopic(t.topic, wanted)) continue;
        return {
          topic: t.topic,
          raw: parsePayload(t.lastPayload).valueNumeric,
          ageMs: Math.max(0, now - t.lastSeen),
        };
      }
      return miss;
    },
  );

  app.put<{
    Body: {
      clampTopic?: string | null;
      depthMode?: string;
      pipeLength?: number;
      closeThreshold?: number;
      openThreshold?: number;
      tolerance?: number;
    };
  }>('/api/config/rohrwechsel', async (request, reply) => {
    const result = validateRohrwechsel(request.body ?? {});
    if (!result.ok) return reply.status(400).send({ error: result.error });

    setRohrwechselConfig(result.value);
    // A threshold typed while an element is being drilled has to apply to that
    // element, not the next one.
    ingestion.refreshRohrwechselConfig();

    log.info(
      'Rohrverlängerung updated: topic=%s, Tiefe=%s, Rohrlänge=%s m',
      result.value.clampTopic ?? '(aus)', result.value.depthMode, result.value.pipeLength,
    );
    return reply.send({ ...result.value, enabled: result.value.clampTopic !== null });
  });
}
