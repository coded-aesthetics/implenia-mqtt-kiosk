import { useState, useRef, useCallback } from 'react';

export type SpeechStatus = 'idle' | 'listening' | 'result' | 'error';

export interface SpeechState {
  status: SpeechStatus;
  transcript: string | null;
  interimTranscript: string | null;
  error: string | null;
}

const SpeechRecognitionAPI =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : undefined;

export function useSpeechRecognition() {
  const [state, setState] = useState<SpeechState>({
    status: 'idle',
    transcript: null,
    interimTranscript: null,
    error: null,
  });

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isSupported = !!SpeechRecognitionAPI;

  const startListening = useCallback(() => {
    if (!SpeechRecognitionAPI) return;
    if (recognitionRef.current) return;

    const recognition = new SpeechRecognitionAPI();
    recognition.lang = 'de-DE';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    setState({
      status: 'listening',
      transcript: null,
      interimTranscript: null,
      error: null,
    });

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (final) {
        setState({
          status: 'result',
          transcript: final.trim(),
          interimTranscript: null,
          error: null,
        });
      } else if (interim) {
        setState((prev) => ({
          ...prev,
          interimTranscript: interim.trim(),
        }));
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // 'no-speech' and 'aborted' are not real errors
      if (event.error === 'no-speech' || event.error === 'aborted') {
        setState({
          status: 'idle',
          transcript: null,
          interimTranscript: null,
          error: null,
        });
        return;
      }

      const errorMessages: Record<string, string> = {
        'not-allowed': 'Mikrofon-Zugriff verweigert',
        'network': 'Netzwerkfehler bei der Spracherkennung',
        'audio-capture': 'Kein Mikrofon gefunden',
        'service-not-allowed': 'Spracherkennung nicht verfügbar',
      };

      setState({
        status: 'error',
        transcript: null,
        interimTranscript: null,
        error: errorMessages[event.error] ?? `Fehler: ${event.error}`,
      });
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      // Only reset to idle if we didn't already get a result or error
      setState((prev) => {
        if (prev.status === 'listening') {
          return { status: 'idle', transcript: null, interimTranscript: null, error: null };
        }
        return prev;
      });
    };

    recognition.start();
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle', transcript: null, interimTranscript: null, error: null });
  }, []);

  return { state, startListening, stopListening, reset, isSupported };
}
