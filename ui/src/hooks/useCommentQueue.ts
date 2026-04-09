import { useState, useEffect, useCallback, useRef } from 'react';

// ── Data model ──────────────────────────────────────────────────────────────

export interface QueuedComment {
  id: string;
  elementName: string;
  createdAt: number;
  status: 'transcribing' | 'ready' | 'sending' | 'sent' | 'error';
  voskText: string;
  whisperText: string | null;
  text: string;
  audioBase64: string | null;
  errorMessage: string | null;
}

const STORAGE_KEY = 'commentQueue';
const SENT_RETENTION_MS = 5 * 60 * 1000; // auto-remove sent items after 5 min

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadQueue(): QueuedComment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const queue: QueuedComment[] = JSON.parse(raw);
    // Reset in-flight items that were interrupted by a page reload
    return queue.map((item) => {
      if (item.status === 'transcribing' || item.status === 'sending') {
        return { ...item, status: 'ready' as const };
      }
      return item;
    });
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedComment[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage full — drop audio from oldest items and retry
    const trimmed = queue.map((item) => ({ ...item, audioBase64: null }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch { /* give up */ }
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes.buffer], { type: 'application/octet-stream' });
}

/** Strip trailing stop words from whisper output. */
function stripStopWords(text: string): string {
  return text.replace(/\s*(fertig|ende)[\s.!,]*$/i, '').trim();
}

async function whisperTranscribe(audioBlob: Blob): Promise<string | null> {
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: audioBlob,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.text?.trim();
    return text ? stripStopWords(text) : null;
  } catch {
    return null;
  }
}

async function postComment(elementName: string, text: string): Promise<void> {
  const res = await fetch(`/api/comment/${encodeURIComponent(elementName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Netzwerkfehler' }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useCommentQueue() {
  const [queue, setQueue] = useState<QueuedComment[]>(loadQueue);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const processingRef = useRef(false);

  // Persist to localStorage on every change
  useEffect(() => {
    saveQueue(queue);
  }, [queue]);

  // Auto-remove sent items after retention period
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setQueue((prev) => {
        const filtered = prev.filter(
          (item) => !(item.status === 'sent' && now - item.createdAt > SENT_RETENTION_MS),
        );
        return filtered.length !== prev.length ? filtered : prev;
      });
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Update a single item in the queue
  const updateItem = useCallback((id: string, updates: Partial<QueuedComment>) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  }, []);

  // Process a single queue item: whisper transcription → API post
  const processItem = useCallback(async (item: QueuedComment) => {
    let finalText = item.text;

    // Step 1: Transcribe if we have audio
    if (item.audioBase64) {
      updateItem(item.id, { status: 'transcribing' });
      const audioBlob = base64ToBlob(item.audioBase64);
      const whisperText = await whisperTranscribe(audioBlob);

      if (whisperText) {
        console.log(`[CommentQueue] Whisper: "${whisperText}" (Vosk: "${item.voskText}")`);
        finalText = whisperText;
        updateItem(item.id, {
          whisperText,
          text: whisperText,
          audioBase64: null,
          status: 'ready',
        });
      } else {
        // Whisper failed — keep Vosk text
        updateItem(item.id, { audioBase64: null, status: 'ready' });
      }
    }

    // Step 2: Post comment
    // Check if item was deleted while transcribing
    const current = queueRef.current.find((i) => i.id === item.id);
    if (!current || current.status === 'sent') return;

    // Use locally tracked text (React state may not have flushed yet)
    // But prefer current.text if user edited it during transcription
    const text = (current.text !== item.voskText ? current.text : finalText).trim();
    if (!text) {
      updateItem(item.id, { status: 'error', errorMessage: 'Kein Text vorhanden' });
      return;
    }

    updateItem(item.id, { status: 'sending' });
    try {
      await postComment(current.elementName, text);
      updateItem(item.id, { status: 'sent', errorMessage: null });
    } catch (err) {
      updateItem(item.id, {
        status: 'error',
        errorMessage: (err as Error).message,
      });
    }
  }, [updateItem]);

  // Process queue sequentially
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    try {
      // Process items that need work
      while (true) {
        const item = queueRef.current.find(
          (i) => i.status === 'transcribing' || i.status === 'ready',
        );
        if (!item) break;
        await processItem(item);
      }
    } finally {
      processingRef.current = false;
    }
  }, [processItem]);

  // Trigger processing on mount and when queue changes
  useEffect(() => {
    const hasWork = queue.some((i) => i.status === 'transcribing' || i.status === 'ready');
    if (hasWork) processQueue();
  }, [queue, processQueue]);

  // ── Public API ──────────────────────────────────────────────────────────

  const enqueue = useCallback(async (elementName: string, voskText: string, audioBlob: Blob) => {
    const audioBase64 = audioBlob.size > 0 ? await blobToBase64(audioBlob) : null;
    const item: QueuedComment = {
      id: crypto.randomUUID(),
      elementName,
      createdAt: Date.now(),
      status: audioBase64 ? 'transcribing' : 'ready',
      voskText,
      whisperText: null,
      text: voskText,
      audioBase64,
      errorMessage: null,
    };
    setQueue((prev) => [item, ...prev]);
  }, []);

  const editText = useCallback((id: string, newText: string) => {
    updateItem(id, { text: newText });
  }, [updateItem]);

  const deleteComment = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const retry = useCallback((id: string) => {
    updateItem(id, { status: 'ready', errorMessage: null });
  }, [updateItem]);

  const pendingCount = queue.filter((i) => i.status !== 'sent').length;

  return { queue, enqueue, editText, deleteComment, retry, pendingCount };
}
