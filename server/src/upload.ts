import { config } from './config.js';
import { connectivity } from './connectivity.js';
import { getPendingReadings, markUploaded, markFailed } from './db.js';

const BATCH_SIZE = 50;
const BASE_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

let timer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;

async function flush(): Promise<void> {
  if (!connectivity.isOnline()) return;

  const readings = getPendingReadings(BATCH_SIZE);
  if (readings.length === 0) return;

  const ids = readings.map((r) => r.id);
  const body = readings.map((r) => ({
    topic: r.topic,
    payload: r.payload,
    receivedAt: r.received_at,
  }));

  try {
    const res = await fetch(config.IMPLENIA_API_URL + '/readings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.IMPLENIA_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      markUploaded(ids);
      consecutiveFailures = 0;
      console.log(`[Upload] Uploaded ${ids.length} readings`);
    } else {
      markFailed(ids);
      consecutiveFailures++;
      console.error(`[Upload] Server responded ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    markFailed(ids);
    consecutiveFailures++;
    console.error('[Upload] Request failed:', (err as Error).message);
  }
}

function getNextInterval(): number {
  if (consecutiveFailures === 0) return BASE_INTERVAL_MS;
  const backoff = Math.min(
    BASE_INTERVAL_MS * Math.pow(2, consecutiveFailures),
    MAX_BACKOFF_MS
  );
  return backoff;
}

function scheduleNext(): void {
  timer = setTimeout(async () => {
    await flush();
    scheduleNext();
  }, getNextInterval());
}

export function startUploader(): void {
  // Flush immediately when connectivity comes online
  connectivity.on('online', () => {
    console.log('[Upload] Connectivity restored — flushing queue');
    flush();
  });

  // Start periodic flush
  scheduleNext();
  console.log('[Upload] Uploader started');
}

export function stopUploader(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
