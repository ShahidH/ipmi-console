// Certificate policy against real TLS servers: default verification, the one-shot
// "show me the fingerprint" mode, and pinning (match and mismatch).
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tcpReachable } from '../src/main/reachability';
import { CertificateTrustError } from '../src/protocol/tls';
import { request } from '../src/protocol/webauth';
import { WsStream } from '../src/protocol/websocket';

let hasOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}

describe.skipIf(!hasOpenssl)('TLS certificate policy', () => {
  let server: https.Server;
  let port = 0;
  let fingerprint = '';
  /** An "attacker" endpoint with a different certificate that records everything it receives. */
  let mitm: tls.Server;
  let mitmPort = 0;
  let mitmFingerprint = '';
  const received: Buffer[] = [];

  beforeAll(async () => {
    // A self-signed certificate, as BMCs ship.
    const dir = mkdtempSync(join(tmpdir(), 'tls-test-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=bmc.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = readFileSync(join(dir, 'cert.pem'));
    fingerprint = new X509Certificate(cert).fingerprint256;
    server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;

    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=attacker', '-keyout', join(dir, 'k2.pem'), '-out', join(dir, 'c2.pem')], { stdio: 'ignore' });
    mitmFingerprint = new X509Certificate(readFileSync(join(dir, 'c2.pem'))).fingerprint256;
    mitm = tls.createServer({ key: readFileSync(join(dir, 'k2.pem')), cert: readFileSync(join(dir, 'c2.pem')) }, (s) => {
      s.on('data', (d: Buffer) => received.push(d));
      s.on('error', () => {});
    });
    await new Promise<void>((r) => mitm.listen(0, '127.0.0.1', r));
    mitmPort = (mitm.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => mitm.close(() => r()));
  });

  const get = (tls: Parameters<typeof request>[0]['tls']) => request({ host: '127.0.0.1', scheme: 'https', port, tls, timeoutMs: 5000 }, 'GET', '/', {});

  it('refuses an unpinned self-signed certificate and reports its fingerprint for the trust prompt', async () => {
    const err = await get(undefined).catch((e) => e);
    expect(err).toBeInstanceOf(CertificateTrustError);
    expect(err.message).toMatch(/not trusted \(.*SELF_SIGNED/i);
    expect(err.fingerprint).toBe(fingerprint);
    expect(err.subject).toContain('CN=bmc.test');
  });

  it('connects when the pinned fingerprint matches (case-insensitive)', async () => {
    expect((await get({ pinnedFingerprint: fingerprint.toLowerCase() })).body).toBe('ok');
  });

  it('refuses a certificate that does not match the pin', async () => {
    const wrong = fingerprint.replace(/^../, fingerprint.startsWith('00') ? '11' : '00');
    const err = await get({ pinnedFingerprint: wrong }).catch((e) => e);
    expect(err).toBeInstanceOf(CertificateTrustError);
    expect(err.message).toMatch(/does not match the pinned fingerprint/);
  });

  it('sends nothing (no login, no password) to a peer that fails the check', async () => {
    received.length = 0;
    const ep = (pin?: string) => ({ host: '127.0.0.1', scheme: 'https' as const, port: mitmPort, tls: { pinnedFingerprint: pin }, timeoutMs: 5000 });
    // Pinned to the real BMC, but the attacker answers.
    await expect(request(ep(fingerprint), 'POST', '/rpc/WEBSES/create.asp', {}, 'WEBVAR_USERNAME=admin&WEBVAR_PASSWORD=secret')).rejects.toBeInstanceOf(CertificateTrustError);
    // Not pinned at all.
    await expect(request(ep(), 'POST', '/api/session', {}, 'username=admin&password=secret')).rejects.toBeInstanceOf(CertificateTrustError);
    // KVM WebSocket.
    await expect(WsStream.connect({ host: '127.0.0.1', port: mitmPort, path: '/kvm', secure: true, tls: { pinnedFingerprint: fingerprint }, headers: { Cookie: 'QSESSIONID=secret' }, timeoutMs: 5000 })).rejects.toBeInstanceOf(CertificateTrustError);
    await new Promise((r) => setTimeout(r, 200));
    expect(Buffer.concat(received).toString('latin1')).toBe('');
    // Sanity: the attacker's certificate is what was seen.
    const err = await request(ep(), 'GET', '/', {}).catch((e) => e);
    expect(err.fingerprint).toBe(mitmFingerprint);
  });

  it('reachability sees an open port and a closed one', async () => {
    expect(await tcpReachable('127.0.0.1', port)).toBe(true);
    expect(await tcpReachable('127.0.0.1', 1, 1000)).toBe(false);
  });
});
