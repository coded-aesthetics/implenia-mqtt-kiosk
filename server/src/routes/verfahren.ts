import type { FastifyInstance } from 'fastify';
import {
  VERFAHREN,
  getActiveVerfahren,
  isValidVerfahren,
  loadSensorCsv,
  setActiveVerfahren,
  VerfahrenAlreadySetError,
} from '../sensor-meta.js';

export function registerVerfahrenRoutes(app: FastifyInstance): void {
  app.get('/api/verfahren', async () => {
    return Object.entries(VERFAHREN).map(([key, label]) => ({ key, label }));
  });

  // The Verfahren this machine is set up for. `verfahren: null` means the
  // setup wizard has not run yet — the UI uses this as its first-start gate.
  app.get('/api/verfahren/active', async () => {
    const key = getActiveVerfahren();
    return { verfahren: key, label: key ? VERFAHREN[key] : null };
  });

  // Write-once: see setActiveVerfahren(). Changing it requires a reset.
  app.put<{ Body: { verfahren?: string } }>(
    '/api/verfahren/active',
    async (req, reply) => {
      const { verfahren } = req.body ?? {};
      if (!verfahren || !isValidVerfahren(verfahren)) {
        return reply.status(400).send({
          error:
            'Bitte ein gültiges Verfahren wählen: ' +
            Object.values(VERFAHREN).join(', ') + '.',
        });
      }

      try {
        setActiveVerfahren(verfahren);
      } catch (err) {
        if (err instanceof VerfahrenAlreadySetError) {
          return reply.status(409).send({
            error:
              `Das Verfahren ist bereits auf „${VERFAHREN[err.current]}" festgelegt ` +
              'und kann nicht geändert werden. Um ein anderes Verfahren zu wählen, ' +
              'muss die Software zurückgesetzt werden.',
            current: err.current,
          });
        }
        throw err;
      }

      return reply.send({ verfahren, label: VERFAHREN[verfahren] });
    },
  );

  app.get<{ Params: { type: string }; Querystring: { source?: string } }>(
    '/api/verfahren/:type/sensors',
    async (req, reply) => {
      const { type } = req.params;
      if (!isValidVerfahren(type)) {
        return reply.status(404).send({ error: `Unbekanntes Verfahren: ${type}` });
      }

      const rows = loadSensorCsv(type);
      if (!rows) {
        return reply.status(500).send({ error: 'Sensordefinitionen konnten nicht geladen werden' });
      }

      const source = req.query.source;
      const filtered = source ? rows.filter((r) => r.source === source) : rows;

      return filtered.map((r) => ({
        name: r.name,
        type: r.type,
        unit: r.unit,
        source: r.source,
        role: r.role,
        priority: r.priority,
        alias: r.alias,
      }));
    },
  );
}
