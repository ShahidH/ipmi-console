/**
 * End-to-end connection management: web login → JNLP (allocates the KVM session
 * and mints the token) → KVM session, plus automatic reconnection after
 * recoverable drops. Used by the Electron main process and the CLI.
 */
import { EventEmitter } from 'node:events';
import { fingerprintJars, type JViewerFingerprint } from './jarprobe';
import { kvmAllowed, parseJnlp, redactArgs, toLaunchConfig, type LaunchConfig } from './jnlp';
import { detectFamily, FAMILY_NAMES, SUPPORTED_FAMILIES, type BmcFamily } from './detect';
import { selectProfile, selectSpxProfile, type ProfileChoice } from './profiles';
import { KvmSession, type SessionEvents } from './session';
import { spxKvmConfig, spxLogin, spxLogout, spxWsHeaders, type SpxSession } from './spx';
import type { TlsPolicy } from './tls';
import { BmcHttpError, DEFAULT_JAR_PATHS, fetchClientJars, fetchLaunchConfig, headSizes, jarPaths, login, logout, type WebEndpoint } from './webauth';
import { WsStream } from './websocket';

/** The connection was cancelled (disconnect() during connect()). */
export class ConnectCancelled extends Error {
  constructor() {
    super('Connection cancelled.');
  }
}

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

export interface ConnectParams {
  host: string;
  /** Web UI scheme/port used for login. */
  webScheme?: 'http' | 'https';
  webPort?: number;
  username: string;
  password: string;
  profile?: string;
  /** BMC family; 'auto' (default) runs unauthenticated detection first. */
  family?: BmcFamily | 'auto';
  tls?: TlsPolicy;
  /** Fingerprint cache: jar SHA-256 set → fingerprint (supplied by the app). */
  fingerprintCache?: Map<string, JViewerFingerprint>;
  /** Reconnect automatically after recoverable network drops. */
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
}

export interface ClientEvents {
  status: [{ phase: string; detail?: string }];
  session: [KvmSession];
  ended: [{ reason: string; willReconnect: boolean }];
}

export class KvmClient extends EventEmitter<ClientEvents> {
  session?: KvmSession;
  launch?: LaunchConfig;
  private fingerprint_?: JViewerFingerprint;
  private fingerprint_done = false;
  get jviewerFingerprint(): JViewerFingerprint | undefined {
    return this.fingerprint_;
  }
  private cookie?: string;
  private spx?: SpxSession;
  /** Family in use (detected once, then reused for reconnects). */
  family?: BmcFamily;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pendingReconnect?: () => Promise<void>;

  constructor(private readonly p: ConnectParams, private readonly log: Logger = () => {}) {
    super();
  }

  private get endpoint(): WebEndpoint {
    return { host: this.p.host, scheme: this.p.webScheme ?? 'http', port: this.p.webPort, tls: this.p.tls };
  }

  /**
   * Logs in and starts a session. If disconnect() is called meanwhile, whatever
   * was opened so far is closed again and this throws ConnectCancelled, so a
   * cancelled connect never leaves a session open on the BMC.
   */
  async connect(): Promise<KvmSession> {
    this.stopped = false;
    return this.cancellable(() => this.connectSteps());
  }

  private async cancellable(run: () => Promise<KvmSession>): Promise<KvmSession> {
    try {
      return await run();
    } catch (e) {
      if (this.stopped) throw new ConnectCancelled();
      throw e;
    }
  }

  /** Called after each step of a connect: stops there if disconnect() was called. */
  private checkStopped() {
    if (this.stopped) throw new ConnectCancelled();
  }

  private async connectSteps(): Promise<KvmSession> {
    if (!this.family) this.family = await this.resolveFamily();
    this.checkStopped();
    if (this.family === 'megarac-spx') return this.connectSpx();
    this.emit('status', { phase: 'login', detail: `${this.endpoint.scheme}://${this.p.host}` });
    // The client jars are public on MegaRAC SP BMCs, so check/download them
    // while the login runs.
    const t0 = Date.now();
    const prefetch = this.fingerprint_done ? Promise.resolve(this.fingerprint_) : this.probeJars(DEFAULT_JAR_PATHS).catch(() => undefined);
    this.cookie = await login(this.endpoint, this.p.username, this.p.password);
    this.log('info', `web login succeeded (${Date.now() - t0} ms)`);
    try {
      this.checkStopped();
      this.emit('status', { phase: 'launch', detail: 'requesting KVM launch parameters' });
      const { config, jars, codebase } = await fetchLaunchConfig(this.endpoint, this.cookie);
      this.checkStopped();
      this.log('info', `launch args: ${JSON.stringify(redactArgs(config.args))}`);
      const paths = jarPaths(jars, codebase);
      let fp = paths.join() === DEFAULT_JAR_PATHS.join() ? await prefetch : undefined;
      if (!fp && !this.fingerprint_done) fp = await this.probeJars(paths, this.cookie).catch(() => undefined);
      if (fp) {
        this.fingerprint_ = fp;
        this.fingerprint_done = true;
      } else {
        this.log('warn', 'could not inspect the BMC client jars; using JNLP heuristics');
      }
      this.checkStopped();
      this.log('info', `launch ready after ${Date.now() - t0} ms`);
      return await this.startSession(config);
    } catch (e) {
      await this.releaseWebSession();
      throw e;
    }
  }

  private async resolveFamily(): Promise<BmcFamily> {
    if (this.p.family && this.p.family !== 'auto') return this.p.family;
    this.emit('status', { phase: 'detect', detail: 'identifying the BMC firmware family' });
    const d = await detectFamily(this.endpoint);
    this.log('info', `BMC family: ${d.family} (${d.evidence.join('; ') || 'no evidence'})`);
    if (d.family === 'unknown') {
      this.log('warn', 'could not identify the BMC family; trying the MegaRAC SP (JViewer) login');
      return 'megarac-sp';
    }
    if (!SUPPORTED_FAMILIES.includes(d.family)) {
      throw new BmcHttpError(`This looks like ${FAMILY_NAMES[d.family]}, which is not supported yet (only AMI MegaRAC SP and SP-X are).`, 'unsupported');
    }
    return d.family;
  }

  /** MegaRAC SP-X: REST login → h5viewercfg token → IVTP over wss://host/kvm. */
  private async connectSpx(): Promise<KvmSession> {
    const ep = this.endpoint;
    this.emit('status', { phase: 'login', detail: `${ep.scheme}://${this.p.host} (SP-X)` });
    this.spx = await spxLogin(ep, this.p.username, this.p.password);
    this.log('info', 'SP-X web login succeeded');
    try {
      this.checkStopped();
      this.emit('status', { phase: 'launch', detail: 'requesting KVM token' });
      const cfg = await spxKvmConfig(ep, this.spx);
      this.checkStopped();
      this.log('info', `SP-X KVM config: server_ip=${cfg.serverIp ? 'yes' : 'no'} session=${cfg.session ? 'yes' : 'no'} reconnect=${cfg.reconnect}`);
      const secure = ep.scheme === 'https';
      const port = ep.port ?? (secure ? 443 : 80);
      const launch = toLaunchConfig({ hostname: this.p.host, kvmtoken: cfg.token, kvmport: String(port), kvmsecure: secure ? '1' : '0', userpriv: '4', apptype: 'H5Viewer' });
      const choice = selectSpxProfile(this.p.profile, !!cfg.serverIp);
      const spx = this.spx;
      return await this.startSession(launch, choice, {
        openStream: () => WsStream.connect({
          host: this.p.host, port, path: '/kvm', secure, tls: this.p.tls, protocols: ['binary', 'base64'],
          headers: spxWsHeaders(ep, spx), log: (m) => this.log('info', m),
        }),
        extraContext: {
          localIp: cfg.clientIp, serverIp: cfg.serverIp, spxSession: cfg.session, reconnectFeature: cfg.reconnect,
        },
      });
    } catch (e) {
      await this.releaseWebSession();
      throw e;
    }
  }

  /**
   * Fingerprints the client jars at `paths`. A cached fingerprint is reused when
   * HEAD reports the same jar sizes for this host (one round trip instead of a
   * ~0.5 MB download); otherwise the jars are downloaded in parallel.
   */
  private async probeJars(paths: string[], cookie?: string): Promise<JViewerFingerprint | undefined> {
    const cache = this.p.fingerprintCache;
    const t0 = Date.now();
    const sizes = cache ? await headSizes(this.endpoint, paths) : [];
    const sizeKey = sizes.length && sizes.every((n) => n !== null) ? `${this.p.host}|${paths.join(',')}|${sizes.join(',')}` : undefined;
    const hit = sizeKey ? cache?.get(sizeKey) : undefined;
    if (hit) {
      this.log('info', `JViewer fingerprint (cached, jar sizes unchanged, ${Date.now() - t0} ms): validate=${hit.validatePacketSize}`);
      return hit;
    }
    const bufs = await fetchClientJars(this.endpoint, cookie, paths);
    if (!bufs.length) return undefined;
    const { createHash } = await import('node:crypto');
    const shaKey = bufs.map((b) => createHash('sha256').update(b).digest('hex')).join(',');
    const fp = cache?.get(shaKey) ?? fingerprintJars(bufs);
    cache?.set(shaKey, fp);
    if (sizeKey) cache?.set(sizeKey, fp);
    this.log('info', `JViewer fingerprint (${Date.now() - t0} ms): validate=${fp.validatePacketSize} keepAlive=${fp.hasKeepAlive} connComplete=${fp.hasConnectionComplete} singlePort=${fp.hasSinglePort} km=${fp.kmCipher} classes=${fp.classCount}`);
    return fp;
  }

  /** Starts a session from a JNLP the user already has (e.g. downloaded from the web UI). */
  async connectWithJnlp(jnlpXml: string): Promise<KvmSession> {
    this.stopped = false;
    this.family = 'megarac-sp';
    const config = toLaunchConfig(parseJnlp(jnlpXml).args);
    this.log('info', `launch args (from JNLP file): ${JSON.stringify(redactArgs(config.args))}`);
    return this.cancellable(() => this.startSession(config));
  }

  private async startSession(config: LaunchConfig, chosen?: ProfileChoice, extra?: Pick<ConstructorParameters<typeof KvmSession>[0], 'openStream' | 'extraContext'>): Promise<KvmSession> {
    if (!kvmAllowed(config)) {
      throw new BmcHttpError(`this account lacks KVM privilege (userpriv=${config.userPrivileges})`, 'privilege');
    }
    this.launch = config;
    const choice = chosen ?? selectProfile(config, this.p.profile, this.fingerprint_);
    const profile = choice.profile;
    this.log('info', `firmware profile: ${profile.id} (${profile.status}); basis: ${choice.basis}`);
    if (choice.warning) {
      this.log('warn', choice.warning);
      this.emit('status', { phase: 'warning', detail: choice.warning });
    }
    const session = new KvmSession({
      connectHost: this.p.host || config.host,
      launch: config,
      profile,
      username: this.p.username,
      tls: this.p.tls,
      log: this.log,
      openStream: extra?.openStream,
      extraContext: extra?.extraContext ? Object.fromEntries(Object.entries(extra.extraContext).filter(([, v]) => v !== undefined)) : undefined,
    });
    session.on('state', (s, d) => this.emit('status', { phase: s, detail: d }));
    this.emit('status', { phase: 'connecting', detail: extra?.openStream ? `WebSocket ${config.kvmSecure ? 'wss' : 'ws'}://…/kvm` : `${config.singlePort ? 'single-port' : 'direct'} ${config.kvmSecure ? 'TLS' : 'TCP'} port ${config.kvmPort}` });
    // Announce before starting so listeners see frames that arrive together with
    // the validate response. Kept from the start, so disconnect() can abort the handshake.
    this.checkStopped();
    this.session = session;
    this.emit('session', session);
    await session.start();
    this.checkStopped();
    this.attempts = 0;
    session.on('closed', (c) => this.onSessionClosed(c));
    return session;
  }

  private onSessionClosed(c: SessionEvents['closed'][0]) {
    if (this.stopped) {
      // disconnect() is in progress and releases the web session itself.
      this.emit('ended', { reason: c.reason, willReconnect: false });
      return;
    }
    const can = c.retryable && (this.p.autoReconnect ?? true) && this.p.password !== '';
    const max = this.p.maxReconnectAttempts ?? 8;
    if (!can || this.attempts >= max) {
      this.emit('ended', { reason: c.reason, willReconnect: false });
      void this.releaseWebSession();
      return;
    }
    this.attempts++;
    const delay = Math.min(30000, 1000 * 2 ** (this.attempts - 1));
    this.emit('ended', { reason: c.reason, willReconnect: true });
    this.emit('status', { phase: 'reconnecting', detail: `attempt ${this.attempts}/${max} in ${Math.round(delay / 1000)}s` });
    this.pendingReconnect = async () => {
      this.pendingReconnect = undefined;
      if (this.stopped) return;
      await this.releaseWebSession();
      try {
        // Not connect(): that clears `stopped`, which disconnect() may have set meanwhile.
        await this.cancellable(() => this.connectSteps());
      } catch (e) {
        if (e instanceof ConnectCancelled) return;
        this.log('warn', `reconnect failed: ${(e as Error).message}`);
        this.onSessionClosed({ reason: (e as Error).message, expected: false, retryable: !(e instanceof BmcHttpError && e.kind === 'auth') });
      }
    };
    this.reconnectTimer = setTimeout(() => void this.pendingReconnect?.(), delay);
  }

  /** Skips the remaining back-off delay of a scheduled reconnect. Returns false if none is pending. */
  retryNow(): boolean {
    const run = this.pendingReconnect;
    if (!run || this.stopped) return false;
    clearTimeout(this.reconnectTimer);
    this.log('info', 'reconnect: retrying now (user request)');
    void run();
    return true;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    await this.session?.stop();
    await this.releaseWebSession();
  }

  private async releaseWebSession() {
    if (this.spx) {
      const s = this.spx;
      this.spx = undefined;
      await spxLogout(this.endpoint, s);
      this.log('info', 'SP-X web session logged out');
    }
    if (!this.cookie) return;
    const c = this.cookie;
    this.cookie = undefined;
    await logout(this.endpoint, c);
    this.log('info', 'web session logged out');
  }
}
