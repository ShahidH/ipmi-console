// Small Electron-free main-process units: IPC validation, error mapping, logging.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { friendlyError } from '../../src/main/errors';
import { LogBook } from '../../src/main/log';
import { InvalidArgument, num, oneOf, parseServerInput, str } from '../../src/main/validate';
import { CertificateTrustError } from '../../src/protocol/tls';
import { BmcHttpError } from '../../src/protocol/webauth';

describe('IPC validation', () => {
  it('accepts well-formed values and rejects the rest', () => {
    expect(str('abc', 3)).toBe('abc');
    expect(() => str('abcd', 3)).toThrow(InvalidArgument);
    expect(() => str(42)).toThrow(InvalidArgument);
    expect(num(5, 1, 10)).toBe(5);
    for (const bad of [0, 11, NaN, Infinity, '5']) expect(() => num(bad, 1, 10)).toThrow(InvalidArgument);
    expect(oneOf('reset', ['on', 'reset'] as const)).toBe('reset');
    expect(() => oneOf('rm -rf', ['on', 'reset'] as const)).toThrow(InvalidArgument);
  });

  it('normalises a server form', () => {
    expect(parseServerInput({ host: ' 10.0.0.5 ', username: 'admin', webScheme: 'https', webPort: '8443', name: ' lab ', savePassword: true, password: 'pw' })).toEqual({
      id: undefined, name: 'lab', host: '10.0.0.5', webScheme: 'https', webPort: 8443, username: 'admin', profile: 'auto', family: 'auto',
      keyboardMode: 'auto', typingLayout: 'us', legacyTls: false, password: 'pw', savePassword: true,
    });
    expect(parseServerInput({ host: 'h', username: 'u', webScheme: 'ftp' }).webScheme).toBe('http');
    expect(parseServerInput({ host: 'h', username: 'u', typingLayout: 'gb' }).typingLayout).toBe('gb');
    expect(() => parseServerInput({ host: 'h', username: 'u', typingLayout: 'dvorak' })).toThrow(InvalidArgument);
  });

  it('rejects malformed server forms', () => {
    for (const bad of [null, 'x', {}, { host: '', username: 'u' }, { host: 'h' }, { host: 'h', username: 'u', webPort: 70000 }, { host: 'x'.repeat(300), username: 'u' }]) {
      expect(() => parseServerInput(bad)).toThrow(InvalidArgument);
    }
  });
});

describe('friendlyError', () => {
  it('maps errors to kinds the UI acts on', () => {
    expect(friendlyError(new CertificateTrustError('untrusted', 'AA:BB', 'CN=bmc'))).toEqual({ error: 'untrusted', kind: 'certificate', fingerprint: 'AA:BB', subject: 'CN=bmc' });
    expect(friendlyError(Object.assign(new Error('wrapped'), { cause: new CertificateTrustError('x', 'CC', 's') }))).toMatchObject({ kind: 'certificate', fingerprint: 'CC' });
    expect(friendlyError(new BmcHttpError('login failed', 'auth'))).toEqual({ error: 'login failed', kind: 'auth' });
    expect(friendlyError(new Error('connect ECONNREFUSED 10.0.0.5:80'))).toMatchObject({ kind: 'network' });
    expect(friendlyError(new Error('timed out talking to x'))).toMatchObject({ kind: 'network' });
    expect(friendlyError(new Error('self-signed certificate'))).toMatchObject({ kind: 'certificate' });
    expect(friendlyError('odd')).toEqual({ error: 'odd' });
    expect(friendlyError(new Error('BMC did not complete the KVM handshake in time'))).toMatchObject({ kind: 'busy', error: expect.stringMatching(/Another KVM session is probably still open/) });
  });
});

describe('LogBook', () => {
  it('keeps a bounded ring, writes the file and feeds listeners', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'logbook-')), 'session.log');
    const book = new LogBook(3, false);
    book.file = file;
    const live: string[] = [];
    book.onLine = (l) => live.push(l);
    for (const m of ['a', 'b', 'c', 'd']) book.log('info', m);
    book.log('debug', 'hidden');
    expect(book.text().split('\n').map((l) => l.slice(-1))).toEqual(['b', 'c', 'd']);
    expect(live).toHaveLength(4);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);
  });
});
