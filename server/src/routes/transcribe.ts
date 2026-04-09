import type { FastifyInstance } from 'fastify';
import { transcribe, isWhisperAvailable } from '../whisper.js';

export function registerTranscribeRoutes(app: FastifyInstance): void {
  // Register raw body parser for audio content types
  // 10 MB limit — ~5 minutes of 16 kHz 16-bit mono audio
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // Accept raw 16-bit PCM audio (16 kHz mono), return whisper transcription
  app.post('/api/transcribe', async (request, reply) => {
    if (!(await isWhisperAvailable())) {
      return reply.status(503).send({ error: 'Whisper not available' });
    }

    const rawBody = await request.body as Buffer;
    if (!rawBody || rawBody.length === 0) {
      return reply.status(400).send({ error: 'No audio data' });
    }

    try {
      const text = await transcribe(Buffer.from(rawBody));
      return reply.send({ text: text || '' });
    } catch (err) {
      console.error('[Transcribe] Error:', (err as Error).message);
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Check whisper availability (for UI to know whether to try)
  app.get('/api/transcribe/status', async (_request, reply) => {
    const available = await isWhisperAvailable();
    return reply.send({ available });
  });
}
