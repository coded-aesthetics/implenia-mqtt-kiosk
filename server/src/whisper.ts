import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '';

/**
 * Domain-specific prompt to guide Whisper's vocabulary.
 * Add construction terms here that the model frequently misrecognises.
 */
const WHISPER_PROMPT = process.env.WHISPER_PROMPT || [
  'Baustellenprotokoll:',
  'Bohrgestänge', 'Suspensionsdruck', 'Bewehrung', 'Bewehrungskorb',
  'Mattenbewehrung', 'Betondeckung', 'Betonstahl', 'BSt 500',
  'Bohrpfahl', 'Bohrpfahlwand', 'Schlitzwand', 'Dichtwand',
  'Spritzbeton', 'Rüttelstampfsäule',
  'Betonage', 'Betonierabschnitt', 'Frischbetonprobe',
  'Auflockerungszone', 'Pfahlkopf', 'Pfahlfuß',
  'Unterfangung', 'Spundwand', 'Verbauträger', 'Ausfachung',
  'Gründungssohle', 'Sauberkeitsschicht', 'Magerbeton', 'Schichtdicke',
  'WU-Beton', 'Bitumenschweißbahn', 'Voranstrich', 'Bodenplatte',
].join(', ');

let available: boolean | null = null;

// Serial queue — process one transcription at a time, no timeout pressure
let queueTail: Promise<unknown> = Promise.resolve();
let queueDepth = 0;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  queueDepth++;
  if (queueDepth > 1) {
    console.log(`[Whisper] Queued (${queueDepth - 1} ahead)`);
  }
  const task = queueTail.then(fn, fn); // run even if previous failed
  queueTail = task.catch(() => {}); // prevent unhandled rejection
  task.finally(() => queueDepth--);
  return task;
}

/** Check if whisper-cpp is available on this system. */
export async function isWhisperAvailable(): Promise<boolean> {
  if (available !== null) return available;

  if (!WHISPER_MODEL) {
    console.log('[Whisper] WHISPER_MODEL not set — whisper transcription disabled');
    available = false;
    return false;
  }

  return new Promise((resolve) => {
    execFile(WHISPER_BIN, ['--help'], { timeout: 5000 }, (err) => {
      available = !err;
      if (available) {
        console.log(`[Whisper] Found ${WHISPER_BIN}, model: ${WHISPER_MODEL}`);
        console.log(`[Whisper] Prompt: ${WHISPER_PROMPT.slice(0, 80)}${WHISPER_PROMPT.length > 80 ? '...' : ''}`);
      } else {
        console.log(`[Whisper] ${WHISPER_BIN} not found — whisper transcription disabled`);
      }
      resolve(available);
    });
  });
}

/**
 * Write a WAV header for 16-bit PCM mono audio at the given sample rate.
 */
function wavHeader(dataLength: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // 16-bit mono
  const blockAlign = 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Transcribe raw 16-bit PCM audio (16 kHz mono) using whisper.cpp.
 * Queued serially — only one whisper process runs at a time, no timeout.
 * Returns the transcribed text, or null if whisper is unavailable.
 */
export async function transcribe(pcmBuffer: Buffer, sampleRate = 16000): Promise<string | null> {
  if (!(await isWhisperAvailable())) return null;
  return enqueue(() => runWhisper(pcmBuffer, sampleRate));
}

async function runWhisper(pcmBuffer: Buffer, sampleRate: number): Promise<string | null> {
  const id = randomUUID();
  const wavPath = join(tmpdir(), `kiosk-whisper-${id}.wav`);

  try {
    const durationSec = (pcmBuffer.length / 2 / sampleRate).toFixed(1);
    console.log(`[Whisper] Transcribing ${durationSec}s of audio (${(pcmBuffer.length / 1024).toFixed(0)} KB)`);

    // Write WAV file
    const header = wavHeader(pcmBuffer.length, sampleRate);
    await writeFile(wavPath, Buffer.concat([header, pcmBuffer]));

    // Run whisper-cpp — no timeout, let it take as long as it needs
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        WHISPER_BIN,
        [
          '-m', WHISPER_MODEL,
          '-f', wavPath,
          '-l', 'de',
          '--no-timestamps',
          '-np',              // no progress
          '--max-context', '0', // don't use prior text as context — reduces hallucination
          '--prompt', WHISPER_PROMPT,
        ],
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (stderr) {
            console.error('[Whisper] stderr:', stderr);
          }
          if (err) {
            console.error('[Whisper] Exit code:', (err as any).code, 'Signal:', (err as any).signal);
            reject(new Error(stderr || err.message));
            return;
          }
          // whisper-cpp outputs text lines, trim and join
          const result = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' ')
            .trim();
          resolve(result);
        },
      );
    });

    console.log(`[Whisper] Done (${durationSec}s audio): "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
    return text || null;
  } finally {
    // Clean up temp file
    await unlink(wavPath).catch(() => {});
  }
}
