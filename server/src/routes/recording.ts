import type { FastifyInstance } from 'fastify';
import { beginRecording, endRecording, uploadSession, getRecordingState, tryAutoUpload } from '../recording.js';
import {
  getSessions, getSessionById, getSessionStats, getExportedStreams, getSessionReadingsDetailed,
  getSessionReadingCount, setOperatingModeRow, getMostRecentSession, getCompletedElements,
} from '../db.js';
import {
  buildSessionExport,
  getSessionExportStreams,
  isExportableStream,
  recordStreamExport,
} from '../session-export.js';
import { broadcastMessage } from '../websocket.js';
import { ingestion, isOperatingMode } from '../ingestion.js';
import { connectivity } from '../connectivity.js';
import { createLogger } from '../logger.js';

const log = createLogger('recording-routes');

function broadcastUploadProgress(progress: import('../recording.js').UploadProgress): void {
  broadcastMessage({ type: 'upload-progress', ...progress });
}

export function registerRecordingRoutes(app: FastifyInstance): void {
  app.post('/api/recording/start', async (request, reply) => {
    const { elementName } = request.body as { elementName: string };
    if (!elementName) {
      return reply.status(400).send({ error: 'elementName is required' });
    }

    try {
      const result = await beginRecording(elementName);
      // Broadcast new state to all WS clients
      broadcastMessage({ type: 'recording-state', ...getRecordingState() });
      return reply.send(result);
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });

  app.post('/api/recording/stop', async (_request, reply) => {
    try {
      const result = endRecording();
      broadcastMessage({ type: 'recording-state', ...getRecordingState() });

      // Auto-upload in the background — don't block the HTTP response
      const { sessionId } = result;
      if (connectivity.isOnline() && getSessionReadingCount(sessionId) > 0) {
        tryAutoUpload(sessionId, (progress) => {
          broadcastUploadProgress(progress);
        }).then(() => {
          broadcastMessage({ type: 'recording-state', ...getRecordingState() });
        });
      }

      return reply.send(result);
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });

  app.post('/api/recording/:id/upload', async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionId = parseInt(id, 10);
    if (isNaN(sessionId)) {
      return reply.status(400).send({ error: 'Invalid session ID' });
    }

    try {
      const result = await uploadSession(sessionId, broadcastUploadProgress);
      broadcastMessage({ type: 'recording-state', ...getRecordingState() });
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Which streams can be exported for this session (defined for the machine
  // via the CSV Stream column AND with recorded data). Drives the UI buttons.
  app.get('/api/recording/:id/export-options', async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionId = parseInt(id, 10);
    if (isNaN(sessionId)) {
      return reply.status(400).send({ error: 'Ungültige Sitzungs-ID' });
    }
    const exported = new Set(getExportedStreams(sessionId));
    const streams = getSessionExportStreams(sessionId).map((o) => ({
      ...o,
      exported: exported.has(o.stream),
    }));
    return reply.send({ streams });
  });

  app.get('/api/recording/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { stream = 'hdi' } = request.query as { stream?: string };
    const sessionId = parseInt(id, 10);
    if (isNaN(sessionId)) {
      return reply.status(400).send({ error: 'Ungültige Sitzungs-ID' });
    }
    if (!isExportableStream(stream)) {
      return reply.status(400).send({ error: `Stream "${stream}" ist nicht exportierbar` });
    }

    try {
      const { buffer, filename, dataRows } = await buildSessionExport(sessionId, stream);
      if (dataRows > 0) {
        const { remaining } = recordStreamExport(sessionId, stream);
        if (remaining.length > 0) {
          log.info(
            'Session %d: stream %s exported, still missing %s',
            sessionId, stream, remaining.join(', '),
          );
        }
      } else {
        log.warn('Export of session %d (%s) contained no rows — not marked as exported', sessionId, stream);
      }
      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(buffer);
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  /**
   * Switch between drilling and grouting.
   *
   * The worker sets this, mirroring the screen switch they already make on the
   * rig's own UI. It decides whether a closed Klemmbacke means a pipe change
   * (Bohren) or simply a held pipe string (Verpressen).
   */
  app.put<{ Body: { mode?: string; sessionId?: number } }>('/api/recording/mode', async (request, reply) => {
    const mode = request.body?.mode;
    if (!mode || !isOperatingMode(mode)) {
      return reply.status(400).send({ error: 'Bitte einen gültigen Modus angeben (bohren, austausch, einbauen, auffuellen).' });
    }
    if (ingestion.operatingMode) {
      ingestion.setOperatingMode(mode);
      broadcastMessage({ type: 'operating-mode', mode });
      return reply.send({ mode });
    }
    const targetId = request.body?.sessionId;
    const recent = targetId != null
      ? getSessionById(targetId)
      : getMostRecentSession();
    if (recent && (recent.status === 'ended' || recent.status === 'uploading' || recent.status === 'partial')) {
      setOperatingModeRow(recent.id, mode);
      broadcastMessage({ type: 'recording-state', ...getRecordingState() });
      return reply.send({ mode });
    }
    return reply.status(409).send({
      error: 'Es läuft keine Aufzeichnung. Bitte zuerst die Aufzeichnung starten.',
    });
  });

  app.get('/api/recording/state', async (_request, reply) => {
    return reply.send(getRecordingState());
  });

  /**
   * Recorded readings with their drilling phase, newest first — including the
   * clipped ones, which no other read path returns.
   *
   * For service personnel: it shows which readings were clipped as a
   * Rohrwechsel and which reached the upload, without anyone driving to site.
   */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/recording/sessions/:id/readings',
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) {
        return reply.status(400).send({ error: 'Ungültige Aufzeichnungs-ID.' });
      }
      const limit = Math.min(Math.max(Number(request.query.limit) || 500, 1), 5000);
      return reply.send({ sessionId, readings: getSessionReadingsDetailed(sessionId, limit) });
    },
  );

  app.get('/api/recording/sessions', async (_request, reply) => {
    const sessions = getSessions();
    const result = sessions.map((s) => ({
      ...s,
      stats: getSessionStats(s.id),
    }));
    return reply.send(result);
  });

  app.get('/api/recording/completed-elements', async (_request, reply) => {
    return reply.send({ elements: getCompletedElements() });
  });
}
