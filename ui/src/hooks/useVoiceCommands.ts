import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { expandCommands, matchCommandWithReason } from '../voice/matchCommand';
import { buildCommands } from '../voice/voiceCommands';
import type { VoiceContext } from '../voice/matchCommand';

export type VoiceFeedback =
  | { type: 'listening'; interim: string | null }
  | { type: 'success'; description: string; transcript: string }
  | { type: 'blocked'; reason: string; transcript: string }
  | { type: 'no-match'; transcript: string }
  | { type: 'error'; message: string }
  | null;

export function useVoiceCommands(ctx: VoiceContext) {
  const { state: speech, startListening, stopListening, reset, isSupported } =
    useSpeechRecognition();
  const [feedback, setFeedback] = useState<VoiceFeedback>(null);

  const commands = useMemo(() => buildCommands(), []);
  const expanded = useMemo(
    () => expandCommands(commands, ctx.elementNames),
    [commands, ctx.elementNames],
  );

  // Process final transcript
  useEffect(() => {
    if (speech.status !== 'result' || !speech.transcript) return;

    const transcript = speech.transcript;
    const match = matchCommandWithReason(transcript, expanded, ctx);

    if ('result' in match) {
      setFeedback({
        type: 'success',
        description: match.result.command.description,
        transcript,
      });
      try {
        match.result.command.execute(ctx, match.result.params);
      } catch (err) {
        console.error('[Voice] Command execution error:', err);
      }
    } else if ('blocked' in match) {
      setFeedback({ type: 'blocked', reason: match.blocked, transcript });
    } else {
      setFeedback({ type: 'no-match', transcript });
    }

    reset();
  }, [speech.status, speech.transcript]);

  // Update listening feedback with interim results
  useEffect(() => {
    if (speech.status === 'listening') {
      setFeedback({ type: 'listening', interim: speech.interimTranscript });
    }
  }, [speech.status, speech.interimTranscript]);

  // Show speech errors
  useEffect(() => {
    if (speech.status === 'error' && speech.error) {
      setFeedback({ type: 'error', message: speech.error });
      reset();
    }
  }, [speech.status, speech.error, reset]);

  // Auto-dismiss feedback
  useEffect(() => {
    if (!feedback || feedback.type === 'listening') return;
    const delay = feedback.type === 'success' ? 2000 : 3000;
    const id = setTimeout(() => setFeedback(null), delay);
    return () => clearTimeout(id);
  }, [feedback]);

  const dismiss = useCallback(() => setFeedback(null), []);

  return {
    isListening: speech.status === 'listening',
    feedback,
    isSupported,
    startListening,
    stopListening,
    dismiss,
  };
}
