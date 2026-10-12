/**
 * One KVM session: transport + IVTP handshake + packet dispatch. Network only;
 * video decoding happens elsewhere (the session emits reassembled frames).
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { kmCipher } from './blowfish';
import { HidPacketizer } from './hid';
import { encodeHeader, encodePacket, FrameAssembler, IvtpReader, Op, OP_NAMES, type IvtpPacket } from './ivtp';
import type { LaunchConfig } from './jnlp';
import type { FirmwareProfile, HandshakeContext } from './profiles';
import type { TlsPolicy } from './tls';
import { openTransport } from './transport';

/** Minimal duplex byte stream: a net/tls socket or the SP-X WebSocket adapter. */
export interface KvmStream {
  write(b: Buffer): unknown;
  /** Closes gracefully once queued data is sent (TCP FIN / WebSocket close). */
  end?(): unknown;
  destroy(): void;
  readonly destroyed: boolean;
  readonly localAddress?: string;
  on(ev: 'data', fn: (d: Buffer) => void): unknown;
  on(ev: 'close', fn: () => void): unknown;
  on(ev: 'error', fn: (e: Error) => void): unknown;
  resume?(): unknown;
}

export type SessionState = 'idle' | 'connecting' | 'handshake' | 'connected' | 'closed';

const MouseMode = { RELATIVE: 1, ABSOLUTE: 2, OTHER: 3 } as const;

export const PowerAction = { OFF: 0, ON: 1, CYCLE: 2, HARD_RESET: 3, SOFT_RESET: 4 } as const;

/** STOP_SESSION_IMMEDIATE status values (8-10 seen on ASMB8). */
const STOP_REASONS: Record<number, string> = {
  2: 'The BMC closed this session (for example, an administrator ended it in the web interface).',
  5: 'KVM configuration changed on the BMC; the redirection engine restarted.',
  7: 'The web session was logged out.',
  8: 'The BMC KVM licence has expired.',
  9: 'The KVM session timed out on the BMC.',
  10: 'The BMC disconnected the KVM session.',
};

/**
 * Stop reasons worth reconnecting after: only a configuration change, which
 * restarts the service. The others are the BMC's decision (an administrator
 * ended the session, an inactivity timeout, a logout or an expired licence).
 */
const RETRYABLE_STOPS = new Set([5]);

/**
 * KVM_SHARING status byte 0 (byte 1 is the answer for code 4). Codes 1 and 0
 * go to the session that owns the console; 2 and 4 to the one asking for it.
 */
export const Share = { CANCELLED: 0, REQUEST: 1, WAITING: 2, TIMED_OUT: 3, ANSWER: 4 } as const;
export const ShareAnswer = { FULL: 0, DENIED: 1, VIEW_ONLY: 2, FULL_BY_TIMEOUT: 3 } as const;

/** VALIDATE_VIDEO_SESSION_RESPONSE byte 0. */
const VALIDATE_RESULTS: Record<number, string> = {
  0: 'The BMC rejected the KVM session token (authentication failure).',
  2: 'KVM is disabled for this user or on this BMC (insufficient privilege).',
  3: 'The BMC rejected the session information (invalid video session token / mismatched profile).',
  4: 'Invalid CD-ROM session token.',
  5: 'Invalid floppy session token.',
  8: 'The KVM session is not registered on the BMC (token expired).',
};

export interface SessionOptions {
  /** Host/IP the user entered (may differ from the JNLP -hostname behind NAT). */
  connectHost: string;
  /** Opens the byte stream; defaults to direct/single-port TCP from the launch config. */
  openStream?: () => Promise<{ stream: KvmStream; initial: Buffer }>;
  /** Extra handshake context (SP-X h5viewercfg values, reconnect feature). */
  extraContext?: Partial<HandshakeContext>;
  launch: LaunchConfig;
  profile: FirmwareProfile;
  username: string;
  tls?: TlsPolicy;
  handshakeTimeoutMs?: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

export interface SessionEvents {
  state: [SessionState, string?];
  /** Every packet received from the BMC (for recording and diagnostics). */
  packet: [IvtpPacket];
  frame: [Buffer];
  blank: [];
  mouseMode: [number];
  keyboardLeds: [number];
  power: [number];
  powerResponse: [number];
  encryption: [boolean];
  shareRequest: [{ user: string; ip: string }];
  shareNotice: [{ code: number; detail: number; user: string; ip: string }];
  /** KVM_SOCKET_STATUS: the other session sharing this console has gone. */
  shareEnded: [];
  activeClients: [string[]];
  videoEngineConfig: [Buffer];
  hwCursor: [Buffer];
  /** The session ended; `expected` is false for drops worth reconnecting. */
  closed: [{ reason: string; expected: boolean; retryable: boolean }];
}

export class KvmSession extends EventEmitter<SessionEvents> {
  state: SessionState = 'idle';
  mouseMode: number = MouseMode.ABSOLUTE;
  encrypted = false;
  readonly hid = new HidPacketizer();
  private socket?: KvmStream;
  private feedbackTimer?: NodeJS.Timeout;
  /** Session id returned by SP-X in VALIDATE response byte 1. */
  sessionId?: number;
  private reader = new IvtpReader();
  private frames = new FrameAssembler();
  private keepAlive?: NodeJS.Timeout;
  private ctx?: HandshakeContext;
  private closing = false;
  /** Why the session is closing (set with `closing`). */
  private closeReason?: { reason: string; expected: boolean };
  private validated = false;
  private handshakeTimer?: NodeJS.Timeout;
  stats = { frames: 0, bytesIn: 0, packets: new Map<number, number>() };

  constructor(private readonly o: SessionOptions) {
    super();
  }

  /** Keyboard report style expected by this firmware (from the profile). */
  get keyboardMode() {
    return this.o.profile.keyboardMode;
  }

  get profileId() {
    return this.o.profile.id;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string) {
    this.o.log?.(level, msg);
  }

  private setState(s: SessionState, detail?: string) {
    this.state = s;
    this.emit('state', s, detail);
  }

  /** Connects and completes the handshake. Resolves once the BMC validates the token. */
  async start(): Promise<void> {
    const { launch } = this.o;
    this.setState('connecting', `${this.o.connectHost}:${launch.kvmPort}${launch.singlePort ? ' (single-port tunnel)' : ''}`);
    const t = this.o.openStream
      ? await this.o.openStream()
      : await openTransport({
        host: this.o.connectHost,
        port: launch.kvmPort,
        secure: launch.kvmSecure,
        tls: this.o.tls,
        tunnel: launch.singlePort ? { webSecurePort: launch.webSecurePort, webCookie: launch.webCookie, service: 'VIDEO' } : undefined,
        log: (m) => this.log('info', m),
      }).then((o) => ({ stream: o.socket as KvmStream, initial: o.initial }));
    if (this.closing || this.state === 'closed') {
      // stop() was called while the connection was being opened.
      t.stream.destroy();
      throw new Error('Session closed.');
    }
    this.socket = t.stream;
    this.ctx = {
      launch,
      username: this.o.username,
      localIp: t.stream.localAddress?.replace(/^::ffff:/, '') ?? '',
      localMac: macFor(t.stream.localAddress),
      reconnectFeature: ((launch.oemFeatures ?? 0) & 32) !== 0,
      ...this.o.extraContext,
    };
    this.setState('handshake', `profile ${this.o.profile.id}`);
    const ready = new Promise<void>((resolve, reject) => {
      this.handshakeTimer = setTimeout(() => reject(new Error('BMC did not complete the KVM handshake in time')), this.o.handshakeTimeoutMs ?? 20000);
      const onState = (s: SessionState) => {
        if (s === 'connected') { cleanup(); resolve(); }
      };
      const onClosed = (c: { reason: string }) => { cleanup(); reject(new Error(c.reason)); };
      const cleanup = () => {
        clearTimeout(this.handshakeTimer);
        this.off('state', onState);
        this.off('closed', onClosed);
      };
      this.on('state', onState);
      this.once('closed', onClosed);
    });
    t.stream.on('data', (d: Buffer) => this.onData(d));
    t.stream.on('error', (e: Error) => this.terminate(`connection error: ${e.message}`, false, true));
    t.stream.on('close', () => this.terminate(
      this.validated ? 'connection closed by BMC' : 'The BMC closed the connection during the handshake (wrong firmware profile, or session not allocated).',
      false, true));
    if (t.initial.length) this.onData(t.initial);
    t.stream.resume?.();
    try {
      await ready;
    } catch (e) {
      this.terminate((e as Error).message, false, false);
      throw e;
    }
  }

  private onData(d: Buffer) {
    // While stopping, incoming data is read and dropped: closing with unread data
    // would reset the connection, and the BMC could lose the STOP sent just before.
    if (this.closing) return;
    this.stats.bytesIn += d.length;
    let packets: IvtpPacket[];
    try {
      packets = this.reader.push(d);
    } catch (e) {
      this.terminate(`protocol error: ${(e as Error).message}`, false, true);
      return;
    }
    for (const p of packets) {
      this.stats.packets.set(p.type, (this.stats.packets.get(p.type) ?? 0) + 1);
      if (this.listenerCount('packet')) this.emit('packet', p);
      try {
        this.dispatch(p);
      } catch (e) {
        this.log('warn', `error handling ${OP_NAMES[p.type] ?? p.type}: ${(e as Error).message}`);
      }
    }
  }

  private send(buf: Buffer) {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(buf);
    return true;
  }

  private dispatch(p: IvtpPacket) {
    if (p.type !== Op.VIDEO_FRAGMENT) this.log('debug', `rx ${OP_NAMES[p.type] ?? `type ${p.type}`} size=${p.size} status=${p.status}`);
    if (this.ctx && this.o.profile.onPacket) for (const pkt of this.o.profile.onPacket(p.type, p.status, this.ctx)) this.send(pkt);
    switch (p.type) {
      case Op.KEEP_ALIVE:
        // SP-X and newer SP firmware send KEEP_ALIVE and expect it echoed; harmless elsewhere.
        this.send(encodeHeader(Op.KEEP_ALIVE, 0, p.status));
        break;
      case Op.CONNECTION_FAILED:
        this.terminate('The BMC reported that the KVM connection failed.', false, false);
        break;
      case Op.VIDEO_FRAGMENT: {
        const f = this.frames.push(p.body);
        if (f) {
          this.stats.frames++;
          this.emit('frame', f);
        }
        break;
      }
      case Op.SESSION_ACCEPTED: {
        if (this.validated || !this.ctx) break;
        for (const pkt of this.o.profile.onSessionAccepted(this.ctx)) this.send(pkt);
        break;
      }
      case Op.VALIDATE_VIDEO_SESSION_RESPONSE: {
        const result = p.body.length > 0 ? p.body[0] : p.status;
        if (VALIDATE_RESULTS[result] !== undefined) {
          this.terminate(`${VALIDATE_RESULTS[result]} (validate result ${result}, profile ${this.o.profile.id})`, false, false);
          break;
        }
        if (result !== 1) this.log('warn', `unexpected validate result ${result}; continuing`);
        if (p.body.length > 1) this.sessionId = p.body[1];
        if (this.validated) break;
        this.validated = true;
        for (const pkt of this.o.profile.onValidated(this.ctx!)) this.send(pkt);
        const ka = this.o.profile.keepAlive;
        if (ka) this.keepAlive = setInterval(() => this.send(ka.packet()), ka.intervalMs);
        if (this.o.profile.videoFeedbackMs) {
          // SP-X expects FPS_DIFF feedback even when the difference is zero (hitsc).
          this.feedbackTimer = setInterval(() => this.send(encodeHeader(Op.FPS_DIFF, 0, 0)), this.o.profile.videoFeedbackMs);
        }
        this.setState('connected');
        break;
      }
      case Op.STOP_SESSION_IMMEDIATE:
        this.terminate(STOP_REASONS[p.status] ?? `The BMC stopped the session (reason ${p.status}).`, false, RETRYABLE_STOPS.has(p.status));
        break;
      case Op.MAX_SESSION_CLOSING:
        this.terminate(p.status === 1
          ? 'This client already has a KVM session open on the BMC.'
          : 'Maximum number of KVM sessions reached on the BMC. Close other sessions and try again.', false, false);
        break;
      case Op.BLANK_SCREEN:
        this.emit('blank');
        break;
      case Op.GET_USB_MOUSE_MODE:
        if (p.body.length) this.setMouseModeFromBmc(p.body[0]);
        break;
      case Op.MOUSE_MEDIA_INFO:
        if (p.body.length) this.setMouseModeFromBmc(p.body[0]);
        break;
      case Op.GET_KEYBD_LED:
        if (p.body.length) this.emit('keyboardLeds', p.body[0]);
        break;
      case Op.POWER_STATUS:
        this.emit('power', p.status & 0xff);
        break;
      case Op.POWER_CONTROL_RESPONSE:
        this.emit('powerResponse', p.status & 0xff);
        break;
      case Op.INITIAL_ENCRYPTION_STATUS:
        // Keyboard/mouse encryption on, keyed with the session token.
        this.enableEncryption();
        break;
      case Op.ENCRYPTION_STATUS:
        // Informational only: the cipher state is left unchanged.
        this.log('info', 'BMC reported keyboard/mouse encryption status change');
        break;
      case Op.KVM_SHARING: {
        const who = parseUserIp(p.body);
        const code = p.status & 0xff;
        const detail = (p.status >> 8) & 0xff;
        // The "other" user being this computer means a second session from here.
        const sameClient = !!who.ip && who.ip === this.ctx?.localIp;
        const name = who.user || 'The other user';
        if (code === Share.REQUEST) {
          if (!sameClient) this.emit('shareRequest', who);
        } else if (code === Share.WAITING && sameClient) {
          void this.stopWith('Only one KVM session is allowed from the same computer, and another one from this computer is open.');
        } else if (code === Share.ANSWER && detail === ShareAnswer.DENIED) {
          void this.stopWith(`${name} denied access to this KVM session.`);
        } else if (!(code === Share.CANCELLED && sameClient)) {
          this.emit('shareNotice', { code, detail, ...who });
        }
        break;
      }
      case Op.KVM_SOCKET_STATUS:
        this.emit('shareEnded');
        break;
      case Op.GET_ACTIVE_CLIENTS: {
        const users: string[] = [];
        for (let o = 0; o + 127 <= p.body.length; o += 127) {
          const rec = p.body.subarray(o, o + 127);
          const u = cstr(rec.subarray(0, 63));
          const ip = cstr(rec.subarray(64, 127));
          if (u || ip) users.push(`${u} : ${ip}`);
        }
        this.emit('activeClients', users);
        // The BMC expects a full-screen request after the active-client list.
        this.send(encodeHeader(Op.GET_FULL_SCREEN, 0));
        break;
      }
      case Op.SOC_GET_VIDEO_ENGINE_CONFIGS:
        this.emit('videoEngineConfig', p.body);
        break;
      case Op.SOC_HW_CURSOR:
        this.emit('hwCursor', p.body);
        break;
      default:
        break;
    }
  }

  private setMouseModeFromBmc(mode: number) {
    if (mode !== this.mouseMode) {
      this.mouseMode = mode;
      this.log('info', `BMC mouse mode: ${mode === 1 ? 'relative' : mode === 2 ? 'absolute' : mode === 3 ? 'other' : mode}`);
    }
    this.emit('mouseMode', mode);
  }

  private enableEncryption() {
    this.hid.cipher = kmCipher(this.o.launch.kvmToken);
    this.encrypted = true;
    this.emit('encryption', true);
  }

  // --- outgoing --------------------------------------------------------

  sendKeyboard(report: Uint8Array) {
    if (this.state === 'connected') this.send(this.hid.keyboard(report));
  }

  sendMouseAbsolute(buttons: number, x: number, y: number, wheel = 0) {
    if (this.state === 'connected') this.send(this.hid.mouseAbsolute(buttons, x, y, wheel));
  }

  sendMouseRelative(buttons: number, dx: number, dy: number, wheel = 0) {
    if (this.state !== 'connected') return;
    // Large moves are split into ±127 steps.
    do {
      const sx = Math.max(-127, Math.min(127, dx));
      const sy = Math.max(-127, Math.min(127, dy));
      this.send(this.hid.mouseRelative(buttons, sx, sy, wheel));
      dx -= sx;
      dy -= sy;
      wheel = 0;
    } while (dx !== 0 || dy !== 0);
  }

  requestFullScreen() {
    this.send(encodeHeader(Op.GET_FULL_SCREEN, 0));
  }

  /** Pause then resume redirection, which makes the BMC resend the whole screen. */
  refresh() {
    this.send(encodeHeader(Op.PAUSE_REDIRECTION, 0));
    this.send(encodeHeader(Op.RESUME_REDIRECTION, 0));
  }

  requestPowerStatus() {
    this.send(encodeHeader(Op.POWER_STATUS, 0));
  }

  powerControl(action: number) {
    // Soft reset/ACPI shutdown is 4 on 2017-era firmware and 5 on newer firmware.
    const code = action === PowerAction.SOFT_RESET ? this.o.profile.softPowerCode : action;
    this.send(encodeHeader(Op.POWER_CONTROL_REQUEST, 0, code));
  }

  setMouseMode(mode: number) {
    this.send(encodeHeader(Op.SET_MOUSE_MODE, 0, mode));
  }

  requestKeyboardLeds() {
    this.send(encodeHeader(Op.GET_KEYBD_LED, 0));
  }

  /** Reply to another user's KVM access request: 0 allow, 1 deny, 2 view-only. */
  answerShareRequest(decision: 0 | 1 | 2) {
    this.send(encodeHeader(Op.KVM_SHARING, 0, 1 | (decision << 8)));
  }

  setEncryption(on: boolean) {
    if (on) {
      this.send(encodeHeader(Op.ENABLE_ENCRYPTION, 0));
      this.enableEncryption();
    } else {
      this.send(encodeHeader(Op.DISABLE_ENCRYPTION, 0));
      this.hid.cipher = null;
      this.encrypted = false;
      this.emit('encryption', false);
    }
  }

  /**
   * Sends STOP_SESSION and closes. The connection is closed gracefully so the STOP is delivered before it ends; the
   * BMC normally closes its side at once, and after a second it is cut anyway.
   * Before the session is validated, the connection is simply closed.
   */
  stop(): Promise<void> {
    return this.close({ reason: 'Session closed.', expected: true });
  }

  /** Ends the session for a reason the user must see, without reconnecting. */
  private stopWith(reason: string): Promise<void> {
    this.log('warn', reason);
    return this.close({ reason, expected: false });
  }

  private async close(why: { reason: string; expected: boolean }) {
    if (this.state === 'closed') return;
    if (!this.closing) {
      this.closing = true;
      this.closeReason = why;
    }
    const s = this.socket;
    if (this.state === 'connected' && s && !s.destroyed) {
      const closed = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        s.on('close', () => { clearTimeout(t); resolve(); });
      });
      this.send(encodePacket(Op.STOP_SESSION_IMMEDIATE));
      s.end?.();
      await closed;
    }
    this.terminate(why.reason, why.expected, false);
  }

  private terminate(reason: string, expected: boolean, retryable: boolean) {
    if (this.state === 'closed') return;
    // Once closing, the end is ours, whatever closed the connection first.
    if (this.closeReason) ({ reason, expected } = this.closeReason);
    clearInterval(this.keepAlive);
    clearInterval(this.feedbackTimer);
    clearTimeout(this.handshakeTimer);
    this.socket?.destroy();
    this.setState('closed', reason);
    this.emit('closed', { reason, expected, retryable: retryable && !this.closing && this.validated });
  }
}

function cstr(b: Buffer): string {
  const z = b.indexOf(0);
  return (z >= 0 ? b.subarray(0, z) : b).toString('latin1').trim();
}

/** KVM_SHARING bodies: username in [0,63), IP in [64,127). */
function parseUserIp(b: Buffer): { user: string; ip: string } {
  return { user: cstr(b.subarray(0, Math.min(63, b.length))), ip: b.length > 64 ? cstr(b.subarray(64, Math.min(127, b.length))) : '' };
}

function macFor(localAddress?: string): string {
  const addr = localAddress?.replace(/^::ffff:/, '');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.address === addr && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac.replace(/:/g, '-');
    }
  }
  return '';
}
