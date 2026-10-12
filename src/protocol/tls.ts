/**
 * TLS policy for BMC connections. Verification is ON by default. BMCs usually
 * present self-signed certificates, so a user can opt in *per host* to trust a
 * specific certificate, identified by its SHA-256 fingerprint (pinning). We
 * never disable verification globally (no NODE_TLS_REJECT_UNAUTHORIZED).
 */
import tls, { type ConnectionOptions, type PeerCertificate, type TLSSocket } from 'node:tls';

export interface TlsPolicy {
  /** SHA-256 fingerprint ("AA:BB:...") the user accepted for this host. */
  pinnedFingerprint?: string;
  /** Allow TLS 1.0/1.1 and weak ciphers for old BMC firmware (explicit opt-in). */
  legacyProtocols?: boolean;
}

export class CertificateTrustError extends Error {
  constructor(message: string, readonly fingerprint: string, readonly subject: string) {
    super(message);
  }
}

/**
 * Socket options for a BMC connection. Node's own verification is replaced by
 * checkPeer() on every socket (see connectTls): with rejectUnauthorized off, Node
 * would otherwise accept a failed check, and a self-signed chain error means
 * checkServerIdentity is never called. Callers must open sockets through
 * connectTls / tlsConnector, never with these options alone.
 */
function tlsOptions(host: string, policy: TlsPolicy = {}): ConnectionOptions {
  const opts: ConnectionOptions = { host, servername: isIp(host) ? undefined : host, rejectUnauthorized: false };
  if (policy.legacyProtocols) {
    opts.minVersion = 'TLSv1';
    opts.ciphers = 'DEFAULT:@SECLEVEL=0';
  }
  return opts;
}

/**
 * Decides whether a completed handshake may be used. Pinned host: exactly the
 * pinned certificate (expired or self-signed is fine; that is what was trusted).
 * Otherwise: only a certificate that verifies normally (chain and host name).
 * Failures carry the fingerprint so the user can be asked to trust it.
 */
function checkPeer(sock: TLSSocket, host: string, policy: TlsPolicy): CertificateTrustError | undefined {
  const cert = sock.getPeerCertificate();
  const fp = cert?.fingerprint256 ?? '';
  if (policy.pinnedFingerprint) {
    if (fp && fp.toUpperCase() === policy.pinnedFingerprint.toUpperCase()) return undefined;
    return new CertificateTrustError(`certificate for ${host} does not match the pinned fingerprint`, fp, describe(cert));
  }
  if (sock.authorized) return undefined;
  return new CertificateTrustError(`certificate for ${host} is not trusted (${sock.authorizationError})`, fp, describe(cert));
}

/**
 * Opens a TLS connection and applies the policy as soon as the handshake
 * completes, before the socket is handed back, so nothing is sent to an
 * untrusted peer.
 */
export function connectTls(options: ConnectionOptions, host: string, policy: TlsPolicy = {}): TLSSocket {
  const sock = tls.connect({ ...options, ...tlsOptions(host, policy) });
  sock.once('secureConnect', () => {
    const err = checkPeer(sock, host, policy);
    if (err) sock.destroy(err);
  });
  return sock;
}

/** `createConnection` for https.request and ws: every socket goes through connectTls. */
export function tlsConnector(host: string, policy: TlsPolicy = {}) {
  // `object`: http and ws pass their own request-args types; the TLS fields are what matter.
  return (options: object): TLSSocket => connectTls(options as ConnectionOptions, host, policy);
}

function describe(cert: PeerCertificate | undefined): string {
  if (!cert) return '';
  const s = cert.subject ? Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join(', ') : '';
  return `${s} (valid ${cert.valid_from} – ${cert.valid_to})`;
}

function isIp(h: string): boolean {
  return /^[\d.]+$/.test(h) || h.includes(':');
}
