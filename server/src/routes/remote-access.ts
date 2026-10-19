import type { FastifyInstance } from 'fastify';
import { remoteAccess } from '../remote-access.js';

export function registerRemoteAccessRoutes(app: FastifyInstance): void {
  /**
   * The AnyDesk id of this machine, for the Fernwartung card on the system
   * settings screen. Never fails: an unprovisioned kiosk answers
   * `{ id: null, status: null }` and the screen says it is not set up.
   */
  app.get('/api/remote-access', async () => remoteAccess());
}
