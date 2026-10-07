import type { VoiceCommand, VoiceContext } from './matchCommand';
import { navigate } from '../hooks/useHashRouter';
import { geologieVokabular } from './geologiePhrasen';
import { GEOLOGIE_ERFASST } from '../hooks/useGeologieErfassung';

export function buildCommands(): VoiceCommand[] {
  return [
    // --- Recording controls ---
    {
      id: 'recording.start',
      phrases: [
        'aufzeichnung starten',
        'aufzeichnung beginnen',
        'aufnahme starten',
        'aufnahme beginnen',
        'aufnahme',
        'recording starten',
        'start aufnahme',
        'starten',
      ],
      precondition: (ctx) =>
        (ctx.route.page === 'element' || ctx.route.page === 'bohren') && !ctx.recordingState.active,
      preconditionHint: 'Aufzeichnung läuft bereits oder kein Element geöffnet',
      execute: async (ctx) => {
        const elementName = ctx.route.params.name;
        if (!elementName) return;
        await fetch('/api/recording/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elementName }),
        });
      },
      description: 'Aufzeichnung starten',
    },
    {
      id: 'recording.stop',
      phrases: [
        'aufzeichnung beenden',
        'aufzeichnung stoppen',
        'aufnahme beenden',
        'aufnahme stoppen',
        'recording stoppen',
        'stop',
        'stopp',
        'beenden',
        'schluss',
      ],
      precondition: (ctx) => ctx.recordingState.active,
      preconditionHint: 'Keine aktive Aufzeichnung',
      /**
       * Stops directly, unlike the Beenden button, which goes to the geology
       * sign-off first.
       *
       * Deliberate, and it costs nothing: the server back-fills the profile on
       * every stop, so a spoken stop uploads exactly what a reviewed one would.
       * Routing voice through the sign-off would strand a hands-free operator
       * on a screen with no spoken way off it — saying "beenden" again would
       * only open it a second time.
       */
      execute: async () => {
        await fetch('/api/recording/stop', { method: 'POST' });
      },
      description: 'Aufzeichnung beenden',
    },
    {
      id: 'recording.upload',
      phrases: [
        'daten hochladen',
        'hochladen',
        'upload',
        'daten senden',
        'senden',
      ],
      precondition: (ctx) =>
        !ctx.recordingState.active &&
        ctx.recordingState.sessionId !== null &&
        ctx.recordingState.readingCount > 0,
      preconditionHint: 'Keine Daten zum Hochladen',
      execute: async (ctx) => {
        if (!ctx.recordingState.sessionId) return;
        await fetch(`/api/recording/${ctx.recordingState.sessionId}/upload`, {
          method: 'POST',
        });
      },
      description: 'Daten hochladen',
    },

    // --- Navigation ---
    {
      id: 'nav.element',
      phrases: [
        '{element}',
        'säule {element}',
        'element {element}',
        'gehe zu {element}',
        'öffne {element}',
      ],
      precondition: (ctx) => ctx.route.page === 'home',
      preconditionHint: 'Navigation nur von der Startseite möglich',
      execute: (_ctx, params) => {
        navigate(`element/${encodeURIComponent(params.element)}`);
      },
      description: 'Element öffnen',
    },
    {
      id: 'nav.home',
      phrases: [
        'zurück',
        'startseite',
        'home',
        'übersicht',
        'zurück zur übersicht',
        'schichtauftrag',
        'schicht auftrag',
      ],
      precondition: (ctx) => ctx.route.page !== 'home',
      preconditionHint: 'Bereits auf der Startseite',
      execute: () => {
        navigate('/');
      },
      description: 'Zur Startseite',
    },

    // --- Tab switching ---
    {
      id: 'tab.messwerte',
      phrases: [
        'messwerte',
        'messwerte zeigen',
        'live daten',
        'live',
        'sensoren',
      ],
      precondition: (ctx) => ctx.route.page === 'element' || ctx.route.page === 'bohren',
      preconditionHint: 'Kein Element geöffnet',
      execute: (ctx) => {
        ctx.setActiveTab('messwerte');
      },
      description: 'Messwerte anzeigen',
    },
    {
      id: 'tab.vorgabe',
      phrases: [
        'vorgabe',
        'vorgaben',
        'vorgaben zeigen',
        'sollwerte',
        'spezifikation',
      ],
      precondition: (ctx) => ctx.route.page === 'element' || ctx.route.page === 'bohren',
      preconditionHint: 'Kein Element geöffnet',
      execute: (ctx) => {
        ctx.setActiveTab('vorgabe');
      },
      description: 'Vorgaben anzeigen',
    },

    // --- Comment tab (element page) ---
    {
      id: 'tab.kommentare',
      phrases: [
        'kommentare',
        'kommentare zeigen',
        'zeige kommentare',
        'kommentarseite',
      ],
      precondition: (ctx) => ctx.route.page === 'element' || ctx.route.page === 'bohren',
      preconditionHint: 'Kein Element geöffnet',
      execute: (ctx) => {
        ctx.setActiveTab('kommentare');
      },
      description: 'Kommentare anzeigen',
    },

    // --- Comment queue navigation (global) ---
    {
      id: 'nav.queue',
      phrases: [
        'warteschlange',
        'kommentar warteschlange',
        'alle kommentare',
      ],
      precondition: (ctx) => ctx.route.page !== 'comments',
      preconditionHint: 'Bereits auf der Warteschlange',
      execute: () => {
        navigate('comments');
      },
      description: 'Warteschlange anzeigen',
    },

    // --- Comment dictation ---
    {
      id: 'comment.dictate',
      phrases: [
        'kommentar',
        'kommentar hinzufügen',
        'anmerkung',
      ],
      precondition: (ctx) => ctx.route.page === 'element' || ctx.route.page === 'bohren',
      preconditionHint: 'Kein Element geöffnet',
      execute: () => {
        // Dictation mode is handled by useVoiceCommands — this is a trigger only
      },
      description: 'Kommentar diktieren',
    },

    // --- Composite: navigate + start recording ---
    {
      id: 'composite.herstellen',
      phrases: [
        'säule {element} herstellen',
        '{element} herstellen',
        '{element} aufnehmen',
      ],
      precondition: (ctx) => !ctx.recordingState.active,
      preconditionHint: 'Aufzeichnung läuft bereits',
      execute: async (_ctx: VoiceContext, params: Record<string, string>) => {
        navigate(`element/${encodeURIComponent(params.element)}`);
        await fetch('/api/recording/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elementName: params.element }),
        });
      },
      description: 'Element herstellen',
    },

    ...geologieBefehle(),
  ];
}

/**
 * One command per ground type reachable by voice.
 *
 * Generated rather than written out: the vocabulary is the DIN 4023 tables, and
 * a hand-maintained copy would drift from the tiles the picker shows. One
 * command per type instead of a `{boden}` placeholder because the matcher only
 * expands `{element}`, and twenty-one generated commands are cheaper than a new
 * placeholder kind in the hot path of every utterance.
 *
 * No depth is sent: the server dates the reading at the exact `received_at` of
 * its latest depth reading, which is what implenia-web needs to turn it into a
 * layer at all.
 */
function geologieBefehle(): VoiceCommand[] {
  return geologieVokabular().map((v) => ({
    id: `geologie.${v.nr}`,
    phrases: v.phrases,
    // Matches the buttons: geology is only meaningful while the rig is going
    // down. Without the mode check a layer could be spoken during Auffüllen,
    // which the touchscreen does not allow.
    precondition: (ctx) =>
      ctx.recordingState.active && ctx.recordingState.operatingMode === 'bohren',
    preconditionHint: 'Geologie kann nur während des Bohrens erfasst werden',
    execute: async () => {
      const res = await fetch('/api/recording/geology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nr: v.nr, name: v.name }),
      });
      // A spoken entry that fails must not be silent — it is a measurement
      // lost with nothing on screen to say so.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Die Geologie konnte nicht erfasst werden (Fehler ${res.status}).`);
      }
      // This write happened outside React, so nothing would otherwise tell
      // useGeologieErfassung about it. See GEOLOGIE_ERFASST.
      window.dispatchEvent(new CustomEvent(GEOLOGIE_ERFASST));
    },
    description: `Geologie: ${v.name}`,
  }));
}
