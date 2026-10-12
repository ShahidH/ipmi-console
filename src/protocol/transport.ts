/**
 * Opens the KVM byte stream.
 *
 * Direct mode: TCP (or TLS when kvmsecure=1) to host:kvmport.
 *
 * Single-port mode (singleportenabled=1): the KVM stream is tunnelled through
 * the web server port. Connect host:kvmport (TLS if kvmsecure), send
 *     "CONNECT <host>:<websecureport> HTTP/1.1\n cookie <webcookie>\r\n\r\n"
 *     "JVIEWER VIDEO cookie <webcookie>\r\n\r\n"
 *   (" HTTPS/1.1\n" when kvmsecure=1) and read one reply; after it the socket
 *   carries raw IVTP. Virtual media uses service names CDMEDIA / FDMEDIA / HDMEDIA.
 */
import net from 'node:net';
import { connectTls, type TlsPolicy } from './tls';

export interface TransportOptions {
  host: string;
  port: number;
  secure: boolean;
  tls?: TlsPolicy;
  timeoutMs?: number;
  /** Single-port tunnel parameters; omit for a direct connection. */
  tunnel?: { webSecurePort: number; webCookie: string; service?: 'VIDEO' | 'CDMEDIA' | 'FDMEDIA' | 'HDMEDIA' };
  log?: (msg: string) => void;
}

export interface OpenedTransport {
  socket: net.Socket;
  /** Bytes received after the tunnel reply that already belong to the IVTP stream. */
  initial: Buffer;
  /** Text of the tunnel reply (single-port mode), with secrets removed. */
  tunnelReply?: string;
}

/** Error codes the single-port tunnel can return (ERROR:<n> replies). */
const TUNNEL_ERRORS: Record<string, string> = {
  '1': 'Invalid web session index',
  '2': 'Web session inactive',
  '3': 'No free slot for web session',
  '4': 'Invalid web session cookie',
  '5': 'Malformed web session cookie',
  '6': 'Username/password too long',
  '7': 'Web login failed',
};

export function tunnelRequests(host: string, webSecurePort: number, cookie: string, secure: boolean, service = 'VIDEO'): string[] {
  return [
    `CONNECT ${host}:${webSecurePort}${secure ? ' HTTPS/1.1\n' : ' HTTP/1.1\n'} cookie ${cookie}\r\n\r\n`,
    `JVIEWER ${service} cookie ${cookie}\r\n\r\n`,
  ];
}

function connect(o: TransportOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const timeout = o.timeoutMs ?? 15000;
    let sock: net.Socket;
    const onError = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    if (o.secure) {
      // connectTls registers its certificate check first, so this listener only runs for a trusted peer.
      sock = connectTls({ port: o.port }, o.host, o.tls);
      sock.once('secureConnect', () => {
        if (sock.destroyed) return;
        sock.off('error', onError);
        resolve(sock);
      });
    } else {
      sock = net.connect({ host: o.host, port: o.port }, () => {
        sock.off('error', onError);
        resolve(sock);
      });
    }
    sock.setTimeout(timeout, () => onError(new Error(`connection to ${o.host}:${o.port} timed out`)));
    sock.once('error', onError);
  });
}

/**
 * Reads the tunnel reply: until a quiet period or a blank line. If the first
 * bytes already look like an IVTP header, the reply is treated as absent.
 */
function readTunnelReply(sock: net.Socket, quietMs = 400, maxWaitMs = 10000): Promise<{ reply: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let quiet: NodeJS.Timeout | undefined;
    const finish = (split: number) => {
      cleanup();
      resolve({ reply: buf.subarray(0, split), rest: buf.subarray(split) });
    };
    const hard = setTimeout(() => (buf.length ? finish(buf.length) : (cleanup(), reject(new Error('no reply from single-port tunnel')))), maxWaitMs);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 8 && looksLikeIvtp(buf)) return finish(0);
      // Text reply followed by binary IVTP in the same read: split at the first
      // non-text byte.
      const bin = firstBinary(buf);
      if (bin > 0) return finish(bin);
      const end = blankLineEnd(buf);
      if (end >= 0) return finish(end);
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => finish(buf.length), quietMs);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(buf.length ? `tunnel closed: ${sanitize(buf.toString('latin1'))}` : 'tunnel closed without reply'));
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    function cleanup() {
      clearTimeout(hard);
      if (quiet) clearTimeout(quiet);
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('error', onErr);
      sock.pause();
    }
    sock.on('data', onData);
    sock.once('end', onEnd);
    sock.once('error', onErr);
    sock.resume();
  });
}

function looksLikeIvtp(b: Buffer): boolean {
  const type = b.readUInt16LE(0);
  const size = b.readUInt32LE(2);
  return type > 0 && type < 64 && size < 65536 && !/^[A-Za-z]/.test(String.fromCharCode(b[0]));
}

function firstBinary(b: Buffer): number {
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c > 0x7e || (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09)) return i;
  }
  return -1;
}

function blankLineEnd(b: Buffer): number {
  const s = b.toString('latin1');
  const a = s.indexOf('\r\n\r\n');
  const c = s.indexOf('\n\n');
  if (a >= 0 && (c < 0 || a <= c)) return a + 4;
  if (c >= 0) return c + 2;
  return -1;
}

function sanitize(s: string): string {
  return s.replace(/cookie\s+\S+/gi, 'cookie <redacted>').replace(/[^\x20-\x7e\n]/g, '.').trim();
}

export async function openTransport(o: TransportOptions): Promise<OpenedTransport> {
  const sock = await connect(o);
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 10000);
  if (!o.tunnel) {
    sock.setTimeout(0);
    return { socket: sock, initial: Buffer.alloc(0) };
  }
  const reqs = tunnelRequests(o.host, o.tunnel.webSecurePort, o.tunnel.webCookie, o.secure, o.tunnel.service);
  for (const r of reqs) sock.write(Buffer.from(r, 'latin1'));
  o.log?.(`single-port tunnel: requested service ${o.tunnel.service ?? 'VIDEO'} via ${o.host}:${o.port}`);
  let reply: { reply: Buffer; rest: Buffer };
  try {
    reply = await readTunnelReply(sock);
  } catch (e) {
    sock.destroy();
    throw e;
  }
  sock.setTimeout(0);
  const text = sanitize(reply.reply.toString('latin1'));
  o.log?.(`single-port tunnel reply: ${text ? JSON.stringify(text) : '(none)'}`);
  const err = /ERROR\s*:?\s*(\d+)/i.exec(text);
  if (err) {
    sock.destroy();
    throw new Error(`single-port tunnel refused: ${TUNNEL_ERRORS[err[1]] ?? `error ${err[1]}`}`);
  }
  return { socket: sock, initial: Buffer.from(reply.rest), tunnelReply: text };
}
