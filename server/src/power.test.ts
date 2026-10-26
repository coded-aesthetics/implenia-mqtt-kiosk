import { describe, it, expect } from 'vitest';
import { LocalPower } from './power.js';
import type { Exec, ExecResult } from './network.js';

/**
 * Switching the machine off.
 *
 * Nothing here runs a real `systemctl` — the exec is injected, the same way
 * network.test.ts drives nmcli. What is worth pinning is that the two failures
 * stay apart: a machine that has no systemd is a state the tile reports, and a
 * machine that is not allowed to power itself off gets the message that names
 * the missing permission.
 */

function scripted(results: Record<string, Partial<ExecResult>>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const result = results[args[0] ?? ''] ?? { code: 0 };
    return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { exec, calls };
}

describe('capability', () => {
  it('is unavailable with a German reason on a machine without systemd', async () => {
    const { exec } = scripted({ '--version': { code: 127, stderr: 'command not found' } });

    const capability = await new LocalPower(exec).capability();

    expect(capability.available).toBe(false);
    if (capability.available) throw new Error('unreachable');
    expect(capability.reason).toContain('nicht selbst ausschalten');
    // The way out is the only one such a machine has.
    expect(capability.reason).toContain('Einschaltknopf');
  });

  it('is available where systemctl answers', async () => {
    const { exec, calls } = scripted({ '--version': { code: 0, stdout: 'systemd 257' } });

    expect(await new LocalPower(exec).capability()).toEqual({ available: true });
    expect(calls).toEqual([['systemctl', '--version']]);
  });
});

describe('poweroff', () => {
  it('asks systemd and reports success', async () => {
    const { exec, calls } = scripted({ poweroff: { code: 0 } });

    expect(await new LocalPower(exec).poweroff()).toEqual({ ok: true });
    expect(calls).toEqual([['systemctl', 'poweroff']]);
  });

  it('names the missing permission when polkit refuses', async () => {
    // What a kiosk provisioned before this button existed answers.
    const { exec } = scripted({
      poweroff: { code: 1, stderr: 'Call to PowerOff failed: Interactive authentication required.' },
    });

    const result = await new LocalPower(exec).poweroff();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('Berechtigung');
    expect(result.error).toContain('Service');
    // systemd's own wording is logged, not shown: nothing a worker can act on.
    expect(result.error).not.toContain('PowerOff');
  });

  it('still points at the knob on any other failure', async () => {
    const { exec } = scripted({ poweroff: { code: 1, stderr: 'Failed to connect to bus' } });

    const result = await new LocalPower(exec).poweroff();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('fehlgeschlagen');
    expect(result.error).toContain('Einschaltknopf');
    expect(result.error).not.toContain('Berechtigung');
  });
});
