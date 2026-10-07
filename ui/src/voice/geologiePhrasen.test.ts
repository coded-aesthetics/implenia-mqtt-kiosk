import { describe, it, expect } from 'vitest';
import { geologieGrammatik, geologieVokabular, phrasenFuer } from './geologiePhrasen';
import { buildGrammar } from '../hooks/useVoskRecognition';
import { BODENARTEN, HINDERNISSE, nameVon } from '../utils/geologie';

/**
 * The geology vocabulary, and the one invariant that binds its two halves.
 *
 * A phrase the matcher can match but the Vosk grammar does not contain can
 * never be recognised: the recognizer only ever emits phrases from its
 * grammar, so the command exists, looks right in the code, and is unreachable
 * by voice. That is the failure this file is mostly here to prevent.
 */

describe('the spoken vocabulary', () => {
  it('covers every soil and every obstruction, and nothing else', () => {
    const nrs = geologieVokabular().map((v) => v.nr).sort((a, b) => a - b);
    expect(nrs).toEqual([
      ...BODENARTEN.map((e) => e.nr),
      ...HINDERNISSE.map((e) => e.nr),
    ].sort((a, b) => a - b));
    expect(nrs).toHaveLength(21);
  });

  it('carries the DIN name, which is what reaches the Geologie text series', () => {
    for (const v of geologieVokabular()) {
      expect(v.name).toBe(nameVon(v.nr));
    }
  });

  it('offers soils bare and prefixed', () => {
    expect(phrasenFuer('Schluff', false)).toEqual([
      'schluff', 'schicht schluff', 'bodenart schluff', 'geologie schluff',
    ]);
  });

  it('prefixes obstructions with "hindernis" and drops the redundant word', () => {
    expect(phrasenFuer('Hindernis Beton', true)).toEqual(['beton', 'hindernis beton']);
  });

  it('splits a comma-named soil into both words', () => {
    expect(phrasenFuer('Torf, Humus', false)).toEqual([
      'torf', 'schicht torf', 'bodenart torf', 'geologie torf',
      'humus', 'schicht humus', 'bodenart humus', 'geologie humus',
    ]);
  });

  it('produces lower-case phrases only', () => {
    for (const p of geologieGrammatik()) expect(p).toBe(p.toLowerCase());
  });

  it('produces no duplicate phrase within a ground type', () => {
    for (const v of geologieVokabular()) {
      expect(new Set(v.phrases).size).toBe(v.phrases.length);
    }
  });

  it('never maps one phrase to two different ground types', () => {
    // "sand" must not also select Grobsand, or a spoken layer is a coin toss.
    const besitzer = new Map<string, number>();
    for (const v of geologieVokabular()) {
      for (const p of v.phrases) {
        expect(besitzer.has(p)).toBe(false);
        besitzer.set(p, v.nr);
      }
    }
  });
});

describe('the Vosk grammar', () => {
  it('contains every phrase a geology command can match', () => {
    // Without this, a command is reachable in code and unreachable by voice.
    const grammar = new Set(JSON.parse(buildGrammar([])) as string[]);
    for (const v of geologieVokabular()) {
      for (const p of v.phrases) {
        expect(grammar.has(p), `missing from grammar: "${p}"`).toBe(true);
      }
    }
  });

  it('keeps the existing commands in the grammar', () => {
    const grammar = new Set(JSON.parse(buildGrammar([])) as string[]);
    expect(grammar.has('aufzeichnung beenden')).toBe(true);
    expect(grammar.has('daten hochladen')).toBe(true);
    expect(grammar.has('[unk]')).toBe(true);
  });

  it('stays small enough for a small offline model', () => {
    // The full addVariations expansion over 76 geology phrases would add some
    // 600 entries; the bare "bitte" prefix is the only one kept. This is a
    // ceiling, not a target — if it trips, check what started expanding.
    const grammar = JSON.parse(buildGrammar([])) as string[];
    expect(grammar.length).toBeLessThan(600);
  });
});
