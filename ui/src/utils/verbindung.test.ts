import { describe, it, expect } from 'vitest';
import {
  aktuelleMeldung, meldungsSchluessel, verbindungsMeldungen,
} from './verbindung';

const labels = (...args: Parameters<typeof verbindungsMeldungen>) =>
  verbindungsMeldungen(...args).map((m) => m.label);

describe('verbindungsMeldungen', () => {
  it('reports one green „Verbunden" when all three are healthy', () => {
    expect(verbindungsMeldungen('online', 'ok', 'connected')).toEqual([
      { label: 'Verbunden', farbe: 'success' },
    ]);
  });

  it('claims nothing before the first frames arrive', () => {
    expect(verbindungsMeldungen('unknown', 'unknown', 'unknown')).toEqual([
      { label: 'Verbinde...', farbe: 'neutral' },
    ]);
  });

  describe('the data source', () => {
    it('names the transport that went quiet', () => {
      expect(labels('online', 'ok', 'disconnected', 'mqtt')).toEqual(['MQTT offline']);
      expect(labels('online', 'ok', 'disconnected', 'serial')).toEqual(['USB offline']);
    });

    // A fresh machine, or one whose setup wizard has not been finished, has no
    // broker to be disconnected from. Reporting a fault there sends a
    // technician looking for a network problem that does not exist.
    it('says nothing about a source that was never configured', () => {
      expect(labels('online', 'ok', 'unconfigured')).toEqual(['Verbunden']);
      expect(labels('online', 'ok', 'unknown')).toEqual(['Verbunden']);
    });

    /*
     * The ordering that matters: a failed upload is buffered and retried, a
     * reading that never arrived is gone. The loss comes first.
     */
    it('comes before the upload problems, because only it loses data', () => {
      expect(labels('offline', 'unreachable', 'disconnected', 'mqtt'))
        .toEqual(['MQTT offline', 'Offline']);
    });
  });

  describe('more than one problem', () => {
    // On site the box is the broker *and* the uplink, so one dead box is two
    // of the three. An indicator showing only the worst would have somebody
    // fixing half of it.
    it('returns every problem, not just the worst', () => {
      expect(labels('online', 'unreachable', 'disconnected', 'mqtt'))
        .toEqual(['MQTT offline', 'Server offline']);
    });

    it('does not accuse the platform while the internet is down', () => {
      expect(labels('offline', 'unreachable', 'connected')).toEqual(['Offline']);
      expect(labels('offline', 'rejected', 'connected')).toEqual(['Offline']);
    });

    it('separates a refused key from a backend that is not there', () => {
      expect(labels('online', 'rejected', 'connected')).toEqual(['Kein Zugriff']);
      expect(labels('online', 'unreachable', 'connected')).toEqual(['Server offline']);
    });
  });
});

describe('rotation', () => {
  const zwei = verbindungsMeldungen('online', 'unreachable', 'disconnected', 'mqtt');

  it('cycles through the messages and wraps', () => {
    expect(aktuelleMeldung(zwei, 0).label).toBe('MQTT offline');
    expect(aktuelleMeldung(zwei, 1).label).toBe('Server offline');
    expect(aktuelleMeldung(zwei, 2).label).toBe('MQTT offline');
  });

  // The set can shrink while the tick is past its new end — a problem clearing
  // is exactly when that happens — and a blank indicator would be worse than
  // either message.
  it('never indexes off the end of a shrunken set', () => {
    const eins = verbindungsMeldungen('online', 'ok', 'disconnected', 'mqtt');
    expect(aktuelleMeldung(eins, 7).label).toBe('MQTT offline');
    expect(aktuelleMeldung([], 3).label).toBe('Verbunden');
  });

  it('keys on the message set, so the cycle restarts only when it changes', () => {
    expect(meldungsSchluessel(zwei)).toBe(meldungsSchluessel(zwei));
    expect(meldungsSchluessel(zwei)).not.toBe(
      meldungsSchluessel(verbindungsMeldungen('online', 'ok', 'disconnected', 'mqtt')),
    );
  });
});
