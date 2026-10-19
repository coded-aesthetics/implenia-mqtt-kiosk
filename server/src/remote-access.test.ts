import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIdFile, parseStatus, readAnydeskId, resetRemoteAccessCache } from './remote-access.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anydesk-id-'));

beforeEach(() => resetRemoteAccessCache());
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function idFile(content: string): string {
  const file = path.join(tmp, `id-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, content);
  return file;
}

describe('parseIdFile', () => {
  it('reads a plain id', () => {
    expect(parseIdFile('1234567890\n')).toBe('1234567890');
  });

  it('reads an id AnyDesk printed with spaces', () => {
    expect(parseIdFile('1 234 567 890\n')).toBe('1234567890');
  });

  it('takes the first line only', () => {
    expect(parseIdFile('987654321\nsome trailing note\n')).toBe('987654321');
  });

  // The whole point of the pattern: a service tech must never be shown
  // something that is not an id as if it were one.
  it.each([
    ['empty', ''],
    ['whitespace', '   \n'],
    ['an error message', 'error: service not running\n'],
    ['a partial id', '12345'],
    ['digits with words', 'id 1234567890 online'],
  ])('rejects %s', (_label, content) => {
    expect(parseIdFile(content)).toBeNull();
  });
});

describe('parseStatus', () => {
  it('reads online', () => expect(parseStatus('online\n')).toBe('online'));
  it('reads offline', () => expect(parseStatus('offline\n')).toBe('offline'));

  // 'offline' must not be read as 'online' by a careless substring test.
  it('does not read offline as online', () => {
    expect(parseStatus('  OFFLINE  ')).toBe('offline');
  });

  it('is null for anything else', () => {
    expect(parseStatus('')).toBeNull();
    expect(parseStatus('command not found')).toBeNull();
  });
});

describe('readAnydeskId', () => {
  it('reads the provisioned file', () => {
    expect(readAnydeskId(idFile('1234567890'))).toBe('1234567890');
  });

  it('is null when the file does not exist', () => {
    expect(readAnydeskId(path.join(tmp, 'absent.txt'))).toBeNull();
  });

  // A kiosk provisioned after the server started must not have to wait for a
  // restart, so a miss is never cached.
  it('re-reads after a miss', () => {
    const absent = path.join(tmp, 'later.txt');
    expect(readAnydeskId(absent)).toBeNull();
    fs.writeFileSync(absent, '555666777\n');
    expect(readAnydeskId(absent)).toBe('555666777');
  });

  it('caches a hit', () => {
    const file = idFile('111222333');
    expect(readAnydeskId(file)).toBe('111222333');
    fs.writeFileSync(file, '999888777');
    expect(readAnydeskId(file)).toBe('111222333');
  });
});
