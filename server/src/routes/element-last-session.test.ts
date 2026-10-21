import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * `GET /api/elements/:name/last-session` — where an element reopens.
 *
 * The screen asks this before it draws anything, and two decisions hang off
 * the answer: whether opening the element jumps to the alignment screen, and
 * which phase screen it lands on. Both are wrong in a way nobody reports if
 * the lookup answers about the *kiosk's* last session rather than this
 * element's — a resumed pillar would be sent to the dials because the element
 * recorded after it is the one the kiosk remembers.
 */

vi.mock('../implenia-api.js', () => ({
  fetchImplenia: vi.fn(),
  getApiConfig: () => ({ apiUrl: 'http://test', apiKey: 'key' }),
}));

let app: FastifyInstance;
let db: typeof import('../db.js');

async function last(name: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/elements/${encodeURIComponent(name)}/last-session`,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** A finished session for an element, left in the given phase. */
function session(element: string, mode: string): number {
  const id = db.createSession(element, '{}');
  db.setOperatingModeRow(id, mode);
  db.endSession(id);
  return id;
}

beforeAll(async () => {
  db = await import('../db.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
  const { registerImpleniaRoutes } = await import('./implenia.js');
  app = Fastify();
  registerImpleniaRoutes(app);
  await app.ready();
});

beforeEach(() => {
  for (const s of db.getSessions()) db.deleteSessionWithReadings(s.id);
});

describe('an element this kiosk has never recorded', () => {
  it('answers that it is unknown, rather than 404', async () => {
    const { status, body } = await last('P-99');
    expect(status).toBe(200);
    expect(body.bekannt).toBe(false);
    expect(body.mode).toBeNull();
  });

  // The element has been aimed but never recorded — still the untouched case
  // the alignment redirect exists for.
  it('is unaffected by sessions on other elements', async () => {
    session('P-01', 'auffuellen');
    const { body } = await last('P-99');
    expect(body.bekannt).toBe(false);
    expect(body.mode).toBeNull();
  });
});

describe('a resumed element', () => {
  it('reports the phase its last session was in', async () => {
    session('P-01', 'auffuellen');
    const { body } = await last('P-01');
    expect(body.bekannt).toBe(true);
    expect(body.mode).toBe('auffuellen');
  });

  /*
   * The whole point of the per-element lookup. The kiosk's most recent session
   * belongs to P-02; asking it about P-01 would reopen P-01 in P-02's phase
   * and, worse, report P-01 as never recorded.
   */
  it('answers about this element, not about the kiosk', async () => {
    session('P-01', 'auffuellen');
    session('P-02', 'bohren');

    expect((await last('P-01')).body.mode).toBe('auffuellen');
    expect((await last('P-02')).body.mode).toBe('bohren');
  });

  it('takes the newest of several sessions for the same element', async () => {
    session('P-01', 'bohren');
    session('P-01', 'einbauen');
    expect((await last('P-01')).body.mode).toBe('einbauen');
  });

  it('drops a mode nothing can render rather than passing it on', async () => {
    const id = session('P-01', 'bohren');
    db.setOperatingModeRow(id, 'verpressen');
    const { body } = await last('P-01');
    expect(body.bekannt).toBe(true);
    expect(body.mode).toBeNull();
  });

  // A session still running counts: the element is known, and the redirect is
  // suppressed by the running recording anyway.
  it('counts a session that has not ended', async () => {
    db.createSession('P-01', '{}');
    const { body } = await last('P-01');
    expect(body.bekannt).toBe(true);
  });
});
