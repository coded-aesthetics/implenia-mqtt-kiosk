import pino from 'pino';
import { Writable } from 'node:stream';

const MAX_LOG_ENTRIES = 1000;

export interface LogEntry {
  level: string;
  time: number;
  module?: string;
  msg: string;
  [key: string]: unknown;
}

const entries: LogEntry[] = [];

type LogSubscriber = (entry: LogEntry) => void;
const subscribers = new Set<LogSubscriber>();

const ringBufferStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const entry: LogEntry = JSON.parse(chunk.toString().trim());
      entries.push(entry);
      if (entries.length > MAX_LOG_ENTRIES) entries.shift();
      for (const fn of subscribers) fn(entry);
    } catch {}
    callback();
  },
});

const isDev = process.env.NODE_ENV === 'development';

function buildLogger(): pino.Logger {
  const opts: pino.LoggerOptions = {
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (isDev) {
    return pino({
      ...opts,
      level: 'debug',
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }

  return pino(
    { ...opts, level: 'info' },
    pino.multistream([
      { stream: process.stdout },
      { stream: ringBufferStream },
    ]),
  );
}

export const logger = buildLogger();

export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}

export function onLogEntry(
  minLevel: string,
  fn: (entry: LogEntry) => void,
): () => void {
  const threshold = pino.levels.values[minLevel] ?? 0;
  const wrapper: LogSubscriber = (entry) => {
    const entryLevel = pino.levels.values[entry.level] ?? 0;
    if (entryLevel >= threshold) fn(entry);
  };
  subscribers.add(wrapper);
  return () => { subscribers.delete(wrapper); };
}

export function getLogEntries(options?: {
  limit?: number;
  level?: string;
  module?: string;
}): LogEntry[] {
  let result: LogEntry[] = entries;

  if (options?.level) {
    const threshold = pino.levels.values[options.level];
    if (threshold !== undefined) {
      result = result.filter((e) => {
        const entryLevel = pino.levels.values[e.level] ?? 0;
        return entryLevel >= threshold;
      });
    }
  }

  if (options?.module) {
    result = result.filter((e) => e.module === options.module);
  }

  const limit = options?.limit ?? 100;
  return result.slice(-limit);
}
