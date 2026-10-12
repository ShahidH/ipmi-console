/**
 * MegaRAC SP-X (H5Viewer generation) web API.
 * Reported by megarac-kvm-rs (Tyan S8030 fw 6.02), hitsc (ASRock Rack, ASUS),
 * ovh-ikvm-mcp (OVH /api/kvm/token variant).
 *
 *   POST   /api/session                       form username/password → JSON {ok, CSRFToken, privilege}
 *          (session cookie QSESSIONID via Set-Cookie; CSRF sent as X-CSRFTOKEN and cookie garc/__Host-garc)
 *   GET    /api/settings/media/h5viewercfg    → {token, session, client_ip, server_ip}
 *   GET    /api/kvm/token                     (OVH builds) → {token, client_ip}
 *   GET    /api/configuration/project         → [{feature: "KVM_SESSION_RECONNECT"}, ...]
 *   DELETE /api/session                       logout
 */
import { BmcHttpError, request, type Resp, type WebEndpoint } from './webauth';

export interface SpxSession {
  csrf: string;
  cookies: Record<string, string>;
}

export interface SpxKvmConfig {
  token: string;
  session?: string;
  clientIp?: string;
  serverIp?: string;
  reconnect: boolean;
}

function parseCookies(r: Resp, into: Record<string, string> = {}): Record<string, string> {
  const sc = r.headers['set-cookie'] ?? [];
  for (const c of Array.isArray(sc) ? sc : [sc]) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
    if (m) into[m[1]] = m[2];
  }
  return into;
}

function headers(ep: WebEndpoint, s: SpxSession): Record<string, string> {
  const origin = `${ep.scheme}://${ep.host}${ep.port ? `:${ep.port}` : ''}`;
  return {
    Cookie: Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
    'X-CSRFTOKEN': s.csrf,
    Origin: origin,
    Referer: `${origin}/`,
    Accept: 'application/json',
  };
}

export async function spxLogin(ep: WebEndpoint, username: string, password: string): Promise<SpxSession> {
  const origin = `${ep.scheme}://${ep.host}${ep.port ? `:${ep.port}` : ''}`;
  let r: Resp;
  try {
    r = await request(ep, 'POST', '/api/session', {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: `${origin}/`, Accept: 'application/json',
    }, new URLSearchParams({ username, password }).toString());
  } catch (e) {
    throw new BmcHttpError(`cannot reach BMC web server: ${(e as Error).message}`, 'network');
  }
  if (r.status === 401 || r.status === 403) throw new BmcHttpError('login failed: invalid username or password', 'auth');
  if (r.status === 503 || r.status === 429) throw new BmcHttpError('the BMC has no free web sessions; close other sessions and retry', 'busy');
  let j: { ok?: number; CSRFToken?: string; privilege?: number };
  try {
    j = JSON.parse(r.body);
  } catch {
    throw new BmcHttpError(`unexpected SP-X login response (HTTP ${r.status})`, 'protocol');
  }
  if (r.status >= 300 || (j.ok !== undefined && j.ok !== 0) || !j.CSRFToken) throw new BmcHttpError('login failed: invalid username or password', 'auth');
  const cookies = parseCookies(r);
  // Browser clients mirror the CSRF token in a cookie (garc / __Host-garc depending on build).
  cookies.garc ??= j.CSRFToken;
  cookies['__Host-garc'] ??= j.CSRFToken;
  return { csrf: j.CSRFToken, cookies };
}

async function getJson(ep: WebEndpoint, s: SpxSession, path: string): Promise<unknown | undefined> {
  const r = await request(ep, 'GET', path, headers(ep, s));
  if (r.status !== 200) return undefined;
  try {
    return JSON.parse(r.body);
  } catch {
    return undefined;
  }
}

export async function spxKvmConfig(ep: WebEndpoint, s: SpxSession): Promise<SpxKvmConfig> {
  let cfg = (await getJson(ep, s, '/api/settings/media/h5viewercfg')) as Record<string, string> | undefined;
  if (!cfg?.token) cfg = (await getJson(ep, s, '/api/kvm/token')) as Record<string, string> | undefined;
  if (!cfg?.token) throw new BmcHttpError('the BMC did not provide a KVM token (is KVM enabled for this user?)', 'privilege');
  const project = await getJson(ep, s, '/api/configuration/project').catch(() => undefined);
  const features = Array.isArray(project) ? project.map((f: { feature?: string }) => f?.feature) : [];
  // Browser clients also set this cookie after the config fetch (hitsc).
  s.cookies['__Host-isActiveKVM'] = 'true';
  return {
    token: String(cfg.token),
    session: cfg.session ? String(cfg.session) : undefined,
    clientIp: cfg.client_ip ? String(cfg.client_ip) : undefined,
    serverIp: cfg.server_ip ? String(cfg.server_ip) : undefined,
    reconnect: features.includes('KVM_SESSION_RECONNECT'),
  };
}

export function spxWsHeaders(ep: WebEndpoint, s: SpxSession): Record<string, string> {
  const h = headers(ep, s);
  return { Cookie: h.Cookie, Origin: h.Origin };
}

export async function spxLogout(ep: WebEndpoint, s: SpxSession): Promise<void> {
  try {
    await request(ep, 'DELETE', '/api/session', headers(ep, s));
  } catch { /* best effort */ }
}
