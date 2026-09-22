import { describe, it, expect } from 'vitest';
import { parseDump, topicCounts } from './mqtt-dump.js';

const capture = [
  '2026-05-18 15:42:40.190 Bohrgeraet/Tiefe 3.247500',
  '2026-05-18 15:42:40.217 Bohrgeraet/Drehzahl 70.199707',
  '2026-05-18 15:42:41.190 Bohrgeraet/Klemmdruck nan',
  '2026-05-18 15:42:41.848 Spuelpumpe/Volumen 27553.750000',
].join('\n');

describe('MQTT capture reader', () => {
  it('reads a capture into messages', () => {
    const messages = parseDump(capture);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({
      time: '15:42:40.190',
      offsetMs: 0,
      topic: 'Bohrgeraet/Tiefe',
      payload: '3.247500',
    });
  });

  it('measures each message from the start of the capture', () => {
    const messages = parseDump(capture);
    expect(messages[1].offsetMs).toBe(27);
    expect(messages[3].offsetMs).toBe(1658);
  });

  it('keeps the payload exactly as recorded', () => {
    // `nan` is what the rig sends when it has no reading. Normalising it here
    // would hide it from the parsing the live path applies.
    expect(parseDump(capture)[2].payload).toBe('nan');
  });

  it('handles an empty payload and a payload containing spaces', () => {
    const messages = parseDump(
      '2026-05-18 15:42:40.190 Maschine/Status \n' +
      '2026-05-18 15:42:41.190 Maschine/Text Bohren aktiv',
    );
    expect(messages[0].payload).toBe('');
    expect(messages[1].payload).toBe('Bohren aktiv');
  });

  it('drops lines that are not messages rather than throwing', () => {
    // A capture is a recording of a real machine; a truncated last line is
    // normal and must not fail a whole replay.
    const messages = parseDump(
      '# a comment\n' +
      '2026-05-18 15:42:40.190 Bohrgeraet/Tiefe 3.2\n' +
      '2026-05-18 15:42:4',
    );
    expect(messages).toHaveLength(1);
  });

  it('counts messages per topic', () => {
    const counts = topicCounts(parseDump(capture));
    expect(counts.get('Bohrgeraet/Tiefe')).toBe(1);
    expect(counts.size).toBe(4);
  });
});
