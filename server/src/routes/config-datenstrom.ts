import type { FastifyInstance } from 'fastify';
import { applyCalibration, getCalibrationMap, NEUTRAL } from '../calibration.js';
import { getObservedTopics, getTopicHistory } from '../db.js';
import { reduceToGrid } from '../grid-reduce.js';
import { parsePayload } from '../parse-payload.js';
import { isClampTopic, getRohrwechselConfig } from '../rohrwechsel-config.js';
import { getActiveVerfahren, loadSensorCsv } from '../sensor-meta.js';
import { splitTopic } from '../topic-grouping.js';
import {
  getResolverContext, resolveBoundBy, resolveSensorKey, type BoundBy,
} from '../topic-resolver.js';

/**
 * The Datenstrom screen: what the box is actually sending.
 *
 * Every other view of this data is filtered by something — the calibration
 * screen by the Verfahren's sensor list, the Sensorzuordnung by one sensor at a
 * time. This one is spined on `mqtt_buffer`, which is written before any sensor
 * mapping is attempted, so a topic that resolves to nothing is as visible as
 * one that resolves correctly. That is the whole point: an unresolved topic
 * still displays live and is never uploaded, and nothing else says so.
 */

/**
 * How far back a topic counts as "seen". Deliberately longer than the five
 * minutes every other view uses.
 *
 * At five minutes a pump that stopped publishing six minutes ago *disappears
 * from the list* rather than reading as dead, which is the same failure as a
 * gauge frozen at its last value. An hour is long enough to diagnose a channel
 * that dropped out over a break and short enough that a previous rig's topics
 * do not present themselves as current.
 */
const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 60;

/**
 * What an hour costs, and why the screen polls this slowly.
 *
 * Measured against a seeded buffer at the captured rig's publish rates
 * (14 topics, ten at ~290 ms and four at ~3 s), 24 h of retention being
 * 3.09 million rows:
 *
 * | 3.09M rows                  | overview (60 min) | history (10 min) |
 * | no index on `topic`         |  73 ms            | 9.1 ms           |
 * | index on (topic,received_at)| 129 ms            | 2.8 ms           |
 *
 * **The obvious index makes this query worse**, which is why `mqtt_buffer` does
 * not have one. Without it SQLite answers with
 * `SEARCH … USING idx_mqtt_buffer_time (received_at>?)` — a seek bounded to the
 * window, so the cost is flat in the size of the buffer (73 ms at 24 h, 68 ms
 * at 1 h). With it the optimiser prefers
 * `SCAN … USING COVERING INDEX idx_mqtt_buffer_topic_time`, **loses the time
 * bound** and walks all 3.09M rows. It also takes 1.4 s to build, which a
 * kiosk would pay on the first start after the update.
 *
 * 73 ms on a developer machine is some 300–400 ms on the J1900 this runs on,
 * and `better-sqlite3` is synchronous — so every poll of this is time the
 * event loop is not broadcasting readings. The screen therefore polls the
 * *inventory* at this interval and takes the live values off the WebSocket it
 * is already connected to, which is both cheaper and more responsive than
 * polling at 3 s like the screen it replaces.
 */
export const POLL_INTERVAL_MS = 10_000;

/** The chart's default span, and the most it will serve — see `getTopicHistory`. */
const DEFAULT_HISTORY_MINUTES = 10;
const MAX_HISTORY_MINUTES = 60;

/**
 * One second, matching the resolution `SensorChart` aligns its series to. A
 * finer grid would be points the chart throws away again.
 */
const HISTORY_BUCKET_MS = 1000;

export interface DatenstromChannel {
  topic: string;
  /**
   * The group the screen shows this under, and the name it shows in it. Split
   * server-side because a resolved sensor name is what makes the split correct
   * — see `topic-grouping.ts`.
   */
  prefix: string;
  leaf: string;
  /**
   * The payload exactly as it arrived. `nan` is a real value on the rig
   * (`Bohrgeraet/Klemmdruck` in the G08 capture) and the screen prints it
   * verbatim — the numeric field below is null for it, which is not the same
   * thing as zero.
   */
  lastPayload: string;
  lastSeen: number;
  ageMs: number;
  /** Messages seen inside the window. */
  count: number;
  /** The sensor this topic feeds, in the CSV's own spelling, or null. */
  sensor: string | null;
  boundBy: BoundBy;
  unit: string;
  /** CSV `Typ`. Only a `Double` can carry a calibration. */
  type: string;
  /** CSV `Quelle`. */
  source: string;
  scale: number;
  offset: number;
  raw: number | null;
  calibrated: number | null;
  /**
   * Whether this is the configured Klemmbacke signal. It is not a sensor of any
   * Verfahren, so without this it reads as unassigned and invites a technician
   * to wire it to something — and it is deliberately never calibrated.
   */
  isClamp: boolean;
}

/** An MQTT sensor of this Verfahren that nothing is currently feeding. */
export interface DatenstromMissing {
  sensor: string;
  unit: string;
  type: string;
  scale: number;
  offset: number;
}

function clampMinutes(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw ?? '');
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.ceil(n), max);
}

/** Broker traffic, joined with what the kiosk makes of it. */
export function registerDatenstromRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { minutes?: string } }>(
    '/api/config/datenstrom',
    async (request) => {
      const minutes = clampMinutes(
        request.query.minutes, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES,
      );
      const windowMs = minutes * 60_000;
      const now = Date.now();

      const verfahren = getActiveVerfahren();
      const rows = verfahren ? loadSensorCsv(verfahren) ?? [] : [];
      const byKey = new Map(rows.map((r) => [r.name.trim().toLowerCase(), r]));
      const stored = getCalibrationMap();
      const ctx = getResolverContext();
      const clampTopic = getRohrwechselConfig().clampTopic;

      const fed = new Set<string>();
      const channels: DatenstromChannel[] = getObservedTopics(now - windowMs).map((t) => {
        const boundBy = resolveBoundBy(t.topic, ctx);
        // The key comes from `resolveSensorKey` and not from `boundBy`, so this
        // screen can never disagree with the live path about which sensor a
        // topic feeds. `boundBy` only says which layer answered — and `'none'`
        // is what tells us the key is that function's bare segment fallback,
        // which no sensor need be called.
        const key = boundBy === 'none' ? null : resolveSensorKey(t.topic, ctx);
        const row = key ? byKey.get(key) : undefined;
        if (row) fed.add(row.name.trim().toLowerCase());

        const cal = (row ? stored.get(row.name.trim().toLowerCase()) : undefined) ?? NEUTRAL;
        const raw = parsePayload(t.lastPayload).valueNumeric;

        const split = splitTopic(t.topic, row?.name ?? null);

        return {
          topic: t.topic,
          prefix: split.prefix,
          leaf: split.leaf,
          lastPayload: t.lastPayload,
          lastSeen: t.lastSeen,
          ageMs: Math.max(0, now - t.lastSeen),
          count: t.count,
          // The CSV's spelling, never the lowercased key: the key is what a
          // lookup needs and the name is what a human reads and what a write
          // is addressed to.
          sensor: row?.name ?? null,
          boundBy: row ? boundBy : 'none',
          unit: row?.unit ?? '',
          type: row?.type.trim() ?? '',
          source: row?.source ?? '',
          scale: cal.scale,
          offset: cal.offset,
          raw,
          calibrated: raw === null ? null : applyCalibration(raw, cal),
          isClamp: isClampTopic(t.topic, clampTopic),
        };
      });

      /**
       * Only `mqtt` sensors, not every `Double`.
       *
       * This list exists so a channel that is not arriving can still be opened
       * — a technician preparing a kiosk in the office can set a factor they
       * already know before the machine ever runs. Widening it to every `Double`
       * is what puts DSV's 37 derived values (`Startpunkt X Ist`, `Azimut`,
       * `Mittlere Drehzahl`, the volume integrations) on the screen, none of
       * which has a raw value to compare against anything.
       */
      const missing: DatenstromMissing[] = rows
        .filter((r) => r.source === 'mqtt' && !fed.has(r.name.trim().toLowerCase()))
        .map((r) => {
          const cal = stored.get(r.name.trim().toLowerCase()) ?? NEUTRAL;
          return {
            sensor: r.name,
            unit: r.unit,
            type: r.type.trim(),
            scale: cal.scale,
            offset: cal.offset,
          };
        });

      return { verfahren, windowMs, channels, missing };
    },
  );

  /**
   * One topic's recent history, for the detail view's chart.
   *
   * Reduced with the session grid reducer rather than a second implementation
   * of the same rule: **the last value in each bucket, dated at a real
   * reading's instant**. A mean would invent numbers the rig never reported —
   * `Klemmdruck` is bimodal at ~1650 open / ~4200 closed and its mean lands in
   * a band the clamp cannot produce, and `Tiefe` steps by a whole Bohrrohr.
   * `maxHoldMs: 0` keeps a gap a gap: this draws what arrived, and a channel
   * that went quiet has to look quiet.
   */
  app.get<{ Querystring: { topic?: string; minutes?: string } }>(
    '/api/config/datenstrom/history',
    async (request, reply) => {
      const topic = request.query.topic?.trim();
      if (!topic) {
        return reply.status(400).send({ error: 'Es wurde kein Topic angegeben.' });
      }
      const minutes = clampMinutes(
        request.query.minutes, DEFAULT_HISTORY_MINUTES, MAX_HISTORY_MINUTES,
      );
      const to = Date.now();
      const from = to - minutes * 60_000;

      const readings = getTopicHistory(topic, from, to).map((r) => ({
        key: topic,
        receivedAt: r.received_at,
        value: parsePayload(r.payload).valueNumeric,
      }));

      const points = reduceToGrid(readings, { bucketMs: HISTORY_BUCKET_MS, maxHoldMs: 0 })
        .map((row) => ({ ts: row.at, value: row.values.get(topic) ?? null }))
        // A null is a reading the sensor had nothing to report for. It bounds
        // the chart's line rather than drawing through it, so it is dropped
        // here and the gap in the x values is what the chart renders.
        .filter((p): p is { ts: number; value: number } => typeof p.value === 'number');

      return { topic, from, to, bucketMs: HISTORY_BUCKET_MS, points };
    },
  );
}
