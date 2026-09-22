/**
 * Reader for raw MQTT captures recorded on a rig.
 *
 * A capture is one message per line, as the box published it:
 *
 *     2026-05-18 15:42:40.190 Bohrgeraet/Tiefe 3.247500
 *     <date>     <time>       <topic>          <payload>
 *
 * The payload is a raw value and may be anything the rig felt like sending,
 * including `nan` and the empty string. Nothing here interprets it — that is
 * the job of the same parsing the live path uses, which is the whole point of
 * replaying a capture through it.
 *
 * See `assets/reference/README.md` for where the G08 reference capture came
 * from and what is known to be true about it. The capture itself is kept
 * outside the repo; `server/test-fixtures/` holds the slices the tests use.
 *
 * Timestamps in a capture are **local wall clock with no offset**, so they fix
 * the order and the spacing of messages but not an absolute instant. Callers
 * that need epoch milliseconds pass the offset the site was recorded in;
 * anything comparing messages to each other does not care.
 */

export interface DumpMessage {
  /** Wall-clock timestamp as written in the capture, e.g. `15:42:40.190`. */
  time: string;
  /** Milliseconds since the first message of the capture. */
  offsetMs: number;
  topic: string;
  payload: string;
}

const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) (\S+) ?(.*)$/;

/** Wall clock of one line as milliseconds, ignoring the date. */
function timeOfDayMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

/**
 * Parse a capture into messages, skipping lines that are not messages.
 *
 * A malformed line is dropped rather than thrown on: a capture is a recording
 * of a real machine, and a truncated last line is normal.
 */
export function parseDump(content: string): DumpMessage[] {
  const messages: DumpMessage[] = [];
  let base: number | null = null;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const m = LINE.exec(line);
    if (!m) continue;

    const [, , , , hh, mi, ss, ms, topic, payload] = m;
    const at = timeOfDayMs(hh, mi, ss, ms);
    if (base === null) base = at;

    messages.push({
      time: `${hh}:${mi}:${ss}.${ms}`,
      // Captures never cross midnight in practice; if one did, this would go
      // negative rather than silently wrap, which is the failure we want.
      offsetMs: at - base,
      topic,
      payload,
    });
  }

  return messages;
}

/** Distinct topics in a capture, with how many messages each carried. */
export function topicCounts(messages: DumpMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.topic, (counts.get(m.topic) ?? 0) + 1);
  return counts;
}
