import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * A session uploads under the key of the site it was recorded on.
 *
 * On a bridge the crew has one API key per pier and switches it when they move.
 * A session's readings are addressed to the sensor ids of the pier they were
 * recorded on, so the platform will only accept them from that pier's key —
 * and retried under the *new* pier's key, a session left behind answered 401 on
 * every connectivity transition and every boot, for the life of the machine,
 * with nothing on screen and the only way out retyping the old key by hand.
 *
 * The site id is a one-way hash and cannot produce a key, which is why
 * `site_credentials` exists.
 */

let db: typeof import('./db.js');
let site: typeof import('./site.js');
let creds: typeof import('./site-credentials.js');
let api: typeof import('./implenia-api.js');
let health: typeof import('./api-health.js');

const PIER_1 = 'key-for-pier-1';
const PIER_2 = 'key-for-pier-2';

function moveTo(apiKey: string, apiUrl = 'http://platform.test'): string {
  db.setMeta('implenia_api_key', apiKey);
  db.setMeta('implenia_api_url', apiUrl);
  site.syncSite();
  return db.currentSiteId();
}

/** Every Authorization header `fetchImplenia` sent, in order. */
let sent: { url: string; auth: string | null }[] = [];

function stubFetch(status = 200): void {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      auth: (init.headers as Record<string, string>).Authorization ?? null,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
      text: async () => 'nope',
    } as unknown as Response;
  }));
}

beforeAll(async () => {
  db = await import('./db.js');
  site = await import('./site.js');
  creds = await import('./site-credentials.js');
  api = await import('./implenia-api.js');
  health = await import('./api-health.js');

  if (db.databasePath() !== ':memory:') {
    throw new Error(
      `Refusing to run destructive tests against "${db.databasePath()}" — expected :memory:`,
    );
  }
});

beforeEach(() => {
  db.resetKiosk();
  db.deleteMeta('current_site_id');
  db.deleteMeta('implenia_api_key');
  db.deleteMeta('implenia_api_url');
  db.getSessions().forEach((s) => db.deleteSessionWithReadings(s.id));
  health.apiHealth.reset();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the stored key per site', () => {
  it('is remembered for every key the kiosk is given', () => {
    const pier1 = moveTo(PIER_1);
    const pier2 = moveTo(PIER_2);

    expect(db.getSiteCredentials(pier1)).toEqual({
      apiUrl: 'http://platform.test', apiKey: PIER_1,
    });
    expect(db.getSiteCredentials(pier2)).toEqual({
      apiUrl: 'http://platform.test', apiKey: PIER_2,
    });
  });

  it('follows a URL change, which does not move the site', () => {
    // The URL is deliberately not part of the site id, so nothing moves — but a
    // left-behind pier reads its URL from this row and would otherwise keep
    // aiming at the previous backend.
    const pier1 = moveTo(PIER_1, 'http://old.test');
    const same = moveTo(PIER_1, 'http://new.test');
    expect(same).toBe(pier1);
    expect(db.getSiteCredentials(pier1)?.apiUrl).toBe('http://new.test');
  });
});

describe('a request run against a site the kiosk has left', () => {
  it('goes out with that site\'s key, not the configured one', async () => {
    const pier1 = moveTo(PIER_1);
    moveTo(PIER_2);

    await creds.withSiteCredentials(pier1, () => api.fetchImplenia('/api/v1/sensor-float/x/batch'));

    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe(`Bearer ${PIER_1}`);
  });

  it('uses the configured key outside the context', async () => {
    moveTo(PIER_1);
    moveTo(PIER_2);
    await api.fetchImplenia('/api/v1/sensor-float/x/batch');
    expect(sent[0].auth).toBe(`Bearer ${PIER_2}`);
  });

  it('reports the site it is acting as, so per-element caches stay apart', async () => {
    const pier1 = moveTo(PIER_1);
    const pier2 = moveTo(PIER_2);

    expect(creds.effectiveSiteId()).toBe(pier2);
    const seen = await creds.withSiteCredentials(
      pier1, async () => creds.effectiveSiteId(),
    );
    expect(seen).toBe(pier1);
    // And it is restored afterwards — the context is the request's, not the
    // process's.
    expect(creds.effectiveSiteId()).toBe(pier2);
  });

  it('keeps its failures out of the connection indicator', async () => {
    // A 401 from a previous pier's revoked key would otherwise set the health
    // state to `rejected`, and the header would tell the operator *this*
    // kiosk's key is wrong — false, and it sends them to the settings screen
    // for nothing.
    const pier1 = moveTo(PIER_1);
    moveTo(PIER_2);
    health.apiHealth.set('ok');

    stubFetch(401);
    await expect(
      creds.withSiteCredentials(pier1, () => api.fetchImplenia('/api/v1/sensor-float/x/batch')),
    ).rejects.toThrow();

    expect(health.apiHealth.getState()).toBe('ok');
  });

  it('still reports a failure made with the kiosk\'s own key', async () => {
    moveTo(PIER_1);
    stubFetch(401);
    await expect(api.fetchImplenia('/api/v1/sensor-float/x/batch')).rejects.toThrow();
    expect(health.apiHealth.getState()).toBe('rejected');
  });
});

describe('the element→device cache', () => {
  it('does not hand one pier\'s device id to the other\'s element', async () => {
    // Both piers' answers are now in flight within one process, and both
    // piers have a `P-01`. Keyed by name alone, the previous pier's resolve
    // would come back for the current pier's element and the next
    // Ausführungsdatum would be written to the wrong pillar — with a 200.
    const { withElementDevice, forgetElementDevices } = await import('./element-device.js');
    forgetElementDevices();

    const pier1 = moveTo(PIER_1);
    moveTo(PIER_2);

    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      n += 1;
      sent.push({
        url: String(url),
        auth: (init.headers as Record<string, string>).Authorization ?? null,
      });
      return {
        ok: true, status: 200,
        json: async () => ({ device_id: `dev-${n}` }),
        text: async () => '{}',
      } as unknown as Response;
    }));
    sent = [];

    const onPier2 = await withElementDevice('P-01', async (id) => id);
    const onPier1 = await creds.withSiteCredentials(
      pier1, () => withElementDevice('P-01', async (id) => id),
    );
    expect(onPier1).not.toBe(onPier2);

    // Each resolve went out under its own site's key, and each is cached
    // separately rather than one of them being reused.
    expect(sent.map((r) => r.auth)).toEqual([`Bearer ${PIER_2}`, `Bearer ${PIER_1}`]);
    const again = await withElementDevice('P-01', async (id) => id);
    expect(again).toBe(onPier2);
    expect(sent).toHaveLength(2);
    forgetElementDevices();
  });
});

describe('when there is no other site to act as', () => {
  it('runs on the configured key for a session that predates site ids', async () => {
    moveTo(PIER_1);
    await creds.withSiteCredentials('default', () => api.fetchImplenia('/x'));
    expect(sent[0].auth).toBe(`Bearer ${PIER_1}`);
  });

  it('runs on the configured key when a site\'s key was never stored', async () => {
    moveTo(PIER_1);
    // A session recorded before `site_credentials` existed: its site is known,
    // its key is not. It uploads under the current key, which is what it did
    // before this existed at all.
    await creds.withSiteCredentials('a-site-never-keyed-here', () => api.fetchImplenia('/x'));
    expect(sent[0].auth).toBe(`Bearer ${PIER_1}`);
  });

  it('is a plain no-op for the site the kiosk is on', async () => {
    const pier1 = moveTo(PIER_1);
    await creds.withSiteCredentials(pier1, () => api.fetchImplenia('/x'));
    expect(sent[0].auth).toBe(`Bearer ${PIER_1}`);
  });
});
