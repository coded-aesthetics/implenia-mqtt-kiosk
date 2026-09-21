import { describe, it, expect } from 'vitest';
import {
  normalizeBrokerUrl,
  normalizeTopics,
  DEFAULT_BROKER_URL,
  DEFAULT_TOPICS,
} from './mqtt-config.js';

describe('normalizeBrokerUrl', () => {
  it('accepts a bare IP and fills in scheme and default port', () => {
    // What a technician actually types for the Implenia MQTT box.
    expect(normalizeBrokerUrl('192.168.2.1')).toEqual({ ok: true, url: DEFAULT_BROKER_URL });
  });

  it('accepts a bare host:port', () => {
    expect(normalizeBrokerUrl('192.168.2.1:1884')).toEqual({ ok: true, url: 'mqtt://192.168.2.1:1884' });
  });

  it('accepts a full URL unchanged', () => {
    expect(normalizeBrokerUrl('mqtt://10.0.0.5:1883')).toEqual({ ok: true, url: 'mqtt://10.0.0.5:1883' });
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeBrokerUrl('  192.168.2.1  ')).toEqual({ ok: true, url: DEFAULT_BROKER_URL });
  });

  it('fills in the TLS default port for mqtts', () => {
    expect(normalizeBrokerUrl('mqtts://broker.local')).toEqual({ ok: true, url: 'mqtts://broker.local:8883' });
  });

  it('accepts hostnames, not just IPs', () => {
    expect(normalizeBrokerUrl('implenia-box.local')).toEqual({ ok: true, url: 'mqtt://implenia-box.local:1883' });
  });

  it('leaves websocket URLs without an invented port', () => {
    expect(normalizeBrokerUrl('ws://192.168.2.1/mqtt')).toEqual({ ok: true, url: 'ws://192.168.2.1' });
  });

  it('rejects an empty value with an actionable German message', () => {
    const result = normalizeBrokerUrl('   ');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('192.168.2.1');
  });

  it('rejects an unsupported scheme', () => {
    const result = normalizeBrokerUrl('http://192.168.2.1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('mqtt');
  });

  it('rejects a value that is not parseable as a URL', () => {
    expect(normalizeBrokerUrl('mqtt://').ok).toBe(false);
  });
});

describe('normalizeTopics', () => {
  it('keeps the wide default filter', () => {
    expect(normalizeTopics(DEFAULT_TOPICS)).toEqual({ ok: true, url: '#' });
  });

  it('normalizes spacing in a comma-separated list', () => {
    expect(normalizeTopics(' sensors/#, machine/# ')).toEqual({ ok: true, url: 'sensors/#,machine/#' });
  });

  it('rejects an empty filter', () => {
    expect(normalizeTopics('  ').ok).toBe(false);
  });

  it('rejects a filter containing a space', () => {
    const result = normalizeTopics('sensors/a b');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Leerzeichen');
  });
});

// describeBrokerError lives with the route that uses it, but its whole job is
// keeping library English out of the technician's screen — worth pinning.
import { describeBrokerError } from './routes/config.js';

describe('describeBrokerError', () => {
  const url = 'mqtt://192.168.2.1:1883';

  it('never leaks the library wording', () => {
    for (const raw of [
      'connack timeout',
      'connect ECONNREFUSED 192.168.2.1:1883',
      'getaddrinfo ENOTFOUND implenia-box.local',
      'connect EHOSTUNREACH 192.168.2.1:1883',
      'Connection refused: Not authorized',
      'something nobody anticipated',
    ]) {
      const message = describeBrokerError(raw, url);
      expect(message).not.toContain(raw);
      expect(message).toMatch(/[äöüÄÖÜß]|bitte|Bitte/);
      expect(message).toContain(url);
    }
  });

  it('distinguishes the cases a technician would act on differently', () => {
    expect(describeBrokerError('connack timeout', url)).toContain('eingeschaltet');
    expect(describeBrokerError('connect ECONNREFUSED', url)).toContain('Port');
    expect(describeBrokerError('getaddrinfo ENOTFOUND x', url)).toContain('aufgelöst');
    expect(describeBrokerError('connect EHOSTUNREACH', url)).toContain('verbunden');
  });
});
