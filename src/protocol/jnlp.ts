/**
 * Parses the per-session launch descriptor (jviewer.jnlp) from the BMC web UI;
 * its <application-desc> arguments carry everything the KVM client needs.
 */

export interface JnlpInfo {
  codebase?: string;
  jars: string[];
  nativeLibs: string[];
  /** Raw argument map, flag name without the leading '-'. */
  args: Record<string, string>;
}

export interface LaunchConfig {
  appType: string;
  host: string;
  kvmToken: string;
  kvmTokenType: number;
  kvmSecure: boolean;
  kvmPort: number;
  vmSecure: boolean;
  singlePort: boolean;
  webSecurePort: number;
  webPort?: number;
  /** Web-session cookie; used in the single-port tunnel and IVTP GET_WEB_TOKEN. */
  webCookie: string;
  userPrivileges: number;
  cd: { state: number; num: number; port?: number };
  fd: { state: number; num: number; port?: number };
  hd: { state: number; num: number; port?: number };
  lang: string;
  /** Present on some newer firmware (rd450x-console reports oemfeatures & 32 = reconnect). */
  oemFeatures?: number;
  args: Record<string, string>;
}

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseJnlp(xml: string): JnlpInfo {
  if (!/<jnlp[\s>]/i.test(xml)) throw new Error('response is not a JNLP document');
  const codebase = /<jnlp[^>]*\scodebase\s*=\s*"([^"]*)"/i.exec(xml)?.[1];
  const jars = [...xml.matchAll(/<jar\s[^>]*href\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  const nativeLibs = [...xml.matchAll(/<nativelib\s[^>]*href\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  const values = [...xml.matchAll(/<argument>([\s\S]*?)<\/argument>/gi)].map((m) => decodeEntities(m[1].trim()));
  const args: Record<string, string> = {};
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!v.startsWith('-')) continue;
    const next = values[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      args[v.slice(1)] = next;
      i++;
    } else {
      args[v.slice(1)] = '';
    }
  }
  return { codebase, jars, nativeLibs, args };
}

const int = (v: string | undefined, d: number) => {
  const n = v === undefined || v === '' ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

/** Maps JNLP args onto a typed config, applying the BMC client's defaults. */
export function toLaunchConfig(args: Record<string, string>): LaunchConfig {
  if (!args.hostname) throw new Error('JNLP has no -hostname argument');
  if (!args.kvmtoken) throw new Error('JNLP has no -kvmtoken argument (session not allocated?)');
  const optPort = (v: string | undefined) => (v === undefined ? undefined : int(v, 0));
  return {
    appType: args.apptype ?? 'JViewer',
    host: args.hostname,
    kvmToken: args.kvmtoken,
    kvmTokenType: int(args.kvmtokentype, 0),
    kvmSecure: args.kvmsecure === '1',
    kvmPort: int(args.kvmport, 7578),
    vmSecure: args.vmsecure === '1',
    singlePort: args.singleportenabled === '1',
    webSecurePort: int(args.websecureport, 443),
    webPort: optPort(args.webport),
    webCookie: args.webcookie ?? '',
    userPrivileges: int(args.userpriv, 0),
    cd: { state: int(args.cdstate, 0), num: int(args.cdnum, 1), port: optPort(args.cdport) },
    fd: { state: int(args.fdstate, 0), num: int(args.fdnum, 1), port: optPort(args.fdport) },
    hd: { state: int(args.hdstate, 0), num: int(args.hdnum, 1), port: optPort(args.hdport) },
    lang: args.lang ?? 'EN',
    oemFeatures: args.oemfeatures === undefined ? undefined : int(args.oemfeatures, 0),
    args,
  };
}

/** KVM requires user privilege 4 or 5. */
export function kvmAllowed(cfg: LaunchConfig): boolean {
  return cfg.userPrivileges === 4 || cfg.userPrivileges === 5;
}

/** Names of arguments whose values are secrets and must never be logged. */
const SECRET_ARGS = new Set(['kvmtoken', 'webcookie', 'p', 'u']);

export function redactArgs(args: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, SECRET_ARGS.has(k) ? `<redacted ${v.length} chars>` : v]));
}
