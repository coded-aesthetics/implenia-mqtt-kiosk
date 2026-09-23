/**
 * Replay control routes.
 *
 * Lets a developer load a captured MQTT dump and replay it through the real
 * pipeline at various speeds, with seek support. Registered exclusively by
 * the standalone replay server (`replay-server.ts`), never by the production
 * kiosk.
 *
 * The replay server runs against :memory: SQLite, so there is no upload
 * session and no API credentials to reach.
 */

import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { replaySource, type ReplaySpeed } from '../replay-source.js';
import { ingestion, type SensorMapEntry } from '../ingestion.js';
import {
  createSession, getActiveSession, endSession,
  getSessionReadingCount, deleteSessionWithReadings,
} from '../db.js';
import { broadcastMessage, setBroadcastSuppressed } from '../websocket.js';
import { createLogger } from '../logger.js';

const log = createLogger('replay-routes');

const VALID_SPEEDS: ReplaySpeed[] = [1, 10, 60, 'max'];

function isValidSpeed(v: unknown): v is ReplaySpeed {
  return v === 1 || v === 10 || v === 60 || v === 'max';
}

/**
 * Start a replay recording session without contacting the Implenia API.
 *
 * The real `beginRecording` fetches sensor definitions from the platform. A
 * replay session uses a static sensor map so it works fully offline: the
 * readings land in SQLite with their topics, but without sensor ids — which
 * is exactly how a live session handles an unresolved topic. The data is
 * still visible in the UI, exportable, and exercises the full pipeline.
 */
function startReplaySession(elementName: string): number {
  const existing = getActiveSession();
  if (existing) {
    // Reuse the existing session rather than failing
    return existing.id;
  }

  const sensorMap = new Map<string, SensorMapEntry>();
  const sessionId = createSession(elementName, JSON.stringify({}));
  ingestion.startRecording(sessionId, sensorMap);
  log.info('Started replay session %d for "%s"', sessionId, elementName);
  return sessionId;
}

function endReplaySession(): void {
  const session = getActiveSession();
  if (session) {
    ingestion.stopRecording();
    endSession(session.id);
    log.info('Ended replay session %d', session.id);
  }
}

function discardReplaySession(): void {
  const session = getActiveSession();
  if (session) {
    ingestion.stopRecording();
    deleteSessionWithReadings(session.id);
    log.info('Discarded replay session %d', session.id);
  }
}

export function registerReplayRoutes(app: FastifyInstance): void {
  // Wire broadcast suppression here (dev-only) so websocket.ts stays clean.
  replaySource.on('fast-forward-start', () => setBroadcastSuppressed(true));
  replaySource.on('fast-forward-end', () => setBroadcastSuppressed(false));

  /**
   * Load a dump file and prepare for replay. Stops any active playback.
   *
   * Body: { file: string } — absolute path, or relative to the project root.
   */
  app.post<{ Body: { file?: string } }>('/api/replay/load', async (request, reply) => {
    const filePath = request.body?.file;
    if (!filePath) {
      return reply.status(400).send({ error: 'Dateipfad fehlt — bitte Pfad zur Dump-Datei angeben' });
    }

    // The server runs from server/, but dump files live at the project root
    // (e.g. assets/bohrung_g8_marktbreit_mqtt.txt). Resolve relative to the
    // project root so the user doesn't have to type "../".
    const projectRoot = path.resolve(process.cwd(), '..');
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);

    if (!fs.existsSync(resolved)) {
      return reply.status(404).send({ error: `Datei nicht gefunden: ${resolved}` });
    }

    // Stop any running replay and session
    replaySource.stop();
    endReplaySession();

    const result = replaySource.load(resolved);

    return reply.send({
      ...result,
      file: resolved,
      durationFormatted: formatDuration(result.durationMs),
    });
  });

  /** Start or resume playback. Starts a recording session if needed. */
  app.post('/api/replay/play', async (_request, reply) => {
    if (replaySource.state.totalMessages === 0) {
      return reply.status(400).send({ error: 'Kein Dump geladen — zuerst eine Datei laden' });
    }

    // Ensure a recording session exists so readings are captured
    const sessionId = startReplaySession('replay');
    replaySource.start();

    broadcastMessage({ type: 'recording-state', active: true, sessionId, elementName: 'replay' });

    return reply.send(replaySource.state);
  });

  /** Pause playback (keeps position). */
  app.post('/api/replay/pause', async (_request, reply) => {
    replaySource.pause();
    return reply.send(replaySource.state);
  });

  /** Set playback speed. Body: { speed: 1 | 10 | 60 | "max" } */
  app.post<{ Body: { speed?: unknown } }>('/api/replay/speed', async (request, reply) => {
    const speed = request.body?.speed;
    if (!isValidSpeed(speed)) {
      return reply.status(400).send({ error: `Geschwindigkeit muss einer der folgenden Werte sein: ${VALID_SPEEDS.join(', ')}` });
    }
    replaySource.setSpeed(speed);
    return reply.send(replaySource.state);
  });

  /**
   * Seek to a point in the dump. Body: { offsetMs: number }
   *
   * Resets the pipeline and fast-forwards from 0 to the target offset at max
   * speed with broadcast suppressed. This is the only correct approach: the
   * pipeline is path-dependent (cumulative volumes, clamp state machine), so
   * the state at any point depends on every message before it.
   */
  app.post<{ Body: { offsetMs?: number } }>('/api/replay/seek', async (request, reply) => {
    const offsetMs = request.body?.offsetMs;
    if (typeof offsetMs !== 'number' || offsetMs < 0) {
      return reply.status(400).send({ error: 'offsetMs muss eine nicht-negative Zahl sein' });
    }

    if (replaySource.state.totalMessages === 0) {
      return reply.status(400).send({ error: 'Kein Dump geladen — zuerst eine Datei laden' });
    }

    const wasPlaying = replaySource.state.playing;

    // 1. Stop playback
    replaySource.pause();

    // 2. Discard the current session and its readings (seek replays from 0)
    discardReplaySession();

    // 3. Reset the source to position 0
    replaySource.reset();

    // 4. Start a fresh recording session
    const sessionId = startReplaySession('replay');

    // 5. Fast-forward to the target. During fast-forward, broadcast is
    //    suppressed (websocket.ts listens to fast-forward-start/end events).
    const count = await replaySource.fastForwardTo(offsetMs);

    // 6. Resume playback if it was running before seek
    if (wasPlaying) {
      replaySource.start();
    }

    broadcastMessage({ type: 'recording-state', active: true, sessionId, elementName: 'replay' });

    return reply.send({
      ...replaySource.state,
      seeked: true,
      messagesReplayed: count,
    });
  });

  /** Stop playback, end the session, and reset to the beginning. */
  app.post('/api/replay/stop', async (_request, reply) => {
    replaySource.stop();
    endReplaySession();
    replaySource.reset();
    broadcastMessage({
      type: 'recording-state', active: false, sessionId: null, elementName: null,
    });
    return reply.send(replaySource.state);
  });

  /** Current replay state. */
  app.get('/api/replay/state', async (_request, reply) => {
    const session = getActiveSession();
    return reply.send({
      ...replaySource.state,
      sessionId: session?.id ?? null,
      readingCount: session ? getSessionReadingCount(session.id) : 0,
    });
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}
