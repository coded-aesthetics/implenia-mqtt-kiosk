import type { FastifyInstance } from 'fastify';
import { updater } from '../updater.js';

export function registerDataRoutes(app: FastifyInstance): void {
  app.post('/api/update', async (_request, reply) => {
    if (!updater.updateAvailable) {
      return reply.status(404).send({ error: 'No update available' });
    }
    updater.downloadAndApply().catch((err) => {
      console.error('[Updater] downloadAndApply error:', err);
    });
    return reply.send({ status: 'applying', version: updater.updateAvailable });
  });

  app.post('/api/update/upload', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'Keine Datei hochgeladen' });
    }

    if (!file.filename.endsWith('.tar.gz')) {
      return reply.status(400).send({ error: 'Nur .tar.gz Dateien erlaubt' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const result = await updater.applyUploadedTar(buffer, file.filename);
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    return reply.send({ status: 'applying', version: result.version });
  });
}
