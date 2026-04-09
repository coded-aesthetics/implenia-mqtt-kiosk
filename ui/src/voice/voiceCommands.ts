import type { VoiceCommand, VoiceContext } from './matchCommand';
import { navigate } from '../hooks/useHashRouter';

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
        ctx.route.page === 'element' && !ctx.recordingState.active,
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
        'säule {element}',
        'element {element}',
        'gehe zu {element}',
        'öffne {element}',
      ],
      precondition: () => true,
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
      precondition: (ctx) => ctx.route.page === 'element',
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
      precondition: (ctx) => ctx.route.page === 'element',
      preconditionHint: 'Kein Element geöffnet',
      execute: (ctx) => {
        ctx.setActiveTab('vorgabe');
      },
      description: 'Vorgaben anzeigen',
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
  ];
}
