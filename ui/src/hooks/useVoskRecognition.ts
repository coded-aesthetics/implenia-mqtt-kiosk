import { useState, useRef, useCallback, useEffect } from 'react';
import { createModel, type Model, type KaldiRecognizer } from 'vosk-browser';
import { elementNameVariants } from '../voice/elementNameVariants';

export type SpeechStatus = 'idle' | 'listening' | 'result' | 'error';

export interface SpeechState {
  status: SpeechStatus;
  transcript: string | null;
  interimTranscript: string | null;
  error: string | null;
}

const MODEL_URL = '/vosk-model-de.tar.gz';
const SAMPLE_RATE = 16000;

// ── Grammar builder ──────────────────────────────────────────────────────────

/** All base command phrases (mirrored from voiceCommands.ts) */
const BASE_PHRASES: string[][] = [
  // recording.start
  [
    'aufzeichnung starten', 'aufnahme starten', 'aufnahme beginnen',
    'aufzeichnung beginnen', 'aufnahme', 'recording starten', 'start aufnahme', 'starten',
  ],
  // recording.stop
  [
    'aufzeichnung beenden', 'aufnahme beenden', 'aufnahme stoppen',
    'aufzeichnung stoppen', 'recording stoppen', 'stop', 'stopp', 'beenden', 'schluss',
  ],
  // recording.upload
  [
    'daten hochladen', 'hochladen', 'upload', 'daten senden', 'senden',
  ],
  // nav.home
  [
    'zurück', 'startseite', 'home', 'übersicht',
    'zurück zur übersicht', 'schichtauftrag',
  ],
  // tab.messwerte
  [
    'messwerte', 'messwerte zeigen', 'live daten', 'live', 'sensoren',
  ],
  // tab.vorgabe
  [
    'vorgabe', 'vorgaben', 'vorgaben zeigen', 'sollwerte', 'spezifikation',
  ],
];

/** Prefixes that make commands sound more natural */
const POLITE_PREFIXES = ['bitte', 'jetzt', 'mal', 'dann', 'also'];
const REQUEST_PREFIXES = ['kannst du', 'könntest du'];
const DISPLAY_PREFIXES = ['zeig mir', 'zeig mir die', 'zeig mir den'];

function addVariations(phrase: string): string[] {
  const variants = [phrase];

  // bitte prefix and suffix
  variants.push(`bitte ${phrase}`);
  if (phrase.split(' ').length > 1) {
    variants.push(`${phrase} bitte`);
  }

  // temporal / filler prefixes
  for (const prefix of POLITE_PREFIXES) {
    if (prefix !== 'bitte') {
      variants.push(`${prefix} ${phrase}`);
    }
  }

  // request form for action verbs
  if (phrase.includes('starten') || phrase.includes('beenden') || phrase.includes('stoppen') ||
      phrase.includes('hochladen') || phrase.includes('senden') || phrase.includes('beginnen')) {
    for (const prefix of REQUEST_PREFIXES) {
      variants.push(`${prefix} ${phrase}`);
    }
  }

  // display form for view commands
  if (phrase.includes('messwerte') || phrase.includes('vorgabe') || phrase.includes('sollwerte') ||
      phrase.includes('sensoren') || phrase.includes('live') || phrase.includes('spezifikation') ||
      phrase.includes('übersicht') || phrase.includes('startseite')) {
    for (const prefix of DISPLAY_PREFIXES) {
      variants.push(`${prefix} ${phrase}`);
    }
  }

  return variants;
}

function buildElementPhrases(name: string): string[] {
  const variants = elementNameVariants(name);
  const phrases: string[] = [];

  for (const v of variants) {
    // Direct name
    phrases.push(v);

    // Navigation patterns
    const navPatterns = [
      `säule ${v}`, `element ${v}`,
      `gehe zu ${v}`, `geh zu ${v}`, `öffne ${v}`,
    ];

    // Composite patterns (herstellen)
    const compositePatterns = [
      `säule ${v} herstellen`, `${v} herstellen`, `${v} aufnehmen`,
    ];

    for (const p of [...navPatterns, ...compositePatterns]) {
      phrases.push(p);
      phrases.push(`bitte ${p}`);
      phrases.push(`jetzt ${p}`);
    }

    // Display patterns
    phrases.push(`zeig mir ${v}`);
    phrases.push(`bitte öffne ${v}`);
  }

  return phrases;
}

export function buildGrammar(elementNames: string[]): string {
  const phrases = new Set<string>();

  // Add static command phrases + variations
  for (const group of BASE_PHRASES) {
    for (const phrase of group) {
      for (const variant of addVariations(phrase)) {
        phrases.add(variant);
      }
    }
  }

  // Add element-specific phrases
  for (const name of elementNames) {
    for (const phrase of buildElementPhrases(name)) {
      phrases.add(phrase);
    }
  }

  // Vosk grammar format: JSON array of phrases, plus [unk] for unknown speech
  const grammarArray = [...phrases, '[unk]'];
  return JSON.stringify(grammarArray);
}

// ── Model singleton ──────────────────────────────────────────────────────────

let modelPromise: Promise<Model> | null = null;
let modelFailed = false;

function getModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = createModel(MODEL_URL, -1).catch((err) => {
      console.error('[Vosk] Failed to load model:', err);
      modelFailed = true;
      throw err;
    });
  }
  return modelPromise;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useVoskRecognition(elementNames: string[]) {
  const [state, setState] = useState<SpeechState>({
    status: 'idle',
    transcript: null,
    interimTranscript: null,
    error: null,
  });

  const [modelReady, setModelReady] = useState(false);
  const recognizerRef = useRef<KaldiRecognizer | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const grammarRef = useRef<string>('');

  // Keep grammar up-to-date
  useEffect(() => {
    grammarRef.current = buildGrammar(elementNames);
  }, [elementNames]);

  // Load model on mount
  useEffect(() => {
    getModel()
      .then(() => setModelReady(true))
      .catch(() => setModelReady(false));
  }, []);

  const isSupported = !modelFailed && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const startListening = useCallback(async () => {
    if (!isSupported) return;

    // Clean up any previous session
    if (recognizerRef.current) {
      try { recognizerRef.current.remove(); } catch { /* ignore */ }
      recognizerRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* ignore */ }
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setState({
      status: 'listening',
      transcript: null,
      interimTranscript: null,
      error: null,
    });

    try {
      const model = await getModel();
      const grammar = grammarRef.current;

      const recognizer = new model.KaldiRecognizer(SAMPLE_RATE, grammar);
      recognizerRef.current = recognizer;

      recognizer.on('partialresult', (message: any) => {
        const partial = message.result?.partial;
        if (partial) {
          setState((prev) => ({
            ...prev,
            interimTranscript: partial,
          }));
        }
      });

      recognizer.on('result', (message: any) => {
        const text = message.result?.text;
        if (text && text !== '[unk]') {
          setState({
            status: 'result',
            transcript: text.trim(),
            interimTranscript: null,
            error: null,
          });
        }
      });

      recognizer.on('error', (message: any) => {
        console.error('[Vosk] Recognizer error:', message);
        setState({
          status: 'error',
          transcript: null,
          interimTranscript: null,
          error: 'Spracherkennungsfehler',
        });
      });

      // Set up audio capture
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated but widely supported and simpler than AudioWorklet.
      // vosk-browser's acceptWaveform expects AudioBuffer from ScriptProcessorNode.
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (recognizerRef.current) {
          try {
            recognizerRef.current.acceptWaveform(event.inputBuffer);
          } catch {
            // Recognizer was removed between check and call
          }
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Mikrofon-Zugriff verweigert'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'Kein Mikrofon gefunden'
            : 'Spracherkennung nicht verfügbar';

      setState({
        status: 'error',
        transcript: null,
        interimTranscript: null,
        error: message,
      });
    }
  }, [isSupported]);

  const stopListening = useCallback(() => {
    // Stop audio capture
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Get final result from recognizer
    if (recognizerRef.current) {
      recognizerRef.current.retrieveFinalResult();
      // Give a small delay for the final result event to fire, then clean up
      const rec = recognizerRef.current;
      recognizerRef.current = null;
      setTimeout(() => {
        try { rec.remove(); } catch { /* ignore */ }
      }, 200);
    }

    // If no result came through, go back to idle
    setState((prev) => {
      if (prev.status === 'listening') {
        return { status: 'idle', transcript: null, interimTranscript: null, error: null };
      }
      return prev;
    });
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle', transcript: null, interimTranscript: null, error: null });
  }, []);

  return { state, startListening, stopListening, reset, isSupported: isSupported && modelReady };
}
