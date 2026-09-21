import type { FastifyInstance } from 'fastify';
import { beginRecording, endRecording, uploadSession, getRecordingState } from '../recording.js';
import { getSessions, getSessionStats, getExportedStreams } from '../db.js';
import {
  buildSessionExport,
  getSessionExportStreams,
  isExportableStream,
  recordStreamExport,
} from '../session-export.js';
import { broadcastMessage } from '../websocket.js';
import { createLogger } from '../logger.js';

const log = createLogger('recording-routes');

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
      const result = await uploadSession(sessionId, (progress) => {
        broadcastMessage({ type: 'upload-progress', ...progress });
      });
      // Broadcast final recording state
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
      // Only a file that actually contains readings counts as the data having
      // left the kiosk. A verfahren with no streams defined yields a
      // header-only file, and marking that "exported" would let the reset
      // guard discard data nobody ever saved.
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

  app.get('/api/recording/state', async (_request, reply) => {
    return reply.send(getRecordingState());
  });

  app.get('/api/recording/sessions', async (_request, reply) => {
    const sessions = getSessions();
    const result = sessions.map((s) => ({
      ...s,
      stats: getSessionStats(s.id),
    }));
    return reply.send(result);
  });
}
