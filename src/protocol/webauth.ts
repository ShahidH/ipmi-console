/**
 * MegaRAC SP web session: POST /rpc/WEBSES/create.asp (WEBVAR_USERNAME /
 * WEBVAR_PASSWORD) returns SESSION_COOKIE, sent back as cookie "SessionCookie";
 * GET /Java/jviewer.jnlp allocates the KVM session and mints -kvmtoken;
 * /rpc/WEBSES/logout.asp ends the session.
 */
import http from 'node:http';
import https from 'node:https';
import { parseJnlp, toLaunchConfig, type LaunchConfig } from './jnlp';
import { tlsConnector, type TlsPolicy } from './tls';

export interface WebEndpoint {
  host: string;
  /** 'http' or 'https'. */
  scheme: 'http' | 'https';
  port?: number;
  tls?: TlsPolicy;
  timeoutMs?: number;
}

export class BmcHttpError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'protocol' | 'busy' | 'privilege' | 'unsupported') {
    super(message);
  }
}

export interface Resp { status: number; body: string; headers: http.IncomingHttpHeaders }

export async function request(ep: WebEndpoint, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Resp> {
  const r = await send(ep, method, path, headers, body, 2 * 1024 * 1024);
  return { status: r.status, body: r.data.toString('latin1'), headers: r.headers };
}

function send(ep: WebEndpoint, method: string, path: string, headers: Record<string, string>, body: string | undefined, maxBytes: number): Promise<{ status: number; data: Buffer; headers: http.IncomingHttpHeaders }> {
  const mod = ep.scheme === 'https' ? https : http;
  const port = ep.port ?? (ep.scheme === 'https' ? 443 : 80);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method, host: ep.host, port, path,
        headers: { 'User-Agent': 'IPMIConsole/0.1', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}) },
        timeout: ep.timeoutMs ?? 15000,
        // No agent: each request gets a fresh socket checked by tlsConnector (no pooled reuse).
        ...(ep.scheme === 'https' ? { createConnection: tlsConnector(ep.host, ep.tls) } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) req.destroy(new Error('response too large'));
          else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks), headers: res.headers }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out talking to ${ep.host}:${port}`)));
    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

/** Extracts `'KEY' : 'value'` or `KEY : number` from the BMC's JS-object responses. */
function rpcField(body: string, key: string): string | undefined {
  const m = new RegExp(`['"]?${key}['"]?\\s*:\\s*(?:'([^']*)'|"([^"]*)"|(-?\\d+))`).exec(body);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

export async function login(ep: WebEndpoint, username: string, password: string): Promise<string> {
  const form = new URLSearchParams({ WEBVAR_USERNAME: username, WEBVAR_PASSWORD: password }).toString();
  let r: Resp;
  try {
    r = await request(ep, 'POST', '/rpc/WEBSES/create.asp', { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
  } catch (e) {
    throw new BmcHttpError(`cannot reach BMC web server: ${(e as Error).message}`, 'network');
  }
  if (r.status !== 200) throw new BmcHttpError(`login failed: HTTP ${r.status}`, 'protocol');
  const hapi = Number(rpcField(r.body, 'HAPI_STATUS') ?? '0');
  const cookie = rpcField(r.body, 'SESSION_COOKIE');
  if (hapi !== 0 || !cookie || cookie === 'Failure_Login_IPMI_Then_LDAP' || cookie.startsWith('Failure')) {
    // HAPI_STATUS 0xD4 = no access; anything else means wrong credentials.
    if (hapi === 0xd4) throw new BmcHttpError('login refused: this user has no web access', 'privilege');
    throw new BmcHttpError('login failed: invalid username or password', 'auth');
  }
  return cookie;
}

export async function fetchLaunchConfig(ep: WebEndpoint, cookie: string): Promise<{ config: LaunchConfig; jnlp: string; jars: string[]; codebase?: string }> {
  const headers = { Cookie: `SessionCookie=${cookie}` };
  const paths = [`/Java/jviewer.jnlp?EXTRNIP=${encodeURIComponent(ep.host)}&JNLPSTR=JViewer`, '/Java/jviewer.jnlp'];
  let last = '';
  for (const p of paths) {
    let r: Resp;
    try {
      r = await request(ep, 'GET', p, headers);
    } catch (e) {
      throw new BmcHttpError(`cannot fetch JViewer launch file: ${(e as Error).message}`, 'network');
    }
    if (r.status === 200 && /<jnlp[\s>]/i.test(r.body)) {
      const info = parseJnlp(r.body);
      return { config: toLaunchConfig(info.args), jnlp: r.body, jars: info.jars, codebase: info.codebase };
    }
    if (/session_expired|sessionexpired/i.test(r.body)) {
      throw new BmcHttpError('BMC rejected the web session (expired or session pool exhausted)', 'busy');
    }
    last = `HTTP ${r.status}`;
  }
  throw new BmcHttpError(`BMC did not return a JViewer launch file (${last}); is KVM enabled for this user?`, 'protocol');
}

/** Resolves the jar paths named in a JNLP against its codebase path. */
export function jarPaths(jars: string[], codebase?: string): string[] {
  let base = '/Java/';
  try {
    if (codebase) base = new URL(codebase).pathname.replace(/\/?$/, '/');
  } catch { /* keep default */ }
  return jars.slice(0, 4).map((j) => (j.startsWith('/') ? j : base + j));
}

/** Usual jar paths on MegaRAC SP BMCs (JNLP codebase /Java, jars under release/). */
export const DEFAULT_JAR_PATHS = ['/Java/release/JViewer.jar', '/Java/release/JViewer-SOC.jar'];

/**
 * Downloads client jars (in parallel) for fingerprinting. Best-effort: returns
 * what could be fetched. Always fetched from `ep.host`.
 */
export async function fetchClientJars(ep: WebEndpoint, cookie: string | undefined, paths: string[]): Promise<Buffer[]> {
  const headers: Record<string, string> = cookie ? { Cookie: `SessionCookie=${cookie}` } : {};
  const got = await Promise.all(paths.map((p) => send({ ...ep, timeoutMs: ep.timeoutMs ?? 20000 }, 'GET', p, headers, undefined, 32 * 1024 * 1024).catch(() => null)));
  return got.flatMap((r) => (r?.status === 200 && r.data.length > 4 && r.data.readUInt32LE(0) === 0x04034b50 ? [r.data] : []));
}

/** Content-Length of each path via HEAD (null when unavailable), in parallel. */
export async function headSizes(ep: WebEndpoint, paths: string[]): Promise<Array<number | null>> {
  return Promise.all(paths.map(async (p) => {
    try {
      const r = await request({ ...ep, timeoutMs: 5000 }, 'HEAD', p, {});
      const n = Number(r.headers['content-length']);
      return r.status === 200 && Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }));
}

export async function logout(ep: WebEndpoint, cookie: string): Promise<void> {
  try {
    await request(ep, 'GET', '/rpc/WEBSES/logout.asp', { Cookie: `SessionCookie=${cookie}` });
  } catch {
    /* best effort */
  }
}
