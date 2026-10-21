/**
 * Splitting a topic into the group it is shown under and the name shown in it.
 *
 * Purely presentational — the Datenstrom screen lays topics out in a column per
 * group. **`${source}/${sensor_name}` is not a convention**: topic names differ
 * per box, which `server/assets/topic-maps/README.md` says in as many words.
 * So this is a heuristic that has to degrade, and the screen has to stay
 * correct when it degrades: a wrong split costs a heading, never a reading.
 *
 * It is computed here rather than in the browser because **the server knows
 * something the topic string does not say.** `Bohrgeraet/Drehzahl [1/min]` and
 * `device/3/Tiefe` are both three segments and want different splits — the
 * first wants one leading segment, the second two — and nothing in either
 * string tells them apart. But a resolved sensor name does: the leaf is the
 * sensor name and the group is whatever precedes it. Splitting on the last `/`
 * in the browser would have shown that channel as `min]`, which is the same
 * mistake `resolveSensorKey` carries a comment about.
 */

/** Topics the serial transport synthesizes — `device/<id>/<sensor name>`. */
const DEVICE_PREFIX = /^(device\/\d+)\//i;

export interface TopicSplit {
  /** The column heading. Empty for a topic with no prefix at all (`logs`). */
  prefix: string;
  /** What the tile shows. Never empty — it falls back to the whole topic. */
  leaf: string;
}

/**
 * Split a topic for display.
 *
 * `sensorName` is the sensor the topic resolved to, in any case, or null when
 * it resolved to nothing. When it is given and the topic ends with it, it wins:
 * that is the one split known to be right, including for the sensor names that
 * contain a slash (`Drehzahl [1/min]`, `Bohren/Düsen`, `W/Z-Wert`).
 */
export function splitTopic(topic: string, sensorName: string | null): TopicSplit {
  const trimmed = topic.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return { prefix: '', leaf: topic };

  if (sensorName) {
    const suffix = '/' + sensorName.toLowerCase();
    const lower = trimmed.toLowerCase();
    if (lower === sensorName.toLowerCase()) return { prefix: '', leaf: trimmed };
    if (lower.endsWith(suffix)) {
      return {
        prefix: trimmed.slice(0, trimmed.length - suffix.length),
        leaf: trimmed.slice(trimmed.length - suffix.length + 1),
      };
    }
  }

  // An unbound topic. `device/3/…` is the one multi-segment prefix the kiosk
  // produces itself, so it is worth knowing; anything else gets its first
  // segment, which is right for every observed box and harmless when it is not.
  const device = DEVICE_PREFIX.exec(trimmed);
  if (device) {
    return { prefix: device[1], leaf: trimmed.slice(device[1].length + 1) };
  }

  const cut = trimmed.indexOf('/');
  if (cut < 0) return { prefix: '', leaf: trimmed };
  return { prefix: trimmed.slice(0, cut), leaf: trimmed.slice(cut + 1) };
}
