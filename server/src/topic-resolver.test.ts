import { describe, it, expect } from 'vitest';
import {
  parseTopicMap,
  resolveSensorKey,
  topicSegment,
  type ResolverContext,
} from './topic-resolver.js';

function ctx(
  overrides: Record<string, string> = {},
  topicMap: Record<string, string> = {},
): ResolverContext {
  const lower = (o: Record<string, string>) =>
    new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  return { overrides: lower(overrides), topicMap: lower(topicMap) };
}

describe('topicSegment', () => {
  it('takes the last path segment, lowercased', () => {
    expect(topicSegment('sensors/machine1/Bohrtiefe')).toBe('bohrtiefe');
    expect(topicSegment('Bohrtiefe')).toBe('bohrtiefe');
  });
});

describe('resolveSensorKey', () => {
  it('falls back to the topic segment when nothing is configured', () => {
    // The no-configuration case: topic name already equals the sensor name.
    expect(resolveSensorKey('sensors/Bohrtiefe', ctx())).toBe('bohrtiefe');
  });

  it('uses the shipped topic map for a box with different names', () => {
    const c = ctx({}, { flow_drill: 'DurchflussB' });
    expect(resolveSensorKey('sensors/machine1/flow_drill', c)).toBe('durchflussb');
  });

  it('matches a shipped map entry written as a full topic', () => {
    const c = ctx({}, { 'sensors/machine1/ch07': 'Suspensionsdruck' });
    expect(resolveSensorKey('sensors/machine1/ch07', c)).toBe('suspensionsdruck');
  });

  it('lets an override beat the shipped map', () => {
    // A stale shipped map must never override what a technician wired on site.
    const c = ctx({ 'plc/ch07': 'Vorschubdruck' }, { 'plc/ch07': 'Suspensionsdruck' });
    expect(resolveSensorKey('plc/ch07', c)).toBe('vorschubdruck');
  });

  it('lets an override beat a topic that already matches a sensor name', () => {
    const c = ctx({ 'sensors/Bohrtiefe': 'Vorschubgeschw.' });
    expect(resolveSensorKey('sensors/Bohrtiefe', c)).toBe('vorschubgeschw.');
  });

  it('resolves the trailing-dot case the CSV contract requires', () => {
    // The box publishing "Vorschubgeschw" cannot match "Vorschubgeschw." by
    // name — this is exactly what the mapping exists for.
    expect(resolveSensorKey('sensors/Vorschubgeschw', ctx())).toBe('vorschubgeschw');
    const c = ctx({}, { Vorschubgeschw: 'Vorschubgeschw.' });
    expect(resolveSensorKey('sensors/Vorschubgeschw', c)).toBe('vorschubgeschw.');
  });

  it('is case-insensitive on the topic', () => {
    const c = ctx({}, { FLOW_DRILL: 'DurchflussB' });
    expect(resolveSensorKey('sensors/flow_drill', c)).toBe('durchflussb');
  });

  it('returns null only for an empty topic', () => {
    expect(resolveSensorKey('', ctx())).toBeNull();
  });
});

describe('parseTopicMap', () => {
  it('parses a flat object', () => {
    expect(parseTopicMap('{"flow_drill":"DurchflussB"}').get('flow_drill')).toBe('DurchflussB');
  });

  it('treats an empty map as valid — names are not always known yet', () => {
    expect(parseTopicMap('{}').size).toBe(0);
  });

  it('survives a corrupt file instead of taking the kiosk down', () => {
    expect(parseTopicMap('not json').size).toBe(0);
    expect(parseTopicMap('[1,2]').size).toBe(0);
    expect(parseTopicMap('null').size).toBe(0);
  });

  it('drops entries with no usable sensor name', () => {
    const map = parseTopicMap('{"a":"","b":null,"c":"Bohrtiefe"}');
    expect(map.size).toBe(1);
    expect(map.get('c')).toBe('Bohrtiefe');
  });
});
