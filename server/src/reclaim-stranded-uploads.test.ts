import { describe, it, expect, beforeAll } from 'vitest';

/**
 * An upload must survive the process restarting under it.
 *
 * `uploading` is set for the duration of a call to uploadSession() and nowhere
 * else, so a process that has just started cannot have one in flight. Nothing
 * used to clear the row, and the failure was a dead end rather than a crash:
 * getRecordingState() keeps reporting the session, which pins the recording bar
 * to a reading count with neither an upload button nor "Aufzeichnung
 * beginnen" — so the kiosk could neither finish that element nor start the
 * next one, for the rest of the shift.
 *
 * DB_PATH is forced to ':memory:' by vitest.config.ts, hence the dynamic
 * import: db.ts opens its connection at import time.
 */

let db: typeof import('./db.js');

beforeAll(async () => {
  db = await import('./db.js');

  if (db.databasePath() !== ':memory:') {
    throw new Error(`Refusing to run against "${db.databasePath()}" — expected :memory:`);
  }
});

function sessionWithStatus(status: Parameters<typeof db.updateSessionStatus>[1]): number {
  const id = db.createSession('P-restart', JSON.stringify({}));
  db.endSession(id);
  db.updateSessionStatus(id, status);
  return id;
}

describe('reclaimStrandedUploads', () => {
  it('hands a session interrupted mid-upload back to the retry path', () => {
    const id = sessionWithStatus('uploading');

    expect(db.reclaimStrandedUploads()).toBeGreaterThanOrEqual(1);
    expect(db.getSessionById(id)?.status).toBe('ended');
  });

  it('leaves every terminal and in-progress status alone', () => {
    // Only `uploading` is unreachable after a restart. Touching `recording`
    // would fight resumeRecording(), and touching `uploaded` would re-upload
    // data the backend already has.
    const uploaded = sessionWithStatus('uploaded');
    const partial = sessionWithStatus('partial');
    const ended = sessionWithStatus('ended');
    const recording = db.createSession('P-live', JSON.stringify({}));

    db.reclaimStrandedUploads();

    expect(db.getSessionById(uploaded)?.status).toBe('uploaded');
    expect(db.getSessionById(partial)?.status).toBe('partial');
    expect(db.getSessionById(ended)?.status).toBe('ended');
    expect(db.getSessionById(recording)?.status).toBe('recording');
  });

  it('reports nothing to reclaim when no upload was interrupted', () => {
    db.reclaimStrandedUploads();
    expect(db.reclaimStrandedUploads()).toBe(0);
  });

  it('keeps readings the interrupted attempt already uploaded', () => {
    // The retry resumes where it stopped: getSessionUploadGroups() only picks
    // up `pending` rows, so flipping these back would send them twice.
    const id = sessionWithStatus('uploading');
    db.insertSessionReading(id, 'depth', 'sensor-a', 'float', 1.5, null);
    db.insertSessionReading(id, 'depth', 'sensor-a', 'float', 2.5, null);
    const groups = db.getSessionUploadGroups(id);
    db.markSessionReadingsUploaded([groups[0].readings[0].id]);

    db.reclaimStrandedUploads();

    const remaining = db.getSessionUploadGroups(id);
    expect(remaining[0].readings).toHaveLength(1);
    expect(remaining[0].readings[0].valueNumeric).toBe(2.5);
  });
});
