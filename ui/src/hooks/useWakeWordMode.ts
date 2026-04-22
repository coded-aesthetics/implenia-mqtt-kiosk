import { useState, useRef, useCallback, useEffect } from 'react';
import { getModel, buildGrammar, SAMPLE_RATE } from './useVoskRecognition';
import type { KaldiRecognizer } from 'vosk-browser';

export type WakeWordPhase = 'idle' | 'listening' | 'dictating';

const WAKE_WORD = 'computer';
const DICTATION_SILENCE_MS = 4000;
const STOP_WORDS = ['fertig', 'ende'];

/**
 * Builds a grammar where every command phrase is prefixed with "computer".
 * This lets Vosk recognise "computer aufnahme starten" or "computer f zwölf"
 * as a single continuous utterance — no recognizer swap, no latency.
 */
function buildWakeWordGrammar(elementNames: string[]): string {
  const baseGrammar = buildGrammar(elementNames);
  const basePhrases: string[] = JSON.parse(baseGrammar);

  const prefixed = new Set<string>();
  for (const phrase of basePhrases) {
    if (phrase === '[unk]') continue;
    prefixed.add(`${WAKE_WORD} ${phrase}`);
  }

  return JSON.stringify([...prefixed, '[unk]']);
}

/** Strip the "computer" prefix from a recognised phrase and return the command portion. */
function stripWakeWord(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith(WAKE_WORD)) return null;
  const rest = lower.slice(WAKE_WORD.length).trim();
  return rest.length > 0 ? rest : null;
}

/** Check if a transcript ends with a stop word and strip it. */
function checkStopWord(text: string): { stopped: boolean; cleaned: string } {
  const trimmed = text.trim();
  for (const word of STOP_WORDS) {
    // Check if the last word is a stop word
    if (trimmed.endsWith(` ${word}`) || trimmed === word) {
      const cleaned = trimmed === word ? '' : trimmed.slice(0, -(word.length + 1)).trim();
      return { stopped: true, cleaned };
    }
  }
  return { stopped: false, cleaned: trimmed };
}

/** Convert accumulated Float32 audio chunks to a 16-bit PCM blob for server-side transcription. */
function float32ChunksToInt16Blob(chunks: Float32Array[]): Blob {
  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.length;
  const int16 = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      int16[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return new Blob([int16.buffer], { type: 'application/octet-stream' });
}

/** IDs of commands that trigger dictation mode instead of normal execution. */
const DICTATION_COMMAND_IDS = new Set(['comment.dictate']);

export function useWakeWordMode(
  elementNames: string[],
  enabled: boolean,
  onTranscript: (transcript: string) => void,
  onDictation: (voskText: string, audioBlob: Blob) => void,
): {
  phase: WakeWordPhase;
  interimTranscript: string | null;
} {
  const [phase, setPhase] = useState<WakeWordPhase>('idle');
  const [interimTranscript, setInterimTranscript] = useState<string | null>(null);

  const recognizerRef = useRef<KaldiRecognizer | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onDictationRef = useRef(onDictation);
  const grammarRef = useRef<string>('');
  const phaseRef = useRef<WakeWordPhase>('idle');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictationTextRef = useRef<string>('');
  const audioChunksRef = useRef<Float32Array[]>([]);

  onTranscriptRef.current = onTranscript;
  onDictationRef.current = onDictation;

  useEffect(() => {
    grammarRef.current = buildWakeWordGrammar(elementNames);
  }, [elementNames]);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearSilenceTimer();
    if (recognizerRef.current) {
      try { recognizerRef.current.remove(); } catch { /* ignore */ }
      recognizerRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* ignore */ }
      audioContextRef.current = null;
    }
    phaseRef.current = 'idle';
    setPhase('idle');
    setInterimTranscript(null);
    dictationTextRef.current = '';
    audioChunksRef.current = [];
  }, [clearSilenceTimer]);

  /** Finalize dictation: deliver accumulated text + audio, swap back to command recognizer. */
  const finalizeDictation = useCallback(async () => {
    clearSilenceTimer();
    const text = dictationTextRef.current.trim();
    dictationTextRef.current = '';
    const audioBlob = float32ChunksToInt16Blob(audioChunksRef.current);
    audioChunksRef.current = [];

    if (text || audioBlob.size > 0) {
      onDictationRef.current(text, audioBlob);
    }

    // Swap back to command recognizer
    if (recognizerRef.current) {
      try { recognizerRef.current.remove(); } catch { /* ignore */ }
      recognizerRef.current = null;
    }

    try {
      const rec = await createCommandRecognizer();
      recognizerRef.current = rec;
      phaseRef.current = 'listening';
      setPhase('listening');
      setInterimTranscript(null);
    } catch (err) {
      console.error('[WakeWord] Failed to restore command recognizer:', err);
      cleanup();
    }
  }, [clearSilenceTimer, cleanup]); // createCommandRecognizer added below

  /** Reset the silence timer — called whenever we get new speech during dictation. */
  const resetSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'dictating') {
        // Force final result then finalize
        if (recognizerRef.current) {
          try { recognizerRef.current.retrieveFinalResult(); } catch { /* ignore */ }
        }
        setTimeout(() => finalizeDictation(), 200);
      }
    }, DICTATION_SILENCE_MS);
  }, [clearSilenceTimer, finalizeDictation]);

  /** Enter dictation mode: swap to open-vocabulary recognizer. */
  const startDictation = useCallback(async () => {
    clearSilenceTimer();
    dictationTextRef.current = '';
    audioChunksRef.current = [];
    setInterimTranscript(null);

    // Remove command recognizer
    if (recognizerRef.current) {
      try { recognizerRef.current.remove(); } catch { /* ignore */ }
      recognizerRef.current = null;
    }

    try {
      const model = await getModel();
      // No grammar = open vocabulary (full language model)
      const rec = new model.KaldiRecognizer(SAMPLE_RATE);
      recognizerRef.current = rec;

      rec.on('partialresult', (message: any) => {
        const partial = message.result?.partial;
        if (partial) {
          setInterimTranscript(partial);
          resetSilenceTimer();
        }
      });

      rec.on('result', (message: any) => {
        const text = message.result?.text;
        if (text && text.trim()) {
          const { stopped, cleaned } = checkStopWord(text);
          if (cleaned) {
            dictationTextRef.current += (dictationTextRef.current ? ' ' : '') + cleaned;
            setInterimTranscript(dictationTextRef.current);
          }
          if (stopped) {
            finalizeDictation();
            return;
          }
          resetSilenceTimer();
        }
      });

      phaseRef.current = 'dictating';
      setPhase('dictating');
      resetSilenceTimer();
    } catch (err) {
      console.error('[WakeWord] Failed to start dictation:', err);
      cleanup();
    }
  }, [clearSilenceTimer, resetSilenceTimer, finalizeDictation, cleanup]);

  /** Create the constrained-grammar command recognizer. */
  const createCommandRecognizer = useCallback(async () => {
    const model = await getModel();
    const rec = new model.KaldiRecognizer(SAMPLE_RATE, grammarRef.current);

    rec.on('partialresult', (message: any) => {
      const partial = message.result?.partial;
      if (partial && partial.startsWith(WAKE_WORD) && partial.length > WAKE_WORD.length) {
        setInterimTranscript(partial.slice(WAKE_WORD.length).trim() || null);
      } else {
        setInterimTranscript(null);
      }
    });

    rec.on('result', (message: any) => {
      const text = message.result?.text;
      setInterimTranscript(null);
      if (!text || text === '[unk]') return;

      const command = stripWakeWord(text);
      if (command) {
        // Check if this command should trigger dictation
        const isDictationTrigger = DICTATION_COMMAND_IDS.has(identifyCommand(command));
        if (isDictationTrigger) {
          startDictation();
        } else {
          onTranscriptRef.current(command);
        }
      }
    });

    return rec;
  }, [startDictation]);

  // Start/stop based on enabled prop
  useEffect(() => {
    if (!enabled) {
      cleanup();
      return;
    }

    let cancelled = false;

    async function start() {
      try {
        await getModel();
        if (cancelled) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;

        const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        if (cancelled) { audioContext.close(); stream.getTracks().forEach((t) => t.stop()); return; }
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (event) => {
          if (recognizerRef.current) {
            try {
              recognizerRef.current.acceptWaveform(event.inputBuffer);
            } catch { /* recognizer removed between check and call */ }
          }
          // Buffer raw audio during dictation for server-side whisper transcription
          if (phaseRef.current === 'dictating') {
            const channelData = event.inputBuffer.getChannelData(0);
            audioChunksRef.current.push(new Float32Array(channelData));
          }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        if (cancelled) { cleanup(); return; }

        const rec = await createCommandRecognizer();
        if (cancelled) { try { rec.remove(); } catch { /* */ } cleanup(); return; }
        recognizerRef.current = rec;

        phaseRef.current = 'listening';
        setPhase('listening');
      } catch (err) {
        console.error('[WakeWord] Failed to start:', err);
        if (!cancelled) cleanup();
      }
    }

    start();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { phase, interimTranscript };
}

/**
 * Quick check whether a command transcript matches a dictation-triggering command.
 * We match against the known phrases rather than importing the full command system.
 */
function identifyCommand(transcript: string): string {
  const t = transcript.toLowerCase().trim();
  const COMMENT_PHRASES = ['kommentar', 'kommentar hinzufügen', 'anmerkung'];
  for (const phrase of COMMENT_PHRASES) {
    if (t === phrase) return 'comment.dictate';
  }
  return '';
}
