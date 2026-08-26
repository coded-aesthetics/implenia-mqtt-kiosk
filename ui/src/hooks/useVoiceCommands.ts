import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useVoskRecognition } from './useVoskRecognition';
import { useWakeWordMode } from './useWakeWordMode';
import { expandCommands, matchCommandWithReason } from '../voice/matchCommand';
import { buildCommands } from '../voice/voiceCommands';
import type { VoiceContext } from '../voice/matchCommand';

export type VoiceFeedback =
  | { type: 'listening'; interim: string | null }
  | { type: 'dictating'; interim: string | null }
  | { type: 'success'; description: string; transcript: string }
  | { type: 'blocked'; reason: string; transcript: string }
  | { type: 'no-match'; transcript: string }
  | { type: 'error'; message: string }
  | null;

/** Generic hook for localStorage-backed settings with cross-tab sync. */
function useLocalStorageSetting(
  eventName: string,
  defaultValue: () => boolean,
): boolean {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    const handler = () => setValue(defaultValue());
    window.addEventListener('storage', handler);
    window.addEventListener(eventName, handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(eventName, handler);
    };
  }, [defaultValue, eventName]);

  return value;
}

function useVoiceEnabledSetting(): boolean {
  return useLocalStorageSetting(
    'voiceEnabledChanged',
    () => localStorage.getItem('voiceEnabled') !== 'false', // default true for backwards compatibility
  );
}

function useMagicWordSetting(): boolean {
  return useLocalStorageSetting(
    'magicWordChanged',
    () => localStorage.getItem('magicWordEnabled') === 'true',
  );
}

export function useVoiceCommands(ctx: VoiceContext) {
  const voiceEnabled = useVoiceEnabledSetting();
  const { state: speech, startListening: pttStart, stopListening: pttStop, reset, isSupported } =
    useVoskRecognition(ctx.elementNames);
  const [feedback, setFeedback] = useState<VoiceFeedback>(null);
  const [pttActive, setPttActive] = useState(false);

  const magicWordEnabled = useMagicWordSetting();

  const commands = useMemo(() => buildCommands(), []);
  const expanded = useMemo(
    () => expandCommands(commands, ctx.elementNames),
    [commands, ctx.elementNames],
  );

  // Stable ref for ctx so handleTranscript always has current context
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // Shared command matching logic used by both PTT and wake word
  const handleTranscript = useCallback((transcript: string) => {
    const match = matchCommandWithReason(transcript, expandedRef.current, ctxRef.current);

    if ('result' in match) {
      // Comment command is handled separately — show dictation prompt for PTT
      if (match.result.command.id === 'comment.dictate') {
        setFeedback({
          type: 'dictating',
          interim: null,
        });
        // For PTT: user needs to press mic again for dictation
        // Wake word mode handles this inline via startDictation()
        return;
      }

      setFeedback({
        type: 'success',
        description: match.result.command.description,
        transcript,
      });
      try {
        match.result.command.execute(ctxRef.current, match.result.params);
      } catch (err) {
        console.error('[Voice] Command execution error:', err);
      }
    } else if ('blocked' in match) {
      setFeedback({ type: 'blocked', reason: match.blocked, transcript });
    } else {
      setFeedback({ type: 'no-match', transcript });
    }
  }, []);

  // Handle completed dictation — fire-and-forget, queue handles whisper + posting
  const handleDictation = useCallback((voskText: string, audioBlob: Blob) => {
    const elementName = ctxRef.current.route.params.name;
    if (!elementName) {
      setFeedback({ type: 'error', message: 'Kein Element ausgewählt' });
      return;
    }
    ctxRef.current.enqueueComment(elementName, voskText, audioBlob);
    setFeedback({ type: 'success', description: 'Kommentar aufgenommen', transcript: '' });
  }, []);

  // Wake word mode — disabled during PTT to avoid mic contention
  const wakeWord = useWakeWordMode(
    ctx.elementNames,
    voiceEnabled && magicWordEnabled && isSupported && !pttActive,
    handleTranscript,
    handleDictation,
  );

  // Process PTT final transcript
  useEffect(() => {
    if (speech.status !== 'result' || !speech.transcript) return;
    handleTranscript(speech.transcript);
    reset();
  }, [speech.status, speech.transcript, handleTranscript, reset]);

  // Update listening feedback with PTT interim results
  useEffect(() => {
    if (speech.status === 'listening') {
      setFeedback({ type: 'listening', interim: speech.interimTranscript });
    }
  }, [speech.status, speech.interimTranscript]);

  // Show wake word interim results
  useEffect(() => {
    if (wakeWord.phase === 'dictating') {
      setFeedback({ type: 'dictating', interim: wakeWord.interimTranscript });
    } else if (wakeWord.interimTranscript) {
      setFeedback({ type: 'listening', interim: wakeWord.interimTranscript });
    }
  }, [wakeWord.phase, wakeWord.interimTranscript]);

  // Show speech errors
  useEffect(() => {
    if (speech.status === 'error' && speech.error) {
      setFeedback({ type: 'error', message: speech.error });
      reset();
    }
  }, [speech.status, speech.error, reset]);

  // Auto-dismiss feedback
  useEffect(() => {
    if (!feedback || feedback.type === 'listening' || feedback.type === 'dictating') return;
    const delay = feedback.type === 'success' ? 2000 : 3000;
    const id = setTimeout(() => setFeedback(null), delay);
    return () => clearTimeout(id);
  }, [feedback]);

  const dismiss = useCallback(() => setFeedback(null), []);

  // PTT wrappers that pause/resume wake word mode
  const startListening = useCallback(() => {
    setPttActive(true);
    pttStart();
  }, [pttStart]);

  const stopListening = useCallback(() => {
    pttStop();
    // Delay re-enabling wake word so PTT result can process first
    setTimeout(() => setPttActive(false), 500);
  }, [pttStop]);

  return {
    isListening: speech.status === 'listening',
    feedback,
    isSupported: isSupported && voiceEnabled,
    startListening,
    stopListening,
    dismiss,
    wakeWordPhase: wakeWord.phase,
  };
}
