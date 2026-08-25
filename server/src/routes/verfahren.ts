import type { FastifyInstance } from 'fastify';
import { loadSensorCsv } from '../sensor-meta.js';

const VERFAHREN: Record<string, string> = {
  dsv: 'DSV (Düsenstrahlverfahren)',
  ankerbohren: 'Ankerbohren',
  grosspfahlbohren: 'Grosspfahlbohren',
  injektionsbohren: 'Injektionsbohren',
};

export function registerVerfahrenRoutes(app: FastifyInstance): void {
  app.get('/api/verfahren', async () => {
    return Object.entries(VERFAHREN).map(([key, label]) => ({ key, label }));
  });

  app.get<{ Params: { type: string }; Querystring: { source?: string } }>(
    '/api/verfahren/:type/sensors',
    async (req, reply) => {
      const { type } = req.params;
      if (!VERFAHREN[type]) {
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
