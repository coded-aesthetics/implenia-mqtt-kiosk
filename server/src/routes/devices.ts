import type { FastifyInstance } from 'fastify';
import {
  getDevices,
  getDeviceById,
  createDevice,
  updateDevice,
  deleteDevice,
  getDeviceMappings,
  setDeviceMappings,
} from '../db.js';
import { config } from '../config.js';
import { deviceManager } from '../device-manager.js';
import { createLogger } from '../logger.js';

const log = createLogger('devices');

const isDev = config.NODE_ENV === 'development';

export function registerDeviceRoutes(app: FastifyInstance): void {
  app.get('/api/config/devices', async (_request, reply) => {
    let devices = getDevices();
    if (!isDev) {
      devices = devices.filter((d) => d.type !== 'simulator');
    }
    const status = deviceManager.getStatus();
    const statusMap = new Map(status.map((s) => [s.deviceId, s.connected]));

    const result = devices.map((d) => ({
      ...d,
      connected: statusMap.get(d.id) ?? false,
    }));
    return reply.send(result);
  });

  app.post('/api/config/devices', async (request, reply) => {
    const { label, port, baud, type } = request.body as {
      label?: string;
      port?: string;
      baud?: number;
      type?: string;
    };

    if (!label || label.trim().length === 0) {
      return reply.status(400).send({ error: 'Bezeichnung ist erforderlich' });
    }

    const deviceType = type ?? 'elvis';
    if (deviceType !== 'elvis' && deviceType !== 'simulator') {
      return reply.status(400).send({ error: 'Ungültiger Gerätetyp' });
    }

    if (deviceType === 'simulator' && !isDev) {
      return reply.status(400).send({ error: 'Simulator nur im Entwicklungsmodus verfügbar' });
    }

    if (deviceType === 'elvis' && (!port || port.trim().length === 0)) {
      return reply.status(400).send({ error: 'Port ist für Elvis-Geräte erforderlich' });
    }

    const id = createDevice(
      label.trim(),
      deviceType === 'simulator' ? null : (port?.trim() ?? null),
      baud ?? 9600,
      deviceType,
    );

    deviceManager.reload();
    log.info('Created device %d: %s (%s)', id, label, deviceType);
    return reply.send({ id });
  });

  app.put('/api/config/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deviceId = parseInt(id, 10);
    if (isNaN(deviceId)) {
      return reply.status(400).send({ error: 'Ungültige Geräte-ID' });
    }

    const existing = getDeviceById(deviceId);
    if (!existing) {
      return reply.status(404).send({ error: 'Gerät nicht gefunden' });
    }

    const { label, port, baud } = request.body as {
      label?: string;
      port?: string;
      baud?: number;
    };

    updateDevice(
      deviceId,
      label?.trim() ?? existing.label,
      existing.type === 'simulator' ? null : (port?.trim() ?? existing.port),
      baud ?? existing.baud,
    );

    deviceManager.reload();
    log.info('Updated device %d', deviceId);
    return reply.send({ ok: true });
  });

  app.delete('/api/config/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deviceId = parseInt(id, 10);
    if (isNaN(deviceId)) {
      return reply.status(400).send({ error: 'Ungültige Geräte-ID' });
    }

    const existing = getDeviceById(deviceId);
    if (!existing) {
      return reply.status(404).send({ error: 'Gerät nicht gefunden' });
    }

    deleteDevice(deviceId);
    deviceManager.reload();
    log.info('Deleted device %d (%s)', deviceId, existing.label);
    return reply.send({ ok: true });
  });

  app.get('/api/config/devices/:id/mappings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deviceId = parseInt(id, 10);
    if (isNaN(deviceId)) {
      return reply.status(400).send({ error: 'Ungültige Geräte-ID' });
    }

    const existing = getDeviceById(deviceId);
    if (!existing) {
      return reply.status(404).send({ error: 'Gerät nicht gefunden' });
    }

    return reply.send(getDeviceMappings(deviceId));
  });

  app.put('/api/config/devices/:id/mappings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deviceId = parseInt(id, 10);
    if (isNaN(deviceId)) {
      return reply.status(400).send({ error: 'Ungültige Geräte-ID' });
    }

    const existing = getDeviceById(deviceId);
    if (!existing) {
      return reply.status(404).send({ error: 'Gerät nicht gefunden' });
    }

    const { mappings } = request.body as {
      mappings?: { valueIndex: number; sensorName: string }[];
    };

    if (!Array.isArray(mappings)) {
      return reply.status(400).send({ error: 'mappings muss ein Array sein' });
    }

    for (const m of mappings) {
      if (typeof m.valueIndex !== 'number' || m.valueIndex < 0 || m.valueIndex >= 15) {
        return reply.status(400).send({ error: `Ungültiger Kanalindex: ${m.valueIndex}` });
      }
      if (!m.sensorName || typeof m.sensorName !== 'string') {
        return reply.status(400).send({ error: 'Sensorname ist erforderlich' });
      }
    }

    setDeviceMappings(deviceId, mappings);
    log.info('Updated mappings for device %d: %d sensors', deviceId, mappings.length);
    return reply.send({ ok: true });
  });
}
