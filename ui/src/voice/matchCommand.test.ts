import { describe, it, expect } from 'vitest';
import {
  expandCommands,
  matchCommandWithReason,
  type VoiceCommand,
  type VoiceContext,
} from './matchCommand';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal command definitions mirroring voiceCommands.ts (without browser deps) */
function testCommands(): VoiceCommand[] {
  const noop = () => {};
  return [
    {
      id: 'recording.start',
      phrases: [
        'aufzeichnung starten', 'aufzeichnung beginnen',
        'aufnahme starten', 'aufnahme beginnen', 'aufnahme',
        'recording starten', 'start aufnahme', 'starten',
      ],
      precondition: (ctx) => ctx.route.page === 'element' && !ctx.recordingState.active,
      preconditionHint: 'Aufzeichnung läuft bereits oder kein Element geöffnet',
      execute: noop,
      description: 'Aufzeichnung starten',
    },
    {
      id: 'recording.stop',
      phrases: [
        'aufzeichnung beenden', 'aufzeichnung stoppen',
        'aufnahme beenden', 'aufnahme stoppen', 'recording stoppen',
        'stop', 'stopp', 'beenden', 'schluss',
      ],
      precondition: (ctx) => ctx.recordingState.active,
      preconditionHint: 'Keine aktive Aufzeichnung',
      execute: noop,
      description: 'Aufzeichnung beenden',
    },
    {
      id: 'recording.upload',
      phrases: ['daten hochladen', 'hochladen', 'upload', 'daten senden', 'senden'],
      precondition: (ctx) =>
        !ctx.recordingState.active &&
        ctx.recordingState.sessionId !== null &&
        ctx.recordingState.readingCount > 0,
      preconditionHint: 'Keine Daten zum Hochladen',
      execute: noop,
      description: 'Daten hochladen',
    },
    {
      id: 'nav.element',
      phrases: [
        'säule {element}', 'element {element}',
        'gehe zu {element}', 'öffne {element}',
      ],
      precondition: () => true,
      execute: noop,
      description: 'Element öffnen',
    },
    {
      id: 'nav.home',
      phrases: ['zurück', 'startseite', 'home', 'übersicht', 'zurück zur übersicht', 'schichtauftrag'],
      precondition: (ctx) => ctx.route.page !== 'home',
      preconditionHint: 'Bereits auf der Startseite',
      execute: noop,
      description: 'Zur Startseite',
    },
    {
      id: 'tab.messwerte',
      phrases: ['messwerte', 'messwerte zeigen', 'live daten', 'live', 'sensoren'],
      precondition: (ctx) => ctx.route.page === 'element',
      preconditionHint: 'Kein Element geöffnet',
      execute: noop,
      description: 'Messwerte anzeigen',
    },
    {
      id: 'tab.vorgabe',
      phrases: ['vorgabe', 'vorgaben', 'vorgaben zeigen', 'sollwerte', 'spezifikation'],
      precondition: (ctx) => ctx.route.page === 'element',
      preconditionHint: 'Kein Element geöffnet',
      execute: noop,
      description: 'Vorgaben anzeigen',
    },
    {
      id: 'composite.herstellen',
      phrases: ['säule {element} herstellen', '{element} herstellen', '{element} aufnehmen'],
      precondition: (ctx) => !ctx.recordingState.active,
      preconditionHint: 'Aufzeichnung läuft bereits',
      execute: noop,
      description: 'Element herstellen',
    },
  ];
}

const ELEMENT_NAMES = ['C-03', 'B-05', 'F24'];

function makeCtx(overrides: Partial<{
  page: VoiceContext['route']['page'];
  params: Record<string, string>;
  active: boolean;
  sessionId: number | null;
  readingCount: number;
}> = {}): VoiceContext {
  return {
    route: {
      page: overrides.page ?? 'element',
      params: overrides.params ?? { name: 'C-03' },
    },
    recordingState: {
      active: overrides.active ?? false,
      sessionId: overrides.sessionId ?? null,
      elementName: null,
      readingCount: overrides.readingCount ?? 0,
    },
    elementNames: ELEMENT_NAMES,
    setActiveTab: () => {},
    navigate: () => {},
  };
}

function match(transcript: string, ctx?: VoiceContext) {
  const commands = testCommands();
  const expanded = expandCommands(commands, ELEMENT_NAMES);
  const context = ctx ?? makeCtx();
  return matchCommandWithReason(transcript, expanded, context);
}

function expectMatch(transcript: string, commandId: string, ctx?: VoiceContext) {
  const result = match(transcript, ctx);
  expect(result).toHaveProperty('result');
  if ('result' in result) {
    expect(result.result.command.id).toBe(commandId);
  }
}

function expectNoMatch(transcript: string, ctx?: VoiceContext) {
  const result = match(transcript, ctx);
  expect(result).toHaveProperty('noMatch', true);
}

function expectBlocked(transcript: string, ctx?: VoiceContext) {
  const result = match(transcript, ctx);
  expect(result).toHaveProperty('blocked');
}

function expectElement(transcript: string, originalName: string, ctx?: VoiceContext) {
  const result = match(transcript, ctx);
  expect(result).toHaveProperty('result');
  if ('result' in result) {
    expect(result.result.params.element).toBe(originalName);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('matchCommand — exact matches', () => {
  it('matches recording start phrases', () => {
    const ctx = makeCtx({ page: 'element', active: false });
    expectMatch('aufzeichnung starten', 'recording.start', ctx);
    expectMatch('aufzeichnung beginnen', 'recording.start', ctx);
    expectMatch('aufnahme starten', 'recording.start', ctx);
    expectMatch('aufnahme beginnen', 'recording.start', ctx);
    expectMatch('aufnahme', 'recording.start', ctx);
    expectMatch('starten', 'recording.start', ctx);
  });

  it('matches recording stop phrases', () => {
    const ctx = makeCtx({ active: true });
    expectMatch('aufzeichnung beenden', 'recording.stop', ctx);
    expectMatch('aufzeichnung stoppen', 'recording.stop', ctx);
    expectMatch('aufnahme beenden', 'recording.stop', ctx);
    expectMatch('stopp', 'recording.stop', ctx);
    expectMatch('stop', 'recording.stop', ctx);
    expectMatch('beenden', 'recording.stop', ctx);
    expectMatch('schluss', 'recording.stop', ctx);
  });

  it('matches upload phrases', () => {
    const ctx = makeCtx({ active: false, sessionId: 1, readingCount: 10 });
    expectMatch('daten hochladen', 'recording.upload', ctx);
    expectMatch('hochladen', 'recording.upload', ctx);
    expectMatch('upload', 'recording.upload', ctx);
    expectMatch('daten senden', 'recording.upload', ctx);
    expectMatch('senden', 'recording.upload', ctx);
  });

  it('matches navigation home phrases', () => {
    const ctx = makeCtx({ page: 'element' });
    expectMatch('zurück', 'nav.home', ctx);
    expectMatch('startseite', 'nav.home', ctx);
    expectMatch('übersicht', 'nav.home', ctx);
    expectMatch('zurück zur übersicht', 'nav.home', ctx);
    expectMatch('schichtauftrag', 'nav.home', ctx);
  });

  it('matches tab switching phrases', () => {
    const ctx = makeCtx({ page: 'element' });
    expectMatch('messwerte', 'tab.messwerte', ctx);
    expectMatch('messwerte zeigen', 'tab.messwerte', ctx);
    expectMatch('live daten', 'tab.messwerte', ctx);
    expectMatch('sensoren', 'tab.messwerte', ctx);
    expectMatch('vorgabe', 'tab.vorgabe', ctx);
    expectMatch('vorgaben', 'tab.vorgabe', ctx);
    expectMatch('sollwerte', 'tab.vorgabe', ctx);
  });
});

describe('matchCommand — element navigation', () => {
  it('matches element names with prefix keywords', () => {
    expectMatch('säule c 03', 'nav.element');
    expectMatch('säule c drei', 'nav.element');
    expectMatch('säule c null drei', 'nav.element');
    expectMatch('element c drei', 'nav.element');
    expectMatch('gehe zu c drei', 'nav.element');
    expectMatch('öffne c drei', 'nav.element');
  });

  it('resolves spoken variants to the original element name', () => {
    expectElement('säule c drei', 'C-03');
    expectElement('säule c null drei', 'C-03');
    expectElement('säule c 03', 'C-03');
    expectElement('gehe zu b fünf', 'B-05');
    expectElement('gehe zu b null fünf', 'B-05');
    expectElement('öffne f vierundzwanzig', 'F24');
    expectElement('öffne f zwei vier', 'F24');
  });

  it('matches composite herstellen commands', () => {
    const ctx = makeCtx({ active: false });
    expectMatch('c drei herstellen', 'composite.herstellen', ctx);
    expectMatch('säule c drei herstellen', 'composite.herstellen', ctx);
    expectMatch('c null drei aufnehmen', 'composite.herstellen', ctx);
  });

  it('resolves herstellen to original element name', () => {
    expectElement('c drei herstellen', 'C-03');
    expectElement('b fünf herstellen', 'B-05');
    expectElement('f zwei vier herstellen', 'F24');
  });
});

describe('matchCommand — filler word handling', () => {
  it('strips filler words and still matches', () => {
    const ctx = makeCtx({ page: 'element', active: false });
    expectMatch('bitte aufnahme starten', 'recording.start', ctx);
    expectMatch('also aufnahme starten', 'recording.start', ctx);
    expectMatch('kannst du aufnahme starten', 'recording.start', ctx);
  });

  it('strips fillers for element navigation', () => {
    expectMatch('bitte öffne c drei', 'nav.element');
    expectMatch('bitte gehe zu c drei', 'nav.element');
  });
});

describe('matchCommand — false positive rejection', () => {
  it('rejects reordered word salad from Vosk grammar', () => {
    expectNoMatch('c gehe zu');
    expectNoMatch('b gehe zu');
    expectNoMatch('drei c säule');
    expectNoMatch('herstellen c');
  });

  it('rejects partial phrases with missing key tokens', () => {
    expectNoMatch('gehe zu');
    expectNoMatch('säule');
    expectNoMatch('öffne');
  });

  it('rejects gibberish', () => {
    expectNoMatch('hallo wie geht es');
    expectNoMatch('wetter morgen');
    expectNoMatch('test eins zwei');
  });

  it('rejects bare element name fragments', () => {
    // Single letters/numbers should not trigger navigation
    expectNoMatch('c');
    expectNoMatch('b');
    expectNoMatch('drei');
  });
});

describe('matchCommand — precondition checks', () => {
  it('blocks recording start when not on element page', () => {
    const ctx = makeCtx({ page: 'home', active: false });
    expectBlocked('aufnahme starten', ctx);
  });

  it('blocks recording start when already recording', () => {
    const ctx = makeCtx({ page: 'element', active: true });
    expectBlocked('aufnahme starten', ctx);
  });

  it('blocks recording stop when not recording', () => {
    const ctx = makeCtx({ active: false });
    expectBlocked('aufzeichnung beenden', ctx);
  });

  it('blocks upload when no session data', () => {
    const ctx = makeCtx({ active: false, sessionId: null, readingCount: 0 });
    expectBlocked('hochladen', ctx);
  });

  it('blocks nav home when already on home', () => {
    const ctx = makeCtx({ page: 'home' });
    expectBlocked('zurück', ctx);
  });

  it('blocks tab switching when not on element page', () => {
    const ctx = makeCtx({ page: 'home' });
    expectBlocked('messwerte', ctx);
    expectBlocked('vorgaben', ctx);
  });

  it('blocks herstellen when recording is active', () => {
    const ctx = makeCtx({ active: true });
    expectBlocked('c drei herstellen', ctx);
  });
});

describe('matchCommand — fuzzy tolerance', () => {
  it('tolerates minor mispronunciations (Levenshtein ≤ 1)', () => {
    const ctx = makeCtx({ page: 'element', active: false });
    // "starden" vs "starten" — edit distance 1
    expectMatch('aufnahme starden', 'recording.start', ctx);
  });

  it('tolerates minor mispronunciations in element names', () => {
    // "deei" vs "drei" — edit distance 1
    expectMatch('gehe zu c deei', 'nav.element');
  });

  it('does not match with too many errors', () => {
    expectNoMatch('aufbahme starben');
  });
});

describe('elementNameVariants', () => {
  // Test the variant generation indirectly through matching
  it('handles hyphenated names like C-03', () => {
    expectElement('säule c drei', 'C-03');
    expectElement('säule c null drei', 'C-03');
    expectElement('säule c 03', 'C-03');
  });

  it('handles concatenated names like F24', () => {
    expectElement('element f vierundzwanzig', 'F24');
    expectElement('element f zwei vier', 'F24');
    expectElement('element f 24', 'F24');
  });

  it('handles names with leading zero like B-05', () => {
    expectElement('gehe zu b fünf', 'B-05');
    expectElement('gehe zu b null fünf', 'B-05');
    expectElement('gehe zu b 05', 'B-05');
  });
});
