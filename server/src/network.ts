import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { createLogger } from './logger.js';
import { DEFAULT_BROKER_URL, getMqttSettings } from './mqtt-config.js';

const log = createLogger('network');

/**
 * The Wi-Fi the kiosk is on.
 *
 * A kiosk is primed in the office and carried to a site, where it has to join
 * the Implenia MQTT box's access point. That AP is both halves of the kiosk's
 * network: the box serves MQTT at `mqtt://192.168.2.1:1883` *and* carries the
 * internet uplink, so joining it is what makes the data source and the upload
 * work at once. Nothing else on site offers a cable.
 *
 * Two things shape every line below.
 *
 * **It configures the machine this server runs on, and nothing else.** Wi-Fi is
 * a property of a machine, not of the kiosk application, and a browser cannot
 * reach the network stack of a box it merely talks HTTP to. Today the server
 * and the touchscreen are the same machine, so this is the machine the
 * technician is standing in front of — and `status()` returns the hostname so
 * the screen can say which one it means instead of saying "this kiosk". If the
 * server is ever split off onto its own box, each box needs its own agent;
 * there is no design that avoids that, so the point of `NetworkController` is
 * that the split costs an implementation rather than a redesign.
 *
 * **A failed switch may never cost the machine its network.** A kiosk that
 * cannot be reached is a truck roll — AnyDesk needs a network too — so the
 * switch is staged: the new profile is created with `autoconnect no`, activated,
 * tested against the MQTT box, and only *then* committed. Any crash, power cut
 * or PM2 restart in the middle comes back on the previous profile, because
 * nothing ever taught NetworkManager to prefer the new one. That ordering is
 * the whole safety property. See `connect()`.
 */

/** A profile is parked under this name until it has proven itself. */
const PENDING_CON_NAME = 'implenia-pending';

/** How long `nmcli` may take to bring a connection up, in seconds. */
const ACTIVATION_TIMEOUT_S = 30;

/** Bound on the short read-only calls, in ms. */
const QUERY_TIMEOUT_MS = 15_000;

/** Bound on the MQTT box reachability probe, in ms. */
const PROBE_TIMEOUT_MS = 5000;

/** How much of NetworkManager's own wording an unclassified failure may carry. */
const MAX_DETAIL = 60;

export interface WifiNetwork {
  ssid: string;
  /** 0–100 as NetworkManager reports it. */
  signal: number;
  secured: boolean;
  /** Currently in use by this machine. */
  active: boolean;
}

export interface ConnectionRow {
  name: string;
  uuid: string;
  type: string;
  priority: number;
  active: boolean;
  device: string;
}

export interface DeviceRow {
  device: string;
  type: string;
  state: string;
  connection: string;
}

export type Capability =
  | { available: true; iface: string }
  | { available: false; reason: string };

export interface NetworkStatus {
  /** The machine these settings belong to. The screen shows it. */
  hostname: string;
  capability: Capability;
  /** The Wi-Fi profile currently up, if any. */
  ssid: string | null;
  signal: number | null;
  /**
   * Which interface carries the default route.
   *
   * On site there is no cable and this is always the Wi-Fi. In the office with
   * Ethernet plugged in it is the wired interface — and because wired wins on
   * metric, the MQTT box is then unreachable even though the Wi-Fi is up and
   * the screen says "verbunden". Surfacing the interface is what makes that
   * state readable instead of baffling.
   */
  defaultRouteDevice: string | null;
  /** True when the default route is not on the Wi-Fi interface. */
  routedElsewhere: boolean;
}

export type ConnectFailure =
  | 'unauthorized'
  | 'bad-password'
  | 'no-ip'
  | 'unreachable'
  | 'activation'
  | 'unavailable';

export type ConnectResult =
  | { ok: true; ssid: string; internet: boolean }
  | { ok: false; code: ConnectFailure; error: string };

export interface NetworkController {
  status(): Promise<NetworkStatus>;
  scan(): Promise<WifiNetwork[]>;
  connect(ssid: string, psk: string): Promise<ConnectResult>;
}

// ── nmcli output parsing (pure) ──────────────────────────────────────────────

/**
 * Split one line of `nmcli -t` output.
 *
 * Terse mode separates fields with `:` and escapes a literal `:` or `\` inside
 * a value with a backslash — which matters here rather than in theory, because
 * an SSID is free text and `Implenia: Box` is a thing somebody will name an
 * access point. A naive `split(':')` turns that into two fields and the kiosk
 * offers a network nobody can join.
 */
export function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += line[++i];
    } else if (ch === ':') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function terseLines(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(splitTerse);
}

/**
 * `nmcli -t -f SSID,SIGNAL,SECURITY,IN-USE device wifi list`.
 *
 * Hidden networks report an empty SSID and are dropped: there is nothing for a
 * worker to tap, and this screen deliberately offers no free-text SSID field —
 * typing one with gloves on is how a lockout starts. One row per SSID, the
 * strongest surviving, because an AP with two radios shows up twice.
 */
export function parseScan(stdout: string): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const fields of terseLines(stdout)) {
    const [ssid, signalRaw, security, inUse] = fields;
    if (!ssid) continue;
    const signal = Number(signalRaw);
    const network: WifiNetwork = {
      ssid,
      signal: Number.isFinite(signal) ? signal : 0,
      // NetworkManager writes an empty field, or the literal `--`, for an open
      // network. Anything else names a key management scheme.
      secured: Boolean(security) && security !== '--',
      active: inUse?.trim() === '*',
    };
    const previous = best.get(ssid);
    if (!previous || network.signal > previous.signal) {
      best.set(ssid, previous?.active ? { ...network, active: true } : network);
    } else if (network.active) {
      best.set(ssid, { ...previous, active: true });
    }
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal);
}

/** `nmcli -t -f NAME,UUID,TYPE,AUTOCONNECT-PRIORITY,ACTIVE,DEVICE connection show`. */
export function parseConnections(stdout: string): ConnectionRow[] {
  return terseLines(stdout).map(([name, uuid, type, priority, active, device]) => ({
    name: name ?? '',
    uuid: uuid ?? '',
    type: type ?? '',
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    active: active === 'yes',
    device: device ?? '',
  }));
}

/** `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`. */
export function parseDevices(stdout: string): DeviceRow[] {
  return terseLines(stdout).map(([device, type, state, connection]) => ({
    device: device ?? '',
    type: type ?? '',
    state: state ?? '',
    connection: connection ?? '',
  }));
}

/** The first Wi-Fi interface, or `null` on a machine that has none. */
export function wifiInterface(devices: DeviceRow[]): string | null {
  return devices.find((d) => d.type === 'wifi')?.device ?? null;
}

/**
 * `ip route show default` → the interface carrying the default route.
 *
 * Several default routes can coexist; the kernel lists them in metric order, so
 * the first line is the one traffic actually takes.
 */
export function parseDefaultRouteDevice(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const match = /\bdev\s+(\S+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Turn a failed `nmcli connection up` into something a technician can act on.
 *
 * NetworkManager puts a reason code and an English sentence on stderr. Both are
 * matched, loosely and on purpose: the exact wording has changed between
 * NetworkManager releases, and the point of the classification is to pick the
 * right German sentence, not to be a parser anybody depends on. An unrecognised
 * failure falls through to `activation`, which says the switch was rolled back
 * and shows the technical detail — the rollback is what has to be right, not
 * the diagnosis.
 */
export function classifyActivationFailure(stderr: string): ConnectFailure {
  const text = stderr.toLowerCase();
  if (text.includes('not authorized') || text.includes('insufficient privilege')) {
    return 'unauthorized';
  }
  // Reason 7 is NO_SECRETS. A WPA access point does not tell a client its key
  // was wrong, it just refuses the handshake, so this is also what a typo looks
  // like — which is why the German message talks about the password rather than
  // about secrets.
  if (text.includes('(7)') || text.includes('secrets were required')) return 'bad-password';
  if (text.includes('ip configuration could not be reserved') || text.includes('dhcp')) {
    return 'no-ip';
  }
  return 'activation';
}

// ── process plumbing ────────────────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected in tests. Never throws: a non-zero exit is a result, not an error. */
export type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 127
            : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
    });
  });

/** Injected in tests. Resolves true when something is listening. */
export type Probe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const realProbe: Probe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });

/**
 * The MQTT box, as the acceptance test needs it.
 *
 * Falls back to `DEFAULT_BROKER_URL` rather than skipping the test, because the
 * case where nothing is configured is the *normal* one here: joining the box's
 * Wi-Fi is the first step of setting a kiosk up on site, and the broker address
 * is typed two steps later. The box's address is a constant of the product
 * anyway — the wizard offers the same default.
 */
export function brokerEndpoint(): { host: string; port: number } {
  const { brokerUrl } = getMqttSettings();
  try {
    const url = new URL(brokerUrl ?? DEFAULT_BROKER_URL);
    const port = Number(url.port);
    return {
      host: url.hostname,
      port: Number.isFinite(port) && port > 0 ? port : 1883,
    };
  } catch {
    return { host: '192.168.2.1', port: 1883 };
  }
}

// ── the controller ──────────────────────────────────────────────────────────

export interface LocalNetworkOptions {
  exec?: Exec;
  probe?: Probe;
  endpoint?: () => { host: string; port: number };
  hostname?: () => string;
}

export class LocalNetwork implements NetworkController {
  private readonly exec: Exec;
  private readonly probe: Probe;
  private readonly endpoint: () => { host: string; port: number };
  private readonly hostname: () => string;

  constructor(options: LocalNetworkOptions = {}) {
    this.exec = options.exec ?? realExec;
    this.probe = options.probe ?? realProbe;
    this.endpoint = options.endpoint ?? brokerEndpoint;
    this.hostname = options.hostname ?? (() => os.hostname());
  }

  private nmcli(args: string[], timeoutMs = QUERY_TIMEOUT_MS): Promise<ExecResult> {
    return this.exec('nmcli', args, timeoutMs);
  }

  /**
   * Is this machine one whose Wi-Fi the kiosk can set at all?
   *
   * Both answers are normal states rather than errors, and the screen says so
   * instead of showing a failure: a development machine has no `nmcli`, and a
   * kiosk provisioned before this feature existed has no NetworkManager.
   */
  private async capability(): Promise<Capability> {
    const result = await this.nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']);
    if (result.code !== 0) {
      log.debug('nmcli device status failed (%d): %s', result.code, result.stderr.trim());
      return {
        available: false,
        reason:
          'Auf diesem Gerät kann das WLAN nicht über den Bildschirm eingestellt werden, ' +
          'weil NetworkManager fehlt. Das Gerät muss dafür neu provisioniert werden ' +
          '(scripts/provision-kiosk.sh). Die Netzwerkeinstellungen bleiben bis dahin ' +
          'Sache des Betriebssystems.',
      };
    }
    const iface = wifiInterface(parseDevices(result.stdout));
    if (!iface) {
      return {
        available: false,
        reason:
          'Dieses Gerät hat keine WLAN-Schnittstelle gefunden. Bitte prüfen, ob das WLAN ' +
          'im BIOS eingeschaltet ist, und das Gerät neu starten. Bis dahin funktioniert ' +
          'nur die Verbindung über Netzwerkkabel.',
      };
    }
    return { available: true, iface };
  }

  async status(): Promise<NetworkStatus> {
    const hostname = this.hostname();
    const capability = await this.capability();
    if (!capability.available) {
      return {
        hostname, capability, ssid: null, signal: null,
        defaultRouteDevice: null, routedElsewhere: false,
      };
    }

    const [wifi, route] = await Promise.all([
      this.nmcli(['-t', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list']),
      this.exec('ip', ['route', 'show', 'default'], QUERY_TIMEOUT_MS),
    ]);

    const current = wifi.code === 0 ? parseScan(wifi.stdout).find((n) => n.active) ?? null : null;
    const defaultRouteDevice = route.code === 0 ? parseDefaultRouteDevice(route.stdout) : null;

    return {
      hostname,
      capability,
      ssid: current?.ssid ?? null,
      signal: current?.signal ?? null,
      defaultRouteDevice,
      routedElsewhere: defaultRouteDevice !== null && defaultRouteDevice !== capability.iface,
    };
  }

  /**
   * Visible networks, strongest first.
   *
   * `--rescan yes` on purpose: the cached list is whatever the machine happened
   * to see last, which on a kiosk carried in from the office is the office.
   */
  async scan(): Promise<WifiNetwork[]> {
    const capability = await this.capability();
    if (!capability.available) return [];
    const result = await this.nmcli([
      '-t', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list', '--rescan', 'yes',
    ]);
    if (result.code !== 0) {
      log.warn('Wi-Fi scan failed (%d): %s', result.code, result.stderr.trim());
      return [];
    }
    return parseScan(result.stdout);
  }

  private async connections(): Promise<ConnectionRow[]> {
    const result = await this.nmcli([
      '-t', '-f', 'NAME,UUID,TYPE,AUTOCONNECT-PRIORITY,ACTIVE,DEVICE', 'connection', 'show',
    ]);
    return result.code === 0 ? parseConnections(result.stdout) : [];
  }

  /**
   * Join a network, and give the machine its old one back if that does not work.
   *
   * The order is the safety property, so it is spelled out here rather than
   * left to be inferred from the calls:
   *
   *  1. Delete any leftover pending profile. One can only exist if a previous
   *     attempt died between steps, and reusing it would carry that attempt's
   *     password into this one.
   *  2. Create the new profile with `autoconnect no`, under a name of our own.
   *     Existing profiles are never modified: the one currently up may be the
   *     only known-good network this machine has, and a rewritten PSK cannot be
   *     read back and restored.
   *  3. Activate it, bounded.
   *  4. Test it against the MQTT box.
   *  5. On success, commit: rename, autoconnect on, priority above every other
   *     profile, and drop the stale profile for the same SSID. On any failure,
   *     delete the pending profile and bring the previous one back up.
   *
   * Because `autoconnect` is only set in step 5, a reboot at any earlier point
   * comes back on the previous network by itself.
   */
  async connect(ssid: string, psk: string): Promise<ConnectResult> {
    const capability = await this.capability();
    if (!capability.available) {
      return { ok: false, code: 'unavailable', error: capability.reason };
    }

    const before = await this.connections();
    const previous = before.find(
      (c) => c.active && c.type === '802-11-wireless' && c.device === capability.iface,
    );

    // Step 1.
    await this.nmcli(['connection', 'delete', PENDING_CON_NAME]);

    // Step 2. The PSK is passed as an argument, so it is briefly visible in the
    // process list of a machine only service personnel can log into. It is
    // never logged, which is the part that would otherwise leave it on disk and
    // in `GET /api/logs`.
    const addArgs = [
      'connection', 'add',
      'type', 'wifi',
      'con-name', PENDING_CON_NAME,
      'ifname', capability.iface,
      'ssid', ssid,
      'autoconnect', 'no',
    ];
    if (psk) {
      addArgs.push('wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', psk);
    }
    const added = await this.nmcli(addArgs);
    if (added.code !== 0) {
      const code = classifyActivationFailure(added.stderr);
      log.error('Creating the pending Wi-Fi profile failed (%d): %s', added.code, added.stderr.trim());
      return { ok: false, code, error: this.message(code, ssid, false, added.stderr) };
    }

    // Step 3.
    const up = await this.nmcli(
      ['-w', String(ACTIVATION_TIMEOUT_S), 'connection', 'up', PENDING_CON_NAME],
      (ACTIVATION_TIMEOUT_S + 10) * 1000,
    );
    if (up.code !== 0) {
      const code = classifyActivationFailure(up.stderr);
      log.warn('Wi-Fi activation for "%s" failed (%d): %s', ssid, up.code, up.stderr.trim());
      const restored = await this.rollback(previous);
      return { ok: false, code, error: this.message(code, ssid, restored, up.stderr) };
    }

    // Step 4. The configured MQTT broker is the acceptance test, and the
    // internet is not: on a site the box carries the uplink, so its mobile link
    // can be down while it serves MQTT perfectly — and refusing a correct
    // network over that would be the tail wagging the dog. The kiosk buffers
    // offline by design.
    const { host, port } = this.endpoint();
    const reachable = await this.probe(host, port, PROBE_TIMEOUT_MS);
    if (!reachable) {
      log.warn('Joined "%s" but the MQTT broker at %s:%d did not answer', ssid, host, port);
      const restored = await this.rollback(previous);
      return {
        ok: false,
        code: 'unreachable',
        error:
          // Named for what was actually probed, and with the port.
          //
          // It said "die Implenia-Box", which is the right noun on a site and
          // the wrong one everywhere else: the probe goes to whatever broker
          // this kiosk is configured for, and a kiosk pointed at a replay
          // server was told a device it has never met was not answering. The
          // port earns its place for the same reason — 1884 against an
          // expected 1883 is invisible without it.
          `Verbunden mit „${ssid}", aber der MQTT-Broker ${host}:${port} antwortet dort ` +
          'nicht — vermutlich das falsche WLAN, sonst die Broker-Adresse prüfen.' +
          this.restoredSuffix(restored),
      };
    }

    // Step 5.
    await this.commit(ssid, before);
    const internet = await this.probe('8.8.8.8', 53, PROBE_TIMEOUT_MS);
    log.info('Wi-Fi switched to "%s" (Internet: %s)', ssid, internet ? 'ja' : 'nein');
    return { ok: true, ssid, internet };
  }

  /**
   * Promote the pending profile to the permanent one.
   *
   * The priority is one above the highest any profile currently holds, so the
   * network a technician last chose deliberately is the one the machine prefers
   * when several are in range — which is exactly what happens when a kiosk that
   * knows the office Wi-Fi is carried onto a site.
   */
  private async commit(ssid: string, before: ConnectionRow[]): Promise<void> {
    const highest = before.reduce((max, c) => Math.max(max, c.priority), 0);

    await this.nmcli([
      'connection', 'modify', PENDING_CON_NAME,
      'connection.id', ssid,
      'connection.autoconnect', 'yes',
      'connection.autoconnect-priority', String(highest + 1),
    ]);

    // A profile for this SSID from an earlier setup would otherwise sit there
    // with its own autoconnect and its own password. Matched by name, which is
    // what both this module and `nmcli device wifi connect` name a profile
    // after; a profile named something else keeps its own name and is left
    // alone, which costs a stale entry and never the connection.
    for (const stale of before) {
      if (stale.name === ssid && stale.type === '802-11-wireless') {
        await this.nmcli(['connection', 'delete', stale.uuid]);
      }
    }
  }

  /**
   * Undo a failed attempt.
   *
   * Returns whether the machine is back on the network it had. The answer goes
   * into the error message: "das Gerät ist weiter verbunden" is worth saying,
   * and saying it when it is not true is worse than saying nothing.
   */
  private async rollback(previous: ConnectionRow | undefined): Promise<boolean> {
    await this.nmcli(['connection', 'down', PENDING_CON_NAME]);
    await this.nmcli(['connection', 'delete', PENDING_CON_NAME]);
    if (!previous) return false;
    const back = await this.nmcli(
      ['-w', String(ACTIVATION_TIMEOUT_S), 'connection', 'up', previous.uuid],
      (ACTIVATION_TIMEOUT_S + 10) * 1000,
    );
    if (back.code !== 0) {
      log.error(
        'Could not restore the previous Wi-Fi "%s": %s', previous.name, back.stderr.trim(),
      );
      return false;
    }
    log.info('Previous Wi-Fi "%s" restored after a failed switch', previous.name);
    return true;
  }

  /**
   * Where the machine ended up — and that it got there by being put back.
   *
   * The rollback has to be *said*, not implied. "Verbunden mit „X" … Das Gerät
   * ist mit keinem WLAN verbunden" is two true sentences in different tenses
   * with nothing between them, and it reads as a contradiction: the first
   * describes the attempt, the second the state after it was undone. Naming the
   * undo is what puts the two in order.
   */
  private restoredSuffix(restored: boolean): string {
    return restored
      ? ' Der Wechsel wurde zurückgenommen, das Gerät bleibt im bisherigen WLAN.'
      : ' Der Wechsel wurde zurückgenommen, das Gerät ist in keinem WLAN.';
  }

  /**
   * German, actionable — and short.
   *
   * The screen shows these in a box of fixed height, so that an arriving
   * message cannot move anything the technician is reaching for. That box holds
   * seven lines at the kiosk's resolution — 260 characters, with the budget
   * checked by measuring the rendered page rather than by counting them — and a
   * message longer than that is not merely wordy, it is partly unread. The
   * budget has to survive a 32-character SSID, which is the longest the
   * standard allows and wraps worse than its length suggests. `MAX_DETAIL`
   * bounds the one piece of text here that this module does not write itself.
   */
  private message(
    code: ConnectFailure, ssid: string, restored: boolean, detail: string,
  ): string {
    const suffix = this.restoredSuffix(restored);
    switch (code) {
      case 'unauthorized':
        return (
          'Dieses Gerät darf das WLAN nicht über den Bildschirm ändern. Dafür muss es neu ' +
          'provisioniert werden (scripts/provision-kiosk.sh).'
        );
      case 'bad-password':
        return (
          `Das Passwort für „${ssid}" wurde nicht angenommen. Bitte erneut eingeben, ` +
          'Groß- und Kleinschreibung beachten.' + suffix
        );
      case 'no-ip':
        return (
          `„${ssid}" hat keine IP-Adresse vergeben. Bitte prüfen, ob der Access Point ` +
          'vollständig gestartet ist, und erneut versuchen.' + suffix
        );
      default:
        return (
          `Die Verbindung mit „${ssid}" ist fehlgeschlagen.${suffix} Meldung: ` +
          (detail.trim().split('\n')[0] || 'keine').slice(0, MAX_DETAIL)
        );
    }
  }
}

export const network: NetworkController = new LocalNetwork();
