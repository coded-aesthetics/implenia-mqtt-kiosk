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

async function post(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export function useReplay(enabled: boolean) {
  const [state, setState] = useState<ReplayState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll replay state while a file is loaded
  const poll = useCallback(() => {
    fetch('/api/replay/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setState(d as ReplayState); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Initial fetch
    poll();
    pollRef.current = setInterval(poll, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [enabled, poll]);

  const load = useCallback(async (file: string) => {
    setLoading(true);
    try {
      await post('/api/replay/load', { file });
      poll();
    } finally {
      setLoading(false);
    }
  }, [poll]);

  const play = useCallback(async () => {
    await post('/api/replay/play');
    poll();
  }, [poll]);

  const pause = useCallback(async () => {
    await post('/api/replay/pause');
    poll();
  }, [poll]);

  const stop = useCallback(async () => {
    await post('/api/replay/stop');
    poll();
  }, [poll]);

  const setSpeed = useCallback(async (speed: ReplaySpeed) => {
    await post('/api/replay/speed', { speed });
    poll();
  }, [poll]);

  const seek = useCallback(async (offsetMs: number) => {
    setLoading(true);
    try {
      await post('/api/replay/seek', { offsetMs });
      poll();
    } finally {
      setLoading(false);
    }
  }, [poll]);

  return {
    state,
    loading,
    load,
    play,
    pause,
    stop,
    setSpeed,
    seek,
    /** Whether a dump file is loaded (replay mode is active). */
    active: state.file !== null,
  };
}
