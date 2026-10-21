import { describe, it, expect } from 'vitest';
import {
  LocalNetwork, classifyActivationFailure, keyManagementFor, parseConnections,
  parseDefaultRouteDevice, parseDevices, parseScan, splitTerse, wifiInterface,
  type ExecResult,
} from './network.js';

/**
 * The Wi-Fi switch, and the rule that it may never cost the machine its network.
 *
 * Most of what matters here is the *order* of the nmcli calls, not their
 * output, so the suite drives a scripted executor and asserts on the sequence.
 * The one invariant worth stating in full: `connection.autoconnect yes` may
 * only ever be issued after the MQTT box has answered on the new link. Until
 * then a reboot has to come back on the old network by itself, and that is true
 * precisely because no profile has been told to prefer the new one.
 */

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const PENDING = 'implenia-pending';

const DEVICE_STATUS = [
  'wlan0:wifi:connected:Buero-WLAN',
  'eth0:ethernet:unavailable:',
  'lo:loopback:unmanaged:',
].join('\n');

/** NAME,UUID,TYPE,AUTOCONNECT-PRIORITY,ACTIVE,DEVICE */
const CONNECTION_SHOW = [
  'Buero-WLAN:aaaa-1111:802-11-wireless:3:yes:wlan0',
  'Wired connection 1:bbbb-2222:802-3-ethernet:0:no:',
].join('\n');

const WIFI_LIST = [
  'Buero-WLAN:71:WPA2:*',
  'Implenia-Box-G08:84:WPA2:',
].join('\n');

interface Scripted {
  deviceStatus?: ExecResult;
  wifiList?: ExecResult;
  /** `device wifi rescan` — the call that can report a polkit refusal. */
  rescan?: ExecResult;
  connectionShow?: ExecResult;
  add?: ExecResult;
  /** `connection up implenia-pending` */
  up?: ExecResult;
  /** `connection up <uuid of the previous profile>` */
  restore?: ExecResult;
  route?: ExecResult;
  /** `connection modify` — the commit. */
  modify?: ExecResult;
  /** Does the MQTT box answer on the new link? */
  broker?: boolean;
  /** Does the internet answer? */
  internet?: boolean;
}

function harness(script: Scripted = {}) {
  const calls: string[][] = [];

  const net = new LocalNetwork({
    hostname: () => 'kiosk-g08',
    endpoint: () => ({ host: '192.168.2.1', port: 1883 }),
    probe: async (host) => {
      calls.push(['probe', host]);
      return host === '192.168.2.1' ? script.broker ?? true : script.internet ?? true;
    },
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ip') {
        return script.route ?? { code: 0, stdout: 'default via 192.168.2.1 dev wlan0\n', stderr: '' };
      }
      const joined = args.join(' ');
      if (joined.includes('device status')) {
        return script.deviceStatus ?? { code: 0, stdout: DEVICE_STATUS, stderr: '' };
      }
      if (joined.includes('device wifi rescan')) return script.rescan ?? OK;
      if (joined.includes('device wifi list')) {
        return script.wifiList ?? { code: 0, stdout: WIFI_LIST, stderr: '' };
      }
      if (joined.includes('connection show')) {
        return script.connectionShow ?? { code: 0, stdout: CONNECTION_SHOW, stderr: '' };
      }
      if (args[0] === 'connection' && args[1] === 'add') return script.add ?? OK;
      if (args[0] === 'connection' && args[1] === 'modify') return script.modify ?? OK;
      if (args.includes('up')) {
        return args.includes(PENDING) ? script.up ?? OK : script.restore ?? OK;
      }
      return OK;
    },
  });

  const nmcli = (): string[] => calls.filter((c) => c[0] === 'nmcli').map((c) => c.slice(1).join(' '));
  return { net, calls, nmcli };
}

// ── parsing ─────────────────────────────────────────────────────────────────

describe('nmcli terse output', () => {
  it('keeps a colon that belongs to the value', () => {
    // An SSID is free text, and somebody will name an access point like this.
    // A naive split(':') makes it two fields and the network becomes unjoinable.
    expect(splitTerse('Implenia\\: Box:84:WPA2:')).toEqual(['Implenia: Box', '84', 'WPA2', '']);
  });

  it('keeps an escaped backslash', () => {
    expect(splitTerse('a\\\\b:1')).toEqual(['a\\b', '1']);
  });
});

describe('parseScan', () => {
  it('reads signal, security and the active network', () => {
    expect(parseScan(WIFI_LIST)).toEqual([
      { ssid: 'Implenia-Box-G08', signal: 84, secured: true, security: 'WPA2', active: false },
      { ssid: 'Buero-WLAN', signal: 71, secured: true, security: 'WPA2', active: true },
    ]);
  });

  it('drops hidden networks, which have no SSID to tap', () => {
    expect(parseScan(':62:WPA2:\nImplenia-Box-G08:84:WPA2:')).toHaveLength(1);
  });

  it('treats an empty or dashed security field as an open network', () => {
    expect(parseScan('Gast:50::')[0].secured).toBe(false);
    expect(parseScan('Gast:50:--:')[0].secured).toBe(false);
  });

  it('collapses a dual-radio AP to one row and keeps it marked active', () => {
    // The weaker radio is the one in use; the row must still say so, or the
    // screen shows the network the kiosk is on as one it is not.
    const rows = parseScan('Implenia-Box-G08:84:WPA2:\nImplenia-Box-G08:40:WPA2:*');
    expect(rows).toEqual([
      { ssid: 'Implenia-Box-G08', signal: 84, secured: true, security: 'WPA2', active: true },
    ]);
  });
});

describe('an SSID nmcli does not escape', () => {
  // The question a field report arrives as: "is our list filtering the box
  // out?". `#` is not a terse-mode metacharacter, so it must survive — and the
  // box on site is called `Implenia-MQTT#00`.
  it('keeps a hash in the SSID', () => {
    const networks = parseScan('Implenia-MQTT#00:100:WPA2:\nBuero-WLAN:71:WPA2:*');
    expect(networks.map((n) => n.ssid)).toEqual(['Implenia-MQTT#00', 'Buero-WLAN']);
    expect(networks[0]).toMatchObject({ signal: 100, secured: true, active: false });
  });
});

describe('parseDefaultRouteDevice', () => {
  it('names the interface traffic actually takes', () => {
    expect(parseDefaultRouteDevice('default via 192.168.2.1 dev wlan0 proto dhcp metric 600\n'))
      .toBe('wlan0');
  });

  it('prefers the first route, which the kernel lists by metric', () => {
    const out = 'default via 10.0.0.1 dev eth0 metric 100\ndefault via 192.168.2.1 dev wlan0 metric 600\n';
    expect(parseDefaultRouteDevice(out)).toBe('eth0');
  });

  it('answers null when there is no route at all', () => {
    expect(parseDefaultRouteDevice('')).toBeNull();
  });
});

describe('parseDevices / wifiInterface', () => {
  it('finds the wireless interface', () => {
    expect(wifiInterface(parseDevices(DEVICE_STATUS))).toBe('wlan0');
  });

  it('answers null on a machine with none', () => {
    expect(wifiInterface(parseDevices('eth0:ethernet:connected:Wired'))).toBeNull();
  });
});

describe('parseConnections', () => {
  it('reads the active profile and its autoconnect priority', () => {
    expect(parseConnections(CONNECTION_SHOW)[0]).toEqual({
      name: 'Buero-WLAN', uuid: 'aaaa-1111', type: '802-11-wireless',
      priority: 3, active: true, device: 'wlan0',
    });
  });
});

describe('classifyActivationFailure', () => {
  it('reads a missing secret as a wrong password', () => {
    // A WPA access point never says "wrong key", it just refuses the
    // handshake — so this is what a typo looks like from here.
    expect(classifyActivationFailure(
      'Error: Connection activation failed: (7) Secrets were required, but not provided.',
    )).toBe('bad-password');
  });

  it('recognises a failed DHCP lease', () => {
    expect(classifyActivationFailure(
      'Error: Connection activation failed: IP configuration could not be reserved',
    )).toBe('no-ip');
  });

  it('recognises a polkit refusal', () => {
    expect(classifyActivationFailure('Error: not authorized to control networking.'))
      .toBe('unauthorized');
  });

  it('falls through rather than guessing', () => {
    expect(classifyActivationFailure('Error: something new in NetworkManager 1.52'))
      .toBe('activation');
  });
});

describe('keyManagementFor', () => {
  it('asks for SAE on a WPA3 network', () => {
    // A wpa-psk profile against a WPA3-only AP never associates, and the
    // failure is indistinguishable from a wrong password — so the technician
    // retypes a correct one until they give up.
    expect(keyManagementFor('WPA3')).toBe('sae');
    expect(keyManagementFor('WPA2 WPA3')).toBe('sae');
  });

  it('asks for a PSK on WPA1/WPA2', () => {
    expect(keyManagementFor('WPA2')).toBe('wpa-psk');
    expect(keyManagementFor('WPA1 WPA2')).toBe('wpa-psk');
  });

  it('refuses an enterprise network rather than offering it a password', () => {
    expect(keyManagementFor('WPA2 802.1X')).toBe('unsupported');
  });

  it('answers null for an open network', () => {
    expect(keyManagementFor('')).toBeNull();
    expect(keyManagementFor('--')).toBeNull();
  });
});

// ── capability ──────────────────────────────────────────────────────────────

describe('a machine that cannot do this', () => {
  it('reports a missing NetworkManager as a state, not an error', async () => {
    const { net } = harness({ deviceStatus: { code: 127, stdout: '', stderr: 'nmcli: not found' } });
    const status = await net.status();
    expect(status.capability.available).toBe(false);
    expect(status.capability).toMatchObject({ reason: expect.stringContaining('NetworkManager') });
    expect(status.hostname).toBe('kiosk-g08');
  });

  it('reports a machine with no wireless interface', async () => {
    const { net } = harness({
      deviceStatus: { code: 0, stdout: 'eth0:ethernet:connected:Wired', stderr: '' },
    });
    const status = await net.status();
    expect(status.capability).toMatchObject({
      available: false,
      reason: expect.stringContaining('WLAN-Schnittstelle'),
    });
  });

  it('reports a wireless interface NetworkManager does not manage', async () => {
    // A device that exists is not a device that can be used: both this and a
    // switched-off radio leave the scan empty, and the screen then blamed the
    // access point for a problem on the kiosk.
    const { net } = harness({
      deviceStatus: { code: 0, stdout: 'wlan0:wifi:unmanaged:', stderr: '' },
    });
    const status = await net.status();
    expect(status.capability).toMatchObject({
      available: false,
      reason: expect.stringContaining('nicht von NetworkManager verwaltet'),
    });
  });

  it('reports a radio that is switched off', async () => {
    const { net } = harness({
      deviceStatus: { code: 0, stdout: 'wlan0:wifi:unavailable:', stderr: '' },
    });
    const status = await net.status();
    expect(status.capability).toMatchObject({
      available: false,
      reason: expect.stringContaining('abgeschaltet'),
    });
  });

  it('refuses a connect attempt with the same reason', async () => {
    const { net, nmcli } = harness({ deviceStatus: { code: 127, stdout: '', stderr: '' } });
    const result = await net.connect('Implenia-Box-G08', 'secret');
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    // Nothing was created, so there is nothing to roll back.
    expect(nmcli().some((c) => c.includes('connection add'))).toBe(false);
  });

  it('scans to an empty list rather than throwing', async () => {
    const { net } = harness({ wifiList: { code: 1, stdout: '', stderr: 'boom' } });
    expect(await net.scan()).toEqual([]);
  });

  it('does not ask a machine without a wireless interface to scan', async () => {
    const { net, nmcli } = harness({
      deviceStatus: { code: 0, stdout: 'eth0:ethernet:connected:lan', stderr: '' },
    });
    expect(await net.scan()).toEqual([]);
    expect(nmcli().some((c) => c.includes('device wifi'))).toBe(false);
  });
});

describe('a scan the kiosk may not be allowed to run', () => {
  // `nmcli device wifi list --rescan yes` swallows a refused scan: exit 0,
  // empty stderr, NetworkManager's cache printed as if it were fresh. So the
  // rescan is requested in its own call, whose exit code is the only place that
  // refusal is visible — on a kiosk whose polkit rule has no `wifi.scan`, the
  // WLAN screen otherwise lists the office while the box sits next to it.
  it('asks for the rescan in a call that can report a refusal', async () => {
    const { net, nmcli } = harness();
    await net.scan();
    const calls = nmcli();
    const rescan = calls.findIndex((c) => c.includes('device wifi rescan'));
    const list = calls.findIndex((c) => c.includes('device wifi list'));
    expect(rescan).toBeGreaterThanOrEqual(0);
    expect(rescan).toBeLessThan(list);
  });

  it('still answers the cached list when the rescan is refused', async () => {
    // A stale list beats no list, and a second tap on the scan button fails
    // the same way ("scanning not allowed while already scanning").
    const { net } = harness({
      rescan: { code: 4, stdout: '', stderr: 'Error: ... wifi.scan request failed: not authorized.' },
    });
    expect((await net.scan()).map((n) => n.ssid)).toEqual(['Implenia-Box-G08', 'Buero-WLAN']);
  });
});

// ── status ──────────────────────────────────────────────────────────────────

describe('status', () => {
  it('names the machine and the network it is on', async () => {
    const { net } = harness();
    const status = await net.status();
    expect(status).toMatchObject({
      hostname: 'kiosk-g08', ssid: 'Buero-WLAN', signal: 71, defaultRouteDevice: 'wlan0',
      routedElsewhere: false,
    });
  });

  it('falls back to the active profile when the scan says nothing', async () => {
    // The scan list is not authoritative about what the machine is on: it can
    // be empty, stale or time out on a J1900, and a failed one reported a
    // perfectly connected kiosk as "Nicht verbunden" — amber tile, and a wizard
    // button offering to carry on without WLAN.
    const { net } = harness({ wifiList: { code: 1, stdout: '', stderr: 'timeout' } });
    const status = await net.status();
    expect(status.ssid).toBe('Buero-WLAN');
    expect(status.signal).toBeNull();
  });

  it('does not make the radio scan just to read the status', async () => {
    // The default is --rescan auto, which scans whenever the cache is older
    // than 30 s — and the settings hub waits on this call before painting any
    // of its five tiles.
    const { net, nmcli } = harness();
    await net.status();
    const list = nmcli().find((c) => c.includes('device wifi list'))!;
    expect(list).toContain('--rescan no');
  });

  it('flags a default route that is not on the Wi-Fi', async () => {
    // The office trap: with the cable plugged in, wired wins on metric and the
    // MQTT box is unreachable while the screen says "verbunden".
    const { net } = harness({
      route: { code: 0, stdout: 'default via 10.0.0.1 dev eth0 metric 100\n', stderr: '' },
    });
    const status = await net.status();
    expect(status.routedElsewhere).toBe(true);
    expect(status.defaultRouteDevice).toBe('eth0');
  });
});

// ── the switch ──────────────────────────────────────────────────────────────

describe('switching to a new network', () => {
  it('stages the profile, tests it, and only then commits', async () => {
    const { net, nmcli } = harness();
    const result = await net.connect('Implenia-Box-G08', 'geheim123');

    expect(result).toEqual({ ok: true, ssid: 'Implenia-Box-G08', internet: true });

    const calls = nmcli();
    const deleteLeftover = calls.findIndex((c) => c === `connection delete ${PENDING}`);
    const add = calls.findIndex((c) => c.startsWith('connection add'));
    const up = calls.findIndex((c) => c.includes(`connection up ${PENDING}`));
    const commit = calls.findIndex((c) => c.includes('connection.autoconnect yes'));

    // A leftover from an attempt that died mid-way is deleted rather than
    // reused: it would carry that attempt's password into this one.
    expect(deleteLeftover).toBeGreaterThanOrEqual(0);
    expect(deleteLeftover).toBeLessThan(add);
    expect(add).toBeLessThan(up);
    expect(up).toBeLessThan(commit);

    // The invariant.
    expect(calls[add]).toContain('autoconnect no');
    expect(calls[add]).toContain('wifi-sec.psk geheim123');
  });

  it('does not set autoconnect before the box has answered', async () => {
    const { net, calls } = harness();
    await net.connect('Implenia-Box-G08', 'geheim123');

    const flat = calls.map((c) => c.join(' '));
    const probe = flat.findIndex((c) => c === 'probe 192.168.2.1');
    const commit = flat.findIndex((c) => c.includes('connection.autoconnect yes'));
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(probe).toBeLessThan(commit);
  });

  it('never modifies an existing profile', async () => {
    // The profile currently up may be the only known-good network this machine
    // has, and a rewritten PSK cannot be read back and restored.
    const { net, nmcli } = harness();
    await net.connect('Implenia-Box-G08', 'geheim123');
    const modified = nmcli().filter((c) => c.startsWith('connection modify'));
    expect(modified.every((c) => c.includes(PENDING))).toBe(true);
  });

  it('gives the new network a priority above every existing profile', async () => {
    // So a kiosk that knows the office Wi-Fi prefers the box once on site.
    const { net, nmcli } = harness();
    await net.connect('Implenia-Box-G08', 'geheim123');
    expect(nmcli().some((c) => c.includes('connection.autoconnect-priority 4'))).toBe(true);
  });

  it('drops a stale profile for the same SSID', async () => {
    const { net, nmcli } = harness({
      connectionShow: {
        code: 0,
        stdout: 'Implenia-Box-G08:cccc-3333:802-11-wireless:1:no:\n' + CONNECTION_SHOW,
        stderr: '',
      },
    });
    await net.connect('Implenia-Box-G08', 'geheim123');
    expect(nmcli()).toContain('connection delete cccc-3333');
  });

  it('adds no security settings for an open network', async () => {
    const { net, nmcli } = harness();
    await net.connect('Gast', '');
    const add = nmcli().find((c) => c.startsWith('connection add'))!;
    expect(add).not.toContain('wifi-sec');
  });

  it('commits even when there is no internet', async () => {
    // The box carries the uplink, so its mobile link can be down while it
    // serves MQTT perfectly. Refusing a correct network over that would be the
    // tail wagging the dog — the kiosk buffers offline by design.
    const { net, nmcli } = harness({ broker: true, internet: false });
    const result = await net.connect('Implenia-Box-G08', 'geheim123');
    expect(result).toEqual({ ok: true, ssid: 'Implenia-Box-G08', internet: false });
    expect(nmcli().some((c) => c.includes('connection.autoconnect yes'))).toBe(true);
  });
});

describe('a switch that fails', () => {
  it('rolls back a wrong password and says so in German', async () => {
    const { net, nmcli } = harness({
      up: { code: 4, stdout: '', stderr: 'Error: Connection activation failed: (7) Secrets were required, but not provided.' },
    });
    const result = await net.connect('Implenia-Box-G08', 'falsch');

    expect(result).toMatchObject({ ok: false, code: 'bad-password' });
    const error = (result as { error: string }).error;
    expect(error).toContain('Passwort');
    expect(error).toContain('Implenia-Box-G08');
    expect(error).toContain('bleibt im bisherigen WLAN');

    const calls = nmcli();
    expect(calls).toContain(`connection delete ${PENDING}`);
    // The previous profile is brought back up by uuid.
    expect(calls.some((c) => c.includes('connection up aaaa-1111'))).toBe(true);
    // And nothing was ever committed.
    expect(calls.some((c) => c.includes('connection.autoconnect yes'))).toBe(false);
  });

  it('rolls back a network that gave no IP address', async () => {
    const { net } = harness({
      up: { code: 4, stdout: '', stderr: 'Error: Connection activation failed: IP configuration could not be reserved' },
    });
    const result = await net.connect('Implenia-Box-G08', 'geheim123');
    expect(result).toMatchObject({ ok: false, code: 'no-ip' });
    expect((result as { error: string }).error).toContain('IP-Adresse');
  });

  it('rolls back a network the MQTT broker does not answer on', async () => {
    // Associated, DHCP fine, wrong network. This is the failure the scan list
    // cannot catch, and the only reason the acceptance test exists.
    const { net, nmcli } = harness({ broker: false });
    const result = await net.connect('Nachbar-WLAN', 'geheim123');

    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
    const error = (result as { error: string }).error;
    // Named for what was probed, with the port: a kiosk pointed at a replay
    // server was being told "die Implenia-Box" does not answer, about a device
    // it has never met — and 1884 against an expected 1883 is invisible
    // without the port.
    expect(error).toContain('MQTT-Broker');
    expect(error).toContain('192.168.2.1:1883');
    expect(error).not.toContain('Implenia-Box');
    expect(nmcli().some((c) => c.includes('connection.autoconnect yes'))).toBe(false);
    expect(nmcli().some((c) => c.includes('connection up aaaa-1111'))).toBe(true);
  });

  it('says the switch was taken back, so the two halves do not contradict', async () => {
    // "Verbunden mit „X" … das Gerät ist in keinem WLAN" is two true sentences
    // in different tenses, and without the undo between them it reads as a
    // contradiction.
    const { net } = harness({ broker: false });
    const result = await net.connect('Nachbar-WLAN', 'geheim123');
    const error = (result as { error: string }).error;
    expect(error).toContain('Verbunden mit „Nachbar-WLAN"');
    expect(error).toContain('zurückgenommen');
    expect(error.indexOf('zurückgenommen')).toBeGreaterThan(error.indexOf('Verbunden mit'));
  });

  it('does not claim the old network is back when restoring it also failed', async () => {
    const { net } = harness({
      up: { code: 4, stdout: '', stderr: '(7) Secrets were required' },
      restore: { code: 4, stdout: '', stderr: 'Error: Connection activation failed' },
    });
    const result = await net.connect('Implenia-Box-G08', 'falsch');
    const error = (result as { error: string }).error;
    expect(error).toContain('ist in keinem WLAN');
    expect(error).not.toContain('bisherigen WLAN');
  });

  it('keeps every message inside the six lines the screen reserves', async () => {
    // The screen's message box has a fixed height so an arriving message cannot
    // move anything the technician is reaching for. Six lines is about 260
    // characters at 1024x768, measured on the rendered page; past that a
    // message is not merely wordy, it is partly unread. The SSID is the longest
    // one the standard allows, because nothing stops a site from using it.
    const failures: Scripted[] = [
      { up: { code: 4, stdout: '', stderr: '(7) Secrets were required' } },
      { up: { code: 4, stdout: '', stderr: 'IP configuration could not be reserved' } },
      { broker: false },
      { add: { code: 4, stdout: '', stderr: 'not authorized' } },
      // An unclassified failure carries NetworkManager's own wording, which is
      // the one piece of text here the module does not write itself.
      { up: { code: 4, stdout: '', stderr: 'Error: '.padEnd(400, 'x') } },
    ];
    const longestLegalSsid = 'X'.repeat(32);
    for (const script of failures) {
      const { net } = harness(script);
      const result = await net.connect(longestLegalSsid, 'geheim123');
      const error = (result as { error: string }).error;
      expect(error.length, error).toBeLessThanOrEqual(260);
    }
  });

  it('says nothing changed when the profile could not even be created', async () => {
    // No `connection up` ran and nothing was brought down, so the machine is
    // still on what it started with. Claiming a rollback here told a technician
    // their kiosk had no network while it sat on the office WLAN — the same
    // self-contradiction the suffix exists to prevent, from the other side.
    // The polkit case returns before the suffix, so this path needs its own
    // test: a PSK nmcli rejects locally is the realistic way in.
    const { net, nmcli } = harness({
      add: {
        code: 2, stdout: '',
        stderr: "Error: failed to modify 802-11-wireless-security.psk: '802-11-wireless-security.psk: property is invalid'.",
      },
    });
    const result = await net.connect('Implenia-Box-G08', 'kurz');

    const error = (result as { error: string }).error;
    expect(error).toContain('Am bisherigen WLAN hat sich nichts geändert');
    expect(error).not.toContain('zurückgenommen');
    expect(error).not.toContain('in keinem WLAN');
    // And nothing was torn down to make that true.
    expect(nmcli().some((c) => c.startsWith('connection down'))).toBe(false);
  });

  it('rolls back a commit that fails instead of reporting success', async () => {
    // The half-committed state is the one this whole design exists to avoid,
    // reached from the inside: the live connection would stay named
    // implenia-pending with autoconnect off while the real profile for the SSID
    // had just been deleted, so the next reboot comes back on nothing.
    const { net, nmcli } = harness({
      connectionShow: {
        code: 0,
        stdout: 'Implenia-Box-G08:cccc-3333:802-11-wireless:1:no:\n' + CONNECTION_SHOW,
        stderr: '',
      },
      modify: { code: 1, stdout: '', stderr: 'Error: unknown connection' },
    });
    const result = await net.connect('Implenia-Box-G08', 'geheim123');

    expect(result).toMatchObject({ ok: false });
    const calls = nmcli();
    // The stale profile for this SSID survives: deleting it is what would have
    // left the machine with nothing to come back to.
    expect(calls).not.toContain('connection delete cccc-3333');
    // And the pending profile is gone again.
    expect(calls).toContain(`connection delete ${PENDING}`);
  });

  it('refuses an enterprise network with an actionable reason', async () => {
    const { net, nmcli } = harness({
      wifiList: { code: 0, stdout: 'Firmen-WLAN:70:WPA2 802.1X:', stderr: '' },
    });
    const result = await net.connect('Firmen-WLAN', 'geheim123');

    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    expect((result as { error: string }).error).toContain('Benutzeranmeldung');
    // Refused before anything was created.
    expect(nmcli().some((c) => c.startsWith('connection add'))).toBe(false);
  });

  it('builds a WPA3 profile for a WPA3 network', async () => {
    const { net, nmcli } = harness({
      wifiList: { code: 0, stdout: 'Neu-WLAN:70:WPA3:', stderr: '' },
    });
    await net.connect('Neu-WLAN', 'geheim123');
    expect(nmcli().find((c) => c.startsWith('connection add'))).toContain('wifi-sec.key-mgmt sae');
  });

  it('reports a polkit refusal as a provisioning problem', async () => {
    const { net, nmcli } = harness({
      add: { code: 4, stdout: '', stderr: 'Error: not authorized to control networking.' },
    });
    const result = await net.connect('Implenia-Box-G08', 'geheim123');
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' });
    expect((result as { error: string }).error).toContain('provision');
    expect(nmcli().some((c) => c.includes(`connection up ${PENDING}`))).toBe(false);
  });

  it('leaves no pending profile behind when there was no previous network', async () => {
    const { net, nmcli } = harness({
      connectionShow: { code: 0, stdout: 'Wired connection 1:bbbb-2222:802-3-ethernet:0:no:', stderr: '' },
      broker: false,
    });
    const result = await net.connect('Implenia-Box-G08', 'geheim123');
    expect((result as { error: string }).error).toContain('ist in keinem WLAN');
    expect(nmcli()).toContain(`connection delete ${PENDING}`);
  });
});
