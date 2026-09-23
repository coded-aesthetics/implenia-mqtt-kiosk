import { useState, useCallback, useRef, useEffect } from 'react';

export type ReplaySpeed = 1 | 10 | 60 | 'max';

export interface ReplayState {
  file: string | null;
  totalMessages: number;
  position: number;
  speed: ReplaySpeed;
  playing: boolean;
  fastForwarding: boolean;
  currentOffsetMs: number;
  durationMs: number;
  sessionId: number | null;
  readingCount: number;
}

const EMPTY: ReplayState = {
  file: null,
  totalMessages: 0,
  position: 0,
  speed: 1,
  playing: false,
  fastForwarding: false,
  currentOffsetMs: 0,
  durationMs: 0,
  sessionId: null,
  readingCount: 0,
};

/**
 * POST a replay command and return the response body. The replay routes all
 * include the current ReplayState in their response, so the caller can update
 * immediately rather than waiting for the next poll.
 */
async function post(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<Record<string, unknown>>;
}

/** Pick the ReplayState fields out of a response that may have extra keys. */
function toState(d: Record<string, unknown>): ReplayState {
  return {
    file: (d.file as string) ?? null,
    totalMessages: (d.totalMessages as number) ?? 0,
    position: (d.position as number) ?? 0,
    speed: (d.speed as ReplaySpeed) ?? 1,
    playing: (d.playing as boolean) ?? false,
    fastForwarding: (d.fastForwarding as boolean) ?? false,
    currentOffsetMs: (d.currentOffsetMs as number) ?? 0,
    durationMs: (d.durationMs as number) ?? 0,
    sessionId: (d.sessionId as number) ?? null,
    readingCount: (d.readingCount as number) ?? 0,
  };
}

export function useReplay(enabled: boolean) {
  const [state, setState] = useState<ReplayState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Background poll — keeps position/readingCount current during playback.
  const poll = useCallback(() => {
    fetch('/api/replay/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setState(toState(d as Record<string, unknown>)); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) return;
    poll();
    pollRef.current = setInterval(poll, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [enabled, poll]);

  // Each control action updates state from the response immediately.

  const load = useCallback(async (file: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/replay/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      // /load returns { messages, durationMs, file } — not the full state.
      // Fetch the full state so file/totalMessages/etc. are all set.
      const full = await fetch('/api/replay/state').then((r) => r.json());
      setState(toState(full as Record<string, unknown>));
    } catch {
      setError('Server nicht erreichbar');
    } finally {
      setLoading(false);
    }
  }, []);

  const play = useCallback(async () => {
    const res = await post('/api/replay/play');
    setState(toState(res));
  }, []);

  const pause = useCallback(async () => {
    const res = await post('/api/replay/pause');
    setState(toState(res));
  }, []);

  const stop = useCallback(async () => {
    const res = await post('/api/replay/stop');
    setState(toState(res));
  }, []);

  const setSpeed = useCallback(async (speed: ReplaySpeed) => {
    const res = await post('/api/replay/speed', { speed });
    setState(toState(res));
  }, []);

  const seek = useCallback(async (offsetMs: number) => {
    setLoading(true);
    try {
      const res = await post('/api/replay/seek', { offsetMs });
      setState(toState(res));
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    state,
    loading,
    error,
    load,
    play,
    pause,
    stop,
    setSpeed,
    seek,
    active: state.file !== null,
  };
}
