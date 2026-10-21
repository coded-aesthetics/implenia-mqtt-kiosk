import { describe, it, expect, beforeEach } from 'vitest';
import { sourceHealth, healthFromSource } from './source-health.js';

describe('healthFromSource', () => {
  it('reports a live transport as connected', () => {
    expect(healthFromSource({ connected: true, configured: true })).toBe('connected');
  });

  it('reports a configured transport that is down', () => {
    expect(healthFromSource({ connected: false, configured: true })).toBe('disconnected');
  });

  /*
   * The case that would otherwise put a red „MQTT offline" on every fresh
   * machine: `mqtt.start()` returns early when no broker is configured, so
   * `connected` is false and stays false. Nothing is wrong — nobody has said
   * what to connect to yet.
   */
  it('does not call an unconfigured source a fault', () => {
    expect(healthFromSource({ connected: false, configured: false })).toBe('unconfigured');
    expect(healthFromSource({ connected: true, configured: false })).toBe('unconfigured');
  });
});

describe('the tracker', () => {
  beforeEach(() => sourceHealth.reset());

  it('starts out claiming nothing', () => {
    expect(sourceHealth.getState()).toBe('unknown');
  });

  // It is polled once a second, so all but the first report of a steady state
  // is a repeat. Broadcasting those would be a websocket frame per second to
  // every open tab, forever.
  it('emits only when something actually changed', () => {
    const seen: string[] = [];
    const onChange = (state: string) => seen.push(state);
    sourceHealth.on('change', onChange);

    for (let i = 0; i < 5; i++) sourceHealth.report('connected', 'mqtt');
    sourceHealth.report('disconnected', 'mqtt');
    sourceHealth.report('disconnected', 'mqtt');
    sourceHealth.report('connected', 'mqtt');

    sourceHealth.off('change', onChange);
    expect(seen).toEqual(['connected', 'disconnected', 'connected']);
  });

  // The transport can be swapped from the Datenquelle screen while the state
  // stays "connected", and the indicator names the transport — so the change
  // has to reach the browser even though the health did not move.
  it('emits when the transport changes under an unchanged state', () => {
    const seen: string[] = [];
    const onChange = (state: string, type: string) => seen.push(`${state}:${type}`);
    sourceHealth.on('change', onChange);

    sourceHealth.report('disconnected', 'mqtt');
    sourceHealth.report('disconnected', 'serial');

    sourceHealth.off('change', onChange);
    expect(seen).toEqual(['disconnected:mqtt', 'disconnected:serial']);
    expect(sourceHealth.getSourceType()).toBe('serial');
  });
});
