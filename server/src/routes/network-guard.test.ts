import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ConnectResult, NetworkController, NetworkStatus, WifiNetwork } from '../network.js';

/**
 * The route around the Wi-Fi switch.
 *
 * The switch itself is pinned by `network.test.ts`; what matters here is that a
 * running recording keeps the kiosk off the network settings, because the box's
 * access point is the data source and the seconds it takes to come up are
 * measurements nobody can get back.
 */

let app: FastifyInstance;
let db: typeof import('../db.js');

const STATUS: NetworkStatus = {
  hostname: 'kiosk-g08',
  capability: { available: true, iface: 'wlan0' },
  ssid: 'Buero-WLAN',
  signal: 71,
  defaultRouteDevice: 'wlan0',
  routedElsewhere: false,
};

let attempts: { ssid: string; psk: string }[] = [];
let nextResult: ConnectResult = { ok: true, ssid: 'Implenia-Box-G08', internet: true };
let status: NetworkStatus = STATUS;
let networks: WifiNetwork[] = [];

const controller: NetworkController = {
  status: async () => status,
  scan: async () => networks,
  connect: async (ssid, psk) => {
    attempts.push({ ssid, psk });
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
  const { registerNetworkConfigRoutes } = await import('./config-network.js');
  app = Fastify();
  registerNetworkConfigRoutes(app, controller);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.resetKiosk();
  attempts = [];
  nextResult = { ok: true, ssid: 'Implenia-Box-G08', internet: true };
  status = STATUS;
  networks = [];
});

function connect(ssid = 'Implenia-Box-G08', psk = 'geheim123') {
  return app.inject({ method: 'POST', url: '/api/config/netzwerk', payload: { ssid, psk } });
}

describe('switching the Wi-Fi', () => {
  it('is refused while an element is being recorded', async () => {
    db.createSession('A-42', '{}');

    const res = await connect();

    expect(res.statusCode).toBe(409);
    // Not even attempted: the rollback would cut the feed a second time.
    expect(attempts).toEqual([]);
    const body = res.json() as { error: string };
    expect(body.error).toContain('A-42');
    expect(body.error).toContain('Aufzeichnung beenden');
  });

  it('goes ahead once the recording has ended', async () => {
    const sessionId = db.createSession('A-42', '{}');
    db.endSession(sessionId);

    const res = await connect();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ssid: 'Implenia-Box-G08', internet: true });
    expect(attempts).toEqual([{ ssid: 'Implenia-Box-G08', psk: 'geheim123' }]);
  });

  it('accepts an empty password for an open network', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/config/netzwerk', payload: { ssid: 'Gast' },
    });
    expect(res.statusCode).toBe(200);
    expect(attempts).toEqual([{ ssid: 'Gast', psk: '' }]);
  });

  it('rejects a request with no network chosen', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/config/netzwerk', payload: { psk: 'geheim123' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('auswählen');
    expect(attempts).toEqual([]);
  });

  it('answers 409 for a machine that cannot change its Wi-Fi at all', async () => {
    // The machine's own state is in the way, and no request would fix it.
    nextResult = { ok: false, code: 'unavailable', error: 'NetworkManager fehlt' };
    const res = await connect();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'unavailable' });
  });

  it('answers 502 for a network that refused us', async () => {
    // The request was fine; the other end was not.
    nextResult = { ok: false, code: 'bad-password', error: 'Das Passwort …' };
    const res = await connect();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'bad-password', error: 'Das Passwort …' });
  });
});

describe('reading the network state', () => {
  it('reports a machine that cannot do this as a state, not an error', async () => {
    status = {
      ...STATUS,
      capability: { available: false, reason: 'NetworkManager fehlt' },
      ssid: null, signal: null, defaultRouteDevice: null,
    };
    const res = await app.inject({ method: 'GET', url: '/api/config/netzwerk' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hostname: 'kiosk-g08',
      capability: { available: false },
    });
  });

  it('scans separately from the status, so the screen can show one before the other', async () => {
    networks = [{ ssid: 'Implenia-Box-G08', signal: 84, secured: true, active: false }];
    const res = await app.inject({ method: 'GET', url: '/api/config/netzwerk/scan' });
    expect(res.json()).toEqual({ networks });
  });
});
