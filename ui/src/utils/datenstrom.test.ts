import { describe, it, expect } from 'vitest';
import {
  FRESH_MS, SILENT_MS, ageLabel, freshnessOf, groupByPrefix, groupLabel, niceScale, silenceLabel,
} from './datenstrom';

describe('freshnessOf', () => {
  it('calls a just-arrived value fresh', () => {
    expect(freshnessOf(0)).toBe('frisch');
    expect(freshnessOf(FRESH_MS)).toBe('frisch');
  });

  it('turns old exactly where Nullen starts refusing', () => {
    // One threshold, one meaning: past this the server refuses a tare, so the
    // screen must not still be calling the value current.
    expect(freshnessOf(FRESH_MS + 1)).toBe('alt');
  });

  it('turns silent after two minutes', () => {
    expect(freshnessOf(SILENT_MS)).toBe('alt');
    expect(freshnessOf(SILENT_MS + 1)).toBe('stumm');
  });
});

describe('ageLabel', () => {
  it('reads as just now under two seconds', () => {
    expect(ageLabel(0)).toBe('gerade eben');
    expect(ageLabel(1400)).toBe('gerade eben');
  });

  it('counts seconds up to a minute', () => {
    expect(ageLabel(7_000)).toBe('vor 7 s');
    expect(ageLabel(59_000)).toBe('vor 59 s');
  });

  it('counts minutes from a minute', () => {
    expect(ageLabel(60_000)).toBe('vor 1 Min.');
    expect(ageLabel(23 * 60_000)).toBe('vor 23 Min.');
  });

  it('never reads as being in the future', () => {
    expect(ageLabel(-5_000)).toBe('gerade eben');
  });
});

describe('silenceLabel', () => {
  it('names a stopped channel as stopped', () => {
    expect(silenceLabel(23 * 60_000)).toBe('stumm vor 23 Min.');
  });

  it('leaves a merely old value unlabelled', () => {
    // "alt" needs no word: the value is still plausibly current and the colour
    // carries it. "stumm" is the one a technician has to act on.
    expect(silenceLabel(30_000)).toBe('vor 30 s');
  });
});

describe('groupByPrefix', () => {
  const ch = (prefix: string, topic: string) => ({ prefix, topic });

  it('groups channels under their prefix, keeping the server order', () => {
    const groups = groupByPrefix([
      ch('Bohrgeraet', 'Bohrgeraet/Tiefe'),
      ch('Bohrgeraet', 'Bohrgeraet/Drehzahl'),
      ch('Maschine', 'Maschine/Druck_Hammer'),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(['Bohrgeraet', 'Maschine']);
    expect(groups[0].channels.map((c) => c.topic))
      .toEqual(['Bohrgeraet/Tiefe', 'Bohrgeraet/Drehzahl']);
  });

  it('puts the channels with no prefix last', () => {
    const groups = groupByPrefix([
      ch('', 'logs'),
      ch('Bohrgeraet', 'Bohrgeraet/Tiefe'),
      ch('Maschine', 'Maschine/Druck_Hammer'),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(['Bohrgeraet', 'Maschine', '']);
  });

  it('handles the whole captured rig as four groups', () => {
    const topics = [
      ...['Tiefe', 'Drehzahl', 'Ziehgeschwindigkeit', 'Winkel', 'Klemmdruck']
        .map((l) => ch('Bohrgeraet', `Bohrgeraet/${l}`)),
      ...['Druck_Hammer', 'Druck_Medium', 'Druck_Vorschub', 'Druck_innen', 'Druck_aussen']
        .map((l) => ch('Maschine', `Maschine/${l}`)),
      ...['Durchfluss', 'Volumen'].map((l) => ch('Spuelpumpe', `Spuelpumpe/${l}`)),
      ...['Durchfluss', 'Volumen'].map((l) => ch('Verpresspumpe', `Verpresspumpe/${l}`)),
    ];
    const groups = groupByPrefix(topics);
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.channels.length)).toEqual([5, 5, 2, 2]);
  });

  it('is empty for no channels', () => {
    expect(groupByPrefix([])).toEqual([]);
  });

  it('makes one group of a single-source box', () => {
    const groups = groupByPrefix([ch('plc', 'plc/ch01'), ch('plc', 'plc/ch02')]);
    expect(groups).toHaveLength(1);
  });
});

describe('groupLabel', () => {
  it('names the prefix-less group rather than leaving it blank', () => {
    expect(groupLabel('')).toBe('Ohne Präfix');
    expect(groupLabel('Bohrgeraet')).toBe('Bohrgeraet');
  });
});

describe('niceScale', () => {
  it('always spans exactly four steps', () => {
    for (const [lo, hi] of [[11.2, 13.8], [0, 1], [-5, 5], [980, 1020], [0.01, 0.09]]) {
      const s = niceScale(lo, hi);
      const step = (s.max - s.min) / 4;
      for (let i = 0; i <= 4; i++) {
        const tick = s.min + i * step;
        // Every tick prints as a distinct number at the decimals it ships.
        expect(Number(tick.toFixed(s.decimals))).toBeCloseTo(tick, s.decimals);
      }
    }
  });

  it('covers the data it is given', () => {
    for (const [lo, hi] of [[11.2, 13.8], [0.3, 0.7], [-120, 340]]) {
      const s = niceScale(lo, hi);
      expect(s.min).toBeLessThanOrEqual(lo);
      expect(s.max).toBeGreaterThanOrEqual(hi);
    }
  });

  it('does not skip a tick the way a raw min/max range does', () => {
    // 10..15 over four splits is 1,25 a step, which printed 10,11,13,14,15.
    const s = niceScale(11.19, 13.77);
    const ticks = [0, 1, 2, 3, 4].map((i) => Number((s.min + i * (s.max - s.min) / 4).toFixed(s.decimals)));
    expect(new Set(ticks).size).toBe(5);
  });

  it('gives a flat signal a band to be drawn in', () => {
    const s = niceScale(4.2, 4.2);
    expect(s.max).toBeGreaterThan(s.min);
  });

  it('shows decimals for a small-magnitude channel', () => {
    // An inclination between 1,3 and 1,5 charted with integer ticks reads 1,1,1.
    expect(niceScale(1.3, 1.5).decimals).toBeGreaterThan(0);
  });

  it('survives a non-finite range', () => {
    expect(niceScale(NaN, 5).max).toBeGreaterThan(niceScale(NaN, 5).min);
  });
});
