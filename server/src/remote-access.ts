import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('remote-access');

/**
 * AnyDesk, for service personnel who cannot reach the machine.
 *
 * The id is read from a file rather than from `anydesk --get-id`, because that
 * command answers an empty line and exit status 1 for anyone but root, and this
 * server runs as the kiosk user. `scripts/provision-kiosk.sh` writes the file
 * once, with the id AnyDesk reported after its service first registered.
 *
 * Everything here degrades to `null`. A kiosk with no AnyDesk installed, no
 * network, or a provisioning run that could not reach AnyDesk's servers is a
 * normal state, and the screen says so instead of showing an error.
 */

export type RemoteAccessStatus = 'online' | 'offline' | null;

export interface RemoteAccess {
  id: string | null;
  status: RemoteAccessStatus;
}

/** 9 or 10 digits today; bounded loosely rather than pinned to a format AnyDesk may change. */
const ID_PATTERN = /^[0-9]{6,12}$/;

export function defaultIdFile(): string {
  return path.resolve(process.cwd(), 'anydesk-id.txt');
}

/**
 * A failed `--get-id` leaves an empty file or an error message behind, and
 * showing either as an id would have a service tech dialling nonsense — so
 * anything that is not a plain run of digits is no id at all.
 */
export function parseIdFile(content: string): string | null {
  const first = content.trim().split('\n')[0] ?? '';
  const digits = first.replace(/\s+/g, '');
  return ID_PATTERN.test(digits) ? digits : null;
}

/** `offline` is checked first: a substring test the other way round is a trap waiting for a rename. */
export function parseStatus(stdout: string): RemoteAccessStatus {
  const text = stdout.trim().toLowerCase();
  if (text.includes('offline')) return 'offline';
  if (text.includes('online')) return 'online';
  return null;
}

let cachedId: string | null = null;

export function readAnydeskId(idFile: string = defaultIdFile()): string | null {
  // Only a hit is cached. A kiosk whose AnyDesk was provisioned after this
  // process started would otherwise never show its id until the next restart,
  // and the file is one line read by a screen nobody holds open.
  if (cachedId) return cachedId;
  try {
    cachedId = parseIdFile(fs.readFileSync(idFile, 'utf-8'));
  } catch {
    cachedId = null;
  }
  return cachedId;
}

const STATUS_TTL_MS = 15_000;
let statusCache: { value: RemoteAccessStatus; at: number } | null = null;

/**
 * Best effort, and bounded twice over: a 2 s timeout on the process and a 15 s
 * cache on the answer, so a config screen left open cannot spawn a process per
 * render or hang on an AnyDesk that is wedged.
 */
export async function readAnydeskStatus(): Promise<RemoteAccessStatus> {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const value = await new Promise<RemoteAccessStatus>((resolve) => {
    execFile('anydesk', ['--get-status'], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        log.debug('anydesk --get-status failed: %s', err.message);
        resolve(null);
        return;
      }
      resolve(parseStatus(stdout));
    });
  });
  statusCache = { value, at: Date.now() };
  return value;
}

export async function remoteAccess(): Promise<RemoteAccess> {
  const id = readAnydeskId();
  // No id means nothing was provisioned, so there is nothing a status could
  // describe — and no reason to spawn a process to find that out.
  const status = id ? await readAnydeskStatus() : null;
  return { id, status };
}

/** Tests only: the caches outlive a single test otherwise. */
export function resetRemoteAccessCache(): void {
  cachedId = null;
  statusCache = null;
}
