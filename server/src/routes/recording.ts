import type { FastifyInstance } from 'fastify';
import { beginRecording, endRecording, uploadSession, getRecordingState, tryAutoUpload } from '../recording.js';
import {
  getSessions, getSessionById, getSessionStats, getExportedStreams, getSessionReadingsDetailed,
  getSessionReadingCount, setOperatingModeRow, getMostRecentSession, getCompletedElements,
  unclipSessionReadings, getActiveSession, setDrillingEndedAt, setGeologyConfirmedAt,
} from '../db.js';
import {
  commitDefaultGeology, commitGeology, getGeologyContext, recordLiveLayer,
  type GeologyCommitResult, type GeologyLayerInput,
} from '../geology.js';
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

/**
 * Read a geology profile out of a request body, keeping whatever is usable.
 *
 * Deliberately lenient. A stop must never be refused over its geology: the
 * operator would be left on a confirmation screen that will not close, with a
 * shift of measurements trapped behind it — a dead end, which this software
 * does not get to have. A malformed body therefore costs the geology and
 * nothing else, and says so in the response.
 */
function readGeologyBody(
  body: unknown,
): { layers: GeologyLayerInput[]; hinweis?: string } {
  const raw = (body as { geology?: unknown } | null | undefined)?.geology;
  if (raw === undefined || raw === null) return { layers: [] };
  if (!Array.isArray(raw)) {
    return {
      layers: [],
      hinweis: 'Das Geologieprofil wurde nicht in der erwarteten Form übermittelt '
        + 'und konnte nicht gespeichert werden. Die Messwerte sind vollständig.',
    };
  }

  const layers: GeologyLayerInput[] = [];
  let verworfen = 0;
  for (const entry of raw) {
    const l = entry as Record<string, unknown>;
    const tiefe = typeof l?.tiefe === 'number' ? l.tiefe : Number(l?.tiefe);
    const nr = typeof l?.nr === 'number' ? l.nr : Number(l?.nr);
    if (!Number.isFinite(tiefe) || !Number.isInteger(nr) || nr <= 0) {
      verworfen++;
      continue;
    }
    layers.push({
      tiefe,
      nr,
      name: typeof l.name === 'string' ? l.name : undefined,
      quelle: l.quelle === 'vorgabe' ? 'vorgabe' : 'ist',
    });
  }

  if (verworfen > 0) {
    return {
      layers,
      hinweis: `${verworfen} Schicht(en) waren unvollständig und wurden nicht gespeichert. `
        + 'Bitte das Geologieprofil im Portal prüfen.',
    };
  }
  return { layers };
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

  /**
   * Stop the recording, optionally committing the confirmed geology profile
   * first.
   *
   * The order matters: the geology readings have to be in `session_readings`
   * before the session ends, because ending it is what releases the
   * auto-upload. Committing afterwards would race the upload and, on a fast
   * link, leave the geology behind for a later retry that never comes.
   *
   * **A stop with no profile still back-fills** — unless the operator already
   * signed one off at the step out of `bohren`, in which case it is already
   * committed and this route leaves it alone. Where neither applies, the server
   * builds the same profile the sign-off screen would have shown — the
   * observations with the Vorgabe filling what was never confirmed — and
   * commits that. This is what keeps the sign-off a review step rather than a
   * gate: stopping by voice, from a second tab, or straight from the recording
   * bar produces the same complete profile as reviewing it. A Verfahren without
   * geology, and a session that never really drilled, commit nothing and stop
   * exactly as this route always has.
   */
  app.post('/api/recording/stop', async (request, reply) => {
    try {
      const { layers, hinweis } = readGeologyBody(request.body);

      // Read the session before ending it: afterwards there is no active one.
      const active = getActiveSession();
      let geology: GeologyCommitResult | undefined;
      let geologieFehler: string | undefined;
      if (active) {
        /*
         * Its own try/catch, and that is the whole point of it.
         *
         * Inside the outer one, a throw from here returns 409 without ever
         * calling endRecording — the recording stays active and the stop button
         * keeps failing, which is the dead end this route is written to avoid.
         * The throw surface is small but real: better-sqlite3 raises on
         * SQLITE_FULL, and a kiosk with a full disk is exactly the state in
         * which the stop button must still work.
         */
        try {
          /*
           * A profile already signed off is left exactly as it is.
           *
           * The sign-off happens at the step out of `bohren`, which commits
           * there — so by the time the stop runs the readings are in
           * `session_readings` and still `pending`, which is all the upload
           * needs. Rebuilding here would undo the operator's edits: the
           * rebuild re-derives the back-fill from the Schichtauftrag, so a
           * planned boundary they deleted on the sign-off screen would quietly
           * come back.
           *
           * A step back into `bohren` clears the mark, so a session that
           * resumed drilling commits again from the deeper hole.
           */
          geology = layers.length > 0
            ? commitGeology(active, layers)
            : active.geology_confirmed_at != null
              ? undefined
              : commitDefaultGeology(active) ?? undefined;
        } catch (err) {
          log.error('Session %d: geology commit failed: %s', active.id, (err as Error).message);
          geologieFehler = 'Das Geologieprofil konnte nicht gespeichert werden. '
            + 'Die Messwerte sind vollständig und werden normal hochgeladen.';
        }
      }

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

      const hinweise = [hinweis, geologieFehler, geology?.hinweis].filter(Boolean);
      return reply.send({
        ...result,
        geology,
        ...(hinweise.length > 0 ? { hinweis: hinweise.join(' ') } : {}),
      });
    } catch (err) {
      // endRecording's own message is German and actionable ("Keine aktive
      // Aufzeichnung."); anything else reaching here is not, so it is logged
      // rather than put on a worker's screen.
      const msg = (err as Error).message;
      log.error('Stop failed: %s', msg);
      return reply.status(409).send({
        error: msg.startsWith('Keine aktive')
          ? msg
          : 'Die Aufzeichnung konnte nicht beendet werden. Bitte erneut versuchen.',
      });
    }
  });

  /**
   * Record one layer change at the depth the rig is at right now.
   *
   * No depth in the body on purpose — see recordLiveLayer. The response
   * carries the depth that was used so the screen can confirm what was
   * recorded, not merely that something was.
   */
  app.post<{ Body: { nr?: unknown; name?: unknown } }>(
    '/api/recording/geology',
    async (request, reply) => {
      const session = getActiveSession();
      if (!session) {
        return reply.status(409).send({
          error: 'Es läuft keine Aufzeichnung. Bitte zuerst die Aufzeichnung starten.',
        });
      }

      const nr = typeof request.body?.nr === 'number'
        ? request.body.nr
        : Number(request.body?.nr);
      if (!Number.isInteger(nr) || nr <= 0) {
        return reply.status(400).send({
          error: 'Bitte eine gültige Bodenart auswählen.',
        });
      }

      const name = typeof request.body?.name === 'string' ? request.body.name : undefined;
      const result = recordLiveLayer(session, nr, name);
      if ('fehler' in result) {
        return reply.status(409).send({ error: result.fehler });
      }

      log.info('Session %d: live geology %d at %s m', session.id, nr, result.tiefe.toFixed(2));
      return reply.send({ nr, ...result });
    },
  );

  /**
   * Commit the reviewed geology profile and carry on recording.
   *
   * The sign-off at the step out of `bohren`: drilling is over, so the profile
   * is final, but the element is not — Austausch, Einbauen and Auffüllen still
   * have to happen, and the upload is released by the stop as it always was.
   *
   * This is where the profile is written for all but the sessions that never
   * leave `bohren`. Doing it here rather than at the stop is the point of the
   * whole arrangement: the operator confirms the ground while the drilling is
   * still fresh, an hour or a day before the recording ends.
   *
   * **Never refused over its geology.** A profile that cannot be committed
   * costs the profile and nothing else: the mark is still set, the operator
   * still gets to Austausch, and the measurements upload normally. Leaving them
   * stuck on a review screen whose only button fails is the dead end this
   * software does not get to have.
   */
  app.post('/api/recording/geology/commit', async (request, reply) => {
    const session = getActiveSession();
    if (!session) {
      return reply.status(409).send({
        error: 'Es läuft keine Aufzeichnung. Bitte zuerst die Aufzeichnung starten.',
      });
    }

    const { layers, hinweis } = readGeologyBody(request.body);
    let geology: GeologyCommitResult | undefined;
    let geologieFehler: string | undefined;
    try {
      geology = layers.length > 0
        ? commitGeology(session, layers)
        : commitDefaultGeology(session) ?? undefined;
    } catch (err) {
      log.error('Session %d: geology commit failed: %s', session.id, (err as Error).message);
      geologieFehler = 'Das Geologieprofil konnte nicht gespeichert werden. '
        + 'Die Messwerte sind vollständig und werden normal hochgeladen.';
    }

    /*
     * Marked confirmed even when the commit failed.
     *
     * The alternative is asking again at the stop, which would re-run exactly
     * the write that just failed and put the operator back on this screen — at
     * the one moment they are trying to finish the element. The failure is
     * logged and shown here, once.
     */
    setGeologyConfirmedAt(session.id, Date.now());
    log.info('Session %d: geology confirmed (%d boundaries)', session.id, geology?.geschrieben ?? 0);

    const hinweise = [hinweis, geologieFehler, geology?.hinweis].filter(Boolean);
    return reply.send({
      geology,
      ...(hinweise.length > 0 ? { hinweis: hinweise.join(' ') } : {}),
    });
  });

  /**
   * Everything the geology confirmation screen needs: the planned profile to
   * back-fill from, the layers already observed, and whether this session
   * drilled far enough to be worth confirming at all.
   *
   * Works on the still-active session, because the confirmation happens before
   * the stop.
   */
  app.get<{ Params: { id: string } }>(
    '/api/recording/:id/geology-context',
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) {
        return reply.status(400).send({ error: 'Ungültige Aufzeichnungs-ID.' });
      }
      const session = getSessionById(sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Aufzeichnung nicht gefunden.' });
      }
      return reply.send(getGeologyContext(session));
    },
  );

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
      /*
       * Stepping out of `bohren` is what ends drilling, and stepping back in is
       * what resumes it.
       *
       * Both are stamped on the session before the mode moves, because every
       * geology read is bounded by `drilling_ended_at` — see
       * `drillingWindowEnd` in geology.ts. The order matters in the other
       * direction too: a step back has to clear the sign-off *and* the window,
       * or the operator drills deeper into a hole whose profile was already
       * settled and nothing ever asks them about the new ground.
       */
      const active = getActiveSession();
      if (active) {
        const vorher = active.operating_mode;
        if (vorher === 'bohren' && mode !== 'bohren') {
          if (active.drilling_ended_at == null) setDrillingEndedAt(active.id, Date.now());
        } else if (vorher !== 'bohren' && mode === 'bohren') {
          setDrillingEndedAt(active.id, null);
          setGeologyConfirmedAt(active.id, null);
        }
      }
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

  /**
   * Put the readings this session held back as a Rohrwechsel back in the
   * upload queue.
   *
   * The way out of a wrong Klemmbacke threshold. Clipped readings are in no
   * upload and in no exported file, and a reset deletes them — so without
   * this, a threshold typed one digit off costs a shift of measurements that
   * are sitting right there in the database. Reachable for service personnel
   * even though the recording bar no longer offers the button.
   */
  app.post<{ Params: { id: string } }>(
    '/api/recording/sessions/:id/unclip',
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) {
        return reply.status(400).send({ error: 'Ungültige Aufzeichnungs-ID.' });
      }
      const released = unclipSessionReadings(sessionId);
      log.info('Session %d: %d clipped readings released for upload', sessionId, released);
      broadcastMessage({ type: 'recording-state', ...getRecordingState() });
      return reply.send({ sessionId, released });
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
