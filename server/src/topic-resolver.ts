import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTopicOverrides } from './db.js';
import { getActiveVerfahren } from './sensor-meta.js';
import { createLogger } from './logger.js';

const log = createLogger('topic-resolver');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOPIC_MAPS_DIR = path.join(__dirname, '..', 'assets', 'topic-maps');

/**
 * Resolving an MQTT topic to a sensor name.
 *
 * The recording sensor map is keyed by lowercased sensor name. A topic only
 * finds it directly when the topic's last segment happens to equal that name,
 * which is the lucky case. Two lookup layers sit in front of it:
 *
 *   1. `topic_overrides` — what a technician wired on site (highest priority)
 *   2. `assets/topic-maps/<verfahren>.json` — shipped with the release
 *   3. the topic segment itself — the no-configuration case
 *
 * Overrides win so a stale shipped map can never override a human decision.
 *
 * An unresolved topic is not an error here: it is still buffered and shown
 * live. It is simply never uploaded, which is exactly the silent failure the
 * assignment screen exists to make visible.
 */

export interface ResolverContext {
  /** Full topic or last segment → sensor name. From the DB. */
  overrides: Map<string, string>;
  /** Full topic or last segment → sensor name. From the shipped asset. */
  topicMap: Map<string, string>;
}

/** Last path segment of a topic, lowercased. Mirrors the sensor-map key. */
export function topicSegment(topic: string): string {
  return topic.split('/').pop()?.toLowerCase() ?? '';
}

/**
 * The key to look up in the recording sensor map (a lowercased sensor name),
 * or null when the topic cannot be resolved at all.
 */
export function resolveSensorKey(topic: string, ctx: ResolverContext): string | null {
  const full = topic.toLowerCase();
  const segment = topicSegment(topic);

  for (const source of [ctx.overrides, ctx.topicMap]) {
    const hit = source.get(full) ?? source.get(segment);
    if (hit) return hit.toLowerCase();
  }

  return segment || null;
}

/** Parse a topic-map asset. Invalid entries are dropped, not fatal. */
export function parseTopicMap(json: string): Map<string, string> {
  const map = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    log.error('Topic map is not valid JSON — ignoring it');
    return map;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.error('Topic map must be a JSON object — ignoring it');
    return map;
  }
  for (const [topic, sensorName] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof sensorName !== 'string' || !sensorName.trim()) {
      log.warn('Topic map entry "%s" has no sensor name — ignoring it', topic);
      continue;
    }
    map.set(topic.toLowerCase(), sensorName.trim());
  }
  return map;
}

export function loadTopicMap(verfahren: string): Map<string, string> {
  const file = path.join(TOPIC_MAPS_DIR, `${verfahren}.json`);
  try {
    return parseTopicMap(fs.readFileSync(file, 'utf-8'));
  } catch {
    // No shipped map for this Verfahren yet — normal, not an error.
    return new Map();
  }
}

// Overrides can be wired while a session is running, so the context is cached
// with a short TTL rather than snapshotted at recording start.
const CONTEXT_TTL_MS = 5_000;
let cached: { ctx: ResolverContext; builtAt: number } | null = null;

export function getResolverContext(): ResolverContext {
  if (cached && Date.now() - cached.builtAt < CONTEXT_TTL_MS) return cached.ctx;

  const verfahren = getActiveVerfahren();
  const ctx: ResolverContext = {
    overrides: new Map(
      getTopicOverrides().map((o) => [o.topic.toLowerCase(), o.sensorName]),
    ),
    topicMap: verfahren ? loadTopicMap(verfahren) : new Map(),
  };
  cached = { ctx, builtAt: Date.now() };
  return ctx;
}

/** Drop the cache so the next reading sees a just-written override. */
export function clearResolverCache(): void {
  cached = null;
}
