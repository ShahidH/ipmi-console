/**
 * IVTP over the MegaRAC SP-X KVM WebSocket (wss://host/kvm), on top of the `ws`
 * package. BMC-specific parts:
 *  - subprotocols "binary, base64": with "base64" the BMC sends text frames of
 *    base64-encoded IVTP and expects the same back;
 *  - permessage-deflate (handled by `ws`), and IVTP bytes arriving in the same
 *    TCP read as the HTTP 101 (handled by `ws`).
 * Exposes the KvmStream shape used by KvmSession.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { tlsConnector, type TlsPolicy } from './tls';

export interface WsOptions {
  host: string;
  port: number;
  path: string;
  secure: boolean;
  headers?: Record<string, string>;
  protocols?: string[];
  tls?: TlsPolicy;
  timeoutMs?: number;
  log?: (m: string) => void;
}

export class WsStream extends EventEmitter {
  localAddress?: string;
  /** IVTP bytes received before anyone listens (the BMC greets immediately after the upgrade). */
  private pending: Buffer[] | null = [];

  private constructor(private readonly ws: WebSocket) {
    super();
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      const bytes = isBinary ? buf : Buffer.from(buf.toString('latin1').trim(), 'base64');
      if (!bytes.length) return;
      if (this.pending) this.pending.push(bytes);
      else this.emit('data', bytes);
    });
    this.on('newListener', (ev) => {
      if (ev !== 'data' || !this.pending) return;
      const queued = this.pending;
      this.pending = null;
      // Deliver after the listener is registered.
      if (queued.length) setImmediate(() => { for (const b of queued) this.emit('data', b); });
    });
    ws.on('close', () => this.emit('close'));
    // Before the session attaches its handler, errors are reported through connect()'s promise.
    ws.on('error', (e) => {
      if (this.listenerCount('error')) this.emit('error', e);
    });
  }

  get destroyed(): boolean {
    return this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED;
  }

  get protocol(): string {
    return this.ws.protocol;
  }

  static connect(o: WsOptions): Promise<{ stream: WsStream; initial: Buffer }> {
    const url = `${o.secure ? 'wss' : 'ws'}://${o.host}${o.port === (o.secure ? 443 : 80) ? '' : `:${o.port}`}${o.path}`;
    const ws = new WebSocket(url, o.protocols ?? [], {
      headers: o.headers,
      perMessageDeflate: { clientNoContextTakeover: true, serverNoContextTakeover: true },
      handshakeTimeout: o.timeoutMs ?? 15000,
      ...(o.secure ? { createConnection: tlsConnector(o.host, o.tls) } : {}),
    });
    // Messages may arrive before the caller attaches listeners: wrap immediately.
    const stream = new WsStream(ws);
    return new Promise((resolve, reject) => {
      ws.once('upgrade', (res) => {
        stream.localAddress = res.socket.localAddress;
      });
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`KVM WebSocket refused: HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim()));
        ws.terminate();
      });
      ws.once('open', () => {
        o.log?.(`KVM WebSocket open (protocol "${ws.protocol || 'none'}"${ws.extensions ? `, ${ws.extensions}` : ''})`);
        resolve({ stream, initial: Buffer.alloc(0) });
      });
      ws.once('error', reject);
    });
  }

  resume() {
    /* flow control is handled by ws */
  }

  write(data: Buffer): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.protocol.toLowerCase() === 'base64') this.ws.send(data.toString('base64'));
    else this.ws.send(data, { binary: true });
    return true;
  }

  destroy() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
    else this.ws.terminate();
  }
}
