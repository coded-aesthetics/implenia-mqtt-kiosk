import { describe, it, expect } from 'vitest';
import { splitTopic } from './topic-grouping.js';

describe('splitTopic', () => {
  it('splits a bound two-segment topic', () => {
    expect(splitTopic('Bohrgeraet/Tiefe', 'Tiefe')).toEqual({
      prefix: 'Bohrgeraet', leaf: 'Tiefe',
    });
  });

  it('keeps a sensor name that contains a slash whole', () => {
    // Splitting on the last '/' gives `min]`, which is the display half of the
    // bug `resolveSensorKey` carries a comment about.
    expect(splitTopic('hdi/Drehzahl [1/min]', 'Drehzahl [1/min]')).toEqual({
      prefix: 'hdi', leaf: 'Drehzahl [1/min]',
    });
    expect(splitTopic('Maschine/W/Z-Wert', 'W/Z-Wert')).toEqual({
      prefix: 'Maschine', leaf: 'W/Z-Wert',
    });
    expect(splitTopic('plc/Bohren/Düsen', 'Bohren/Düsen')).toEqual({
      prefix: 'plc', leaf: 'Bohren/Düsen',
    });
  });

  it('matches the sensor name case-insensitively', () => {
    expect(splitTopic('Bohrgeraet/tiefe', 'Tiefe')).toEqual({
      prefix: 'Bohrgeraet', leaf: 'tiefe',
    });
  });

  it('groups a serial topic by its device', () => {
    expect(splitTopic('device/3/Tiefe', 'Tiefe')).toEqual({
      prefix: 'device/3', leaf: 'Tiefe',
    });
  });

  it('groups an unbound serial topic by its device too', () => {
    expect(splitTopic('device/12/ch07', null)).toEqual({
      prefix: 'device/12', leaf: 'ch07',
    });
  });

  it('gives an unbound topic its first segment', () => {
    expect(splitTopic('plc/ch07', null)).toEqual({ prefix: 'plc', leaf: 'ch07' });
  });

  it('leaves a prefix-less topic without a group', () => {
    expect(splitTopic('logs', null)).toEqual({ prefix: '', leaf: 'logs' });
  });

  it('leaves a topic that is only the sensor name without a group', () => {
    expect(splitTopic('Q_Bohren', 'Q_Bohren')).toEqual({ prefix: '', leaf: 'Q_Bohren' });
  });

  it('tolerates stray slashes rather than producing an empty leaf', () => {
    expect(splitTopic('/Bohrgeraet/Tiefe/', 'Tiefe')).toEqual({
      prefix: 'Bohrgeraet', leaf: 'Tiefe',
    });
    expect(splitTopic('/', null).leaf).toBe('/');
    expect(splitTopic('', null).leaf).toBe('');
  });

  it('ignores a sensor name the topic does not end with', () => {
    // A stale override can name a sensor unrelated to the topic. The split then
    // falls back rather than slicing at a length the topic does not have.
    expect(splitTopic('plc/ch07', 'Bohrtiefe')).toEqual({ prefix: 'plc', leaf: 'ch07' });
  });

  it('keeps a three-segment unbound topic in one piece below its first segment', () => {
    // Known-imprecise and deliberately so: with nothing resolved there is no
    // way to tell which segments are addressing and which is the channel.
    expect(splitTopic('site/plc/ch07', null)).toEqual({ prefix: 'site', leaf: 'plc/ch07' });
  });
});
