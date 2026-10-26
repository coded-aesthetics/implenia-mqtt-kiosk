import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PowerCapability, PowerController, PowerResult } from '../power.js';

/**
 * The route behind the settings screen's sixth tile.
 *
 * The one rule worth pinning is the one that differs from every other
 * machine-level operation here: `POST /api/update`, the WLAN switch and the
 * site switch all answer 409 while a recording runs, and this one does not.
 * A crew going home has to be able to switch the box off, and the session is
 * resumed at the next boot rather than lost.
 */

let app: FastifyInstance;
let db: typeof import('../db.js');

let attempts = 0;
let nextResult: PowerResult = { ok: true };
let capability: PowerCapability = { available: true };

const controller: PowerController = {
  capability: async () => capability,
  poweroff: async () => {
    attempts++;
    return nextResult;
  },
};

beforeAll(async () => {
  db = await import('../db.js');
  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
  const { registerSystemRoutes } = await import('./system.js');
  app = Fastify();
  registerSystemRoutes(app, controller);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.resetKiosk();
  attempts = 0;
  nextResult = { ok: true };
  capability = { available: true };
});

const shutdown = () => app.inject({ method: 'POST', url: '/api/system/shutdown' });

describe('POST /api/system/shutdown', () => {
  it('switches the machine off', async () => {
    const res = await shutdown();

    expect(res.statusCode).toBe(200);
    expect(attempts).toBe(1);
  });

  it('is not refused while an element is being recorded', async () => {
    db.createSession('A-42', '{}');

    const res = await shutdown();

    expect(res.statusCode).toBe(200);
    expect(attempts).toBe(1);
  });

  it('answers a refusal with the German reason', async () => {
    nextResult = { ok: false, error: 'Dieses Gerät darf sich nicht selbst ausschalten.' };

    const res = await shutdown();

    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: string }).error).toContain('nicht selbst ausschalten');
  });
});

describe('GET /api/system/power', () => {
  it('reports a machine that cannot do this at all, rather than failing', async () => {
    capability = { available: false, reason: 'Dieses Gerät kann sich nicht selbst ausschalten.' };

    const res = await app.inject({ method: 'GET', url: '/api/system/power' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ capability });
  });
});
