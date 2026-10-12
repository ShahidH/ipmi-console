/**
 * The live KVM session as the app sees it: owns the KvmClient, translates UI
 * input (DOM key codes, normalised pointer positions) into HID reports, and
 * forwards session events to the renderer. Free of Electron imports, so it is
 * tested directly against the simulated BMC (tests/main/kvm-controller.test.ts).
 */
import { isRelativeMouse, type ChordName, type ConnectResult, type EventChannel, type EventMap, type KvmAccess, type MouseInput, type PowerActionName, type PowerResult, type ShareRequest, type TypeResult, type TypingLayoutChoice } from '../shared/api';
import { KvmClient, type ConnectParams, type Logger } from '../protocol/client';
import { toAbsolute } from '../protocol/hid';
import type { JViewerFingerprint } from '../protocol/jarprobe';
import { CHORDS, chordReports, KeyboardState, MODIFIER_BITS, USAGE, type KeyboardMode } from '../protocol/keymap';
import { isTypingLayout, layoutKeys, strokeCodes, type TypingLayout } from '../protocol/layouts';
import { PowerAction, Share, ShareAnswer, type KvmSession } from '../protocol/session';
import { friendlyError } from './errors';
import type { ServerEntry } from './store';

/** What the controller needs from persistent settings (src/main/store.ts). */
export interface ControllerStore {
  getServer(id: string): ServerEntry | undefined;
  storedPassword(s: ServerEntry): Promise<string | undefined> | string | undefined;
  getPin(host: string): string | undefined;
  fingerprintCache(): Map<string, JViewerFingerprint>;
  touchServer(id: string, family: string | undefined): void;
  upsertServer(s: ServerEntry): Promise<string> | string;
}

export interface ControllerDeps {
  /** Pushes an event to the renderer. */
  send: <K extends EventChannel>(channel: K, ...args: EventMap[K]) => void;
  log: Logger;
  store: ControllerStore;
  /** Pause between HID reports of a chord or typed text (ms → promise). */
  sleep?: (ms: number) => Promise<void>;
}

const POWER: Record<PowerActionName, number> = {
  off: PowerAction.OFF, on: PowerAction.ON, cycle: PowerAction.CYCLE, reset: PowerAction.HARD_RESET, soft: PowerAction.SOFT_RESET,
};

/** Keyboard LED bits (GET_KEYBD_LED). */
const CAPS_LOCK = 0x02;

const who = (r: ShareRequest) => `${r.user || 'Another user'}${r.ip ? ` (${r.ip})` : ''}`;

function parseKeyboardMode(v: unknown): KeyboardMode | null {
  return v === 'state' || v === 'autobreak' || v === 'single' ? v : null;
}

export class KvmController {
  private client: KvmClient | null = null;
  private kvm: KvmSession | null = null;
  private keyboard = new KeyboardState();
  /** User override of the keyboard report style; null = the firmware profile's. */
  private keyboardOverride: KeyboardMode | null = null;
  private serverId: string | null = null;
  /** Host keyboard layout assumed when typing text. */
  private typingLayout: TypingLayout = 'us';
  private frameSize = { w: 0, h: 0 };
  private buttons = 0;
  private lastAbs = { x: 0, y: 0 };
  private readonly sleep: (ms: number) => Promise<void>;
  /** The Type clipboard run in progress; set `cancelled` to stop it. */
  private typing: { cancelled: boolean } | null = null;
  /** Keyboard, mouse and power only go to the server with full access (see KvmInfo.access). */
  private access: KvmAccess = 'full';
  /** Another user's request waiting for our answer. */
  private shareAsked: ShareRequest | null = null;
  /** Last keyboard LED state reported by the BMC, and requests not answered yet. */
  private leds = 0;
  private ledRequests = 0;

  constructor(private readonly d: ControllerDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get live(): boolean {
    return this.kvm !== null;
  }

  /** Input may go to the server: a live session with full access. */
  get canControl(): boolean {
    return this.kvm !== null && this.access === 'full';
  }

  /** A connection exists (live, connecting or waiting to reconnect) that must be closed before exiting. */
  get active(): boolean {
    return this.client !== null;
  }

  get keyboardMode(): KeyboardMode {
    return this.keyboard.mode;
  }

  // --- connection ------------------------------------------------------------

  async connect(serverId: string, password?: string): Promise<ConnectResult> {
    const s = this.d.store.getServer(serverId);
    if (!s) return { error: 'Unknown server.' };
    const pw = password ?? (await this.d.store.storedPassword(s));
    if (!pw) return { error: 'Password required.', kind: 'password' };
    this.serverId = s.id;
    this.keyboardOverride = parseKeyboardMode(s.keyboardMode);
    this.typingLayout = isTypingLayout(s.typingLayout) ? s.typingLayout : 'us';
    const params: ConnectParams = {
      host: s.host,
      webScheme: s.webScheme,
      webPort: s.webPort,
      username: s.username,
      password: pw,
      profile: s.profile,
      family: (s.family as ConnectParams['family']) ?? 'auto',
      tls: { pinnedFingerprint: this.d.store.getPin(s.host), legacyProtocols: s.legacyTls },
      fingerprintCache: this.d.store.fingerprintCache(),
    };
    const client = await this.newClient(params);
    try {
      this.d.log('info', `connecting to ${s.host} as ${s.username}`);
      await client.connect();
      this.d.log('info', `connected: family ${client.family}, profile ${client.session?.profileId}`);
      this.d.store.touchServer(s.id, client.family);
      return { ok: true, family: client.family };
    } catch (e) {
      this.d.log('error', `connect failed: ${(e as Error).message}`);
      if (this.client === client) this.client = null;
      return friendlyError(e);
    }
  }

  /** Starts a session from a JViewer launch file (no saved server). */
  async connectJnlp(xml: string): Promise<ConnectResult> {
    this.serverId = null;
    this.keyboardOverride = null;
    this.typingLayout = 'us';
    const client = await this.newClient({ host: '', username: '', password: '', fingerprintCache: this.d.store.fingerprintCache() });
    try {
      await client.connectWithJnlp(xml);
      return { ok: true, family: client.family };
    } catch (e) {
      this.d.log('error', `launch file connect failed: ${(e as Error).message}`);
      if (this.client === client) this.client = null;
      return friendlyError(e);
    }
  }

  async disconnect(): Promise<void> {
    this.cancelTyping();
    const c = this.client;
    this.client = null;
    this.kvm = null;
    await c?.disconnect();
  }

  /** Skips the back-off wait of a pending reconnect. */
  retryNow(): boolean {
    return this.client?.retryNow() ?? false;
  }

  private async newClient(params: ConnectParams): Promise<KvmClient> {
    await this.disconnect();
    const client = new KvmClient(params, this.d.log);
    this.client = client;
    client.on('status', (st) => this.d.send('kvm:status', st));
    // A session from a client that was disconnected meanwhile is stopped by that client.
    client.on('session', (s) => { if (this.client === client) this.attach(s); });
    client.on('ended', (e) => {
      if (this.client !== client) return;
      this.kvm = null;
      this.d.send('kvm:ended', e);
      this.d.log(e.willReconnect ? 'warn' : 'info', `session ended: ${e.reason}${e.willReconnect ? ' (reconnecting)' : ''}`);
    });
    return client;
  }

  private attach(s: KvmSession) {
    const { send, log } = this.d;
    this.kvm = s;
    this.access = 'full';
    this.shareAsked = null;
    this.leds = 0;
    this.ledRequests = 0;
    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => { timers.delete(t); if (s.state === 'connected') fn(); }, ms);
      timers.add(t);
    };
    s.once('closed', () => {
      timers.forEach(clearTimeout);
      clearInterval(blankPoll);
      send('kvm:shareRequest', null);
    });
    s.on('state', (st) => {
      // The server's lock keys: shown in the status bar and needed to type text correctly.
      if (st === 'connected') this.askLeds(s);
    });
    // Video diagnostics and automatic wake on "no signal" (bounded, so a host that is
    // genuinely off or uses another GPU is not spammed).
    let frames = 0;
    let blanks = 0;
    let autoWakes = 0;
    let lastReport = Date.now();
    let firstFrame = true;
    // While there is no signal, the power state is polled every 30 s so a server
    // turned off or on elsewhere shows correctly.
    let blankPoll: NodeJS.Timeout | undefined;
    s.on('frame', (f) => {
      frames++;
      if (firstFrame) {
        firstFrame = false;
        log('info', 'first video frame received');
      }
      if (blankPoll) {
        clearInterval(blankPoll);
        blankPoll = undefined;
        s.requestPowerStatus();
      }
      send('kvm:frame', new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
    });
    s.on('blank', () => {
      if (!blankPoll) {
        s.requestPowerStatus();
        blankPoll = setInterval(() => s.requestPowerStatus(), 30000);
      }
      if (++blanks === 1) log('info', 'BMC reports no signal from the host display (asleep, off, or using another GPU)');
      if (autoWakes < 3 && (blanks === 1 || blanks % 5 === 0)) {
        autoWakes++;
        this.wakeDisplay(s, `auto ${autoWakes}/3`);
      }
      send('kvm:blank');
    });
    const diag = setInterval(() => {
      if (s.state !== 'connected') return clearInterval(diag);
      const secs = Math.round((Date.now() - lastReport) / 1000);
      log('info', `video: ${frames} frames, ${blanks} no-signal reports in the last ${secs}s`);
      frames = 0;
      blanks = 0;
      lastReport = Date.now();
    }, 30000);
    s.once('closed', () => clearInterval(diag));
    this.keyboard = new KeyboardState(this.keyboardOverride ?? s.keyboardMode);
    log('info', `keyboard reports: ${this.keyboard.mode}${this.keyboardOverride ? ' (user override)' : ` (profile ${s.profileId})`}`);
    this.announceKeyboard();
    let mouseMode = s.mouseMode;
    let mouseModeKnown = false;
    s.on('mouseMode', (m) => {
      // A change after the first report (the BMC's own setting changed mid-session) is announced.
      if (mouseModeKnown && isRelativeMouse(m) !== isRelativeMouse(mouseMode)) {
        send('kvm:notice', isRelativeMouse(m)
          ? { title: 'The BMC switched the mouse to relative mode.', detail: 'Click the screen to use the mouse; Esc releases it.' }
          : { title: 'The BMC switched the mouse to absolute mode.' });
      }
      mouseModeKnown = true;
      mouseMode = m;
      send('kvm:info', { mouseMode: m });
    });
    s.on('power', (p) => send('kvm:info', { power: p }));
    // Registered before any serverLeds() listener, so the count is current when that runs.
    s.on('keyboardLeds', (l) => {
      this.ledRequests = Math.max(0, this.ledRequests - 1);
      this.leds = l;
      send('kvm:info', { leds: l });
    });
    s.on('encryption', (on) => send('kvm:info', { encrypted: on }));
    s.on('activeClients', (u) => send('kvm:info', { users: u }));
    s.on('shareRequest', (r) => {
      this.shareAsked = r;
      send('kvm:shareRequest', r);
    });
    s.on('shareNotice', (n) => this.onShareNotice(n.code, n.detail, n));
    s.on('shareEnded', () => {
      log('info', 'KVM sharing: the other session has ended');
      const was = this.access;
      this.setAccess('full', '');
      if (was !== 'full') send('kvm:notice', { title: 'You now have full control of the server.', detail: 'The other session on this console has ended.' });
    });
    s.on('powerResponse', (r) => log(r === 0 ? 'info' : 'warn', `power control response: ${r === 0 ? 'done' : `refused (${r})`}`));
    send('kvm:info', { mouseMode: s.mouseMode, encrypted: s.encrypted, access: 'full', sharedWith: '' });
    this.powerWatch = (action) => {
      // The power state changes some time after the command: check it again later.
      if (action === 'off' || action === 'soft') {
        // Until the server is off: an OS shutdown can take a while.
        let n = 0;
        const poll = () => later(2000, () => {
          s.requestPowerStatus();
          if (++n < 90) s.once('power', (p) => { if (p !== 0) poll(); });
        });
        poll();
      } else {
        later(2000, () => s.requestPowerStatus());
        later(10000, () => s.requestPowerStatus());
      }
    };
  }

  /** Re-checks the power state after a power command (set per session in attach). */
  private powerWatch: (action: PowerActionName) => void = () => {};

  private setAccess(access: KvmAccess, sharedWith?: string) {
    if (access !== 'full') this.releaseKeys();
    this.access = access;
    this.d.send('kvm:info', sharedWith === undefined ? { access } : { access, sharedWith });
  }

  /** KVM sharing messages other than a request to us (see Share in protocol/session.ts). */
  private onShareNotice(code: number, detail: number, r: ShareRequest) {
    const { send, log } = this.d;
    log('info', `KVM sharing: code ${code}, answer ${detail}, other user ${who(r)}`);
    switch (code) {
      case Share.CANCELLED:
        // The other user gave up asking.
        this.shareAsked = null;
        send('kvm:shareRequest', null);
        return;
      case Share.WAITING:
        this.setAccess('waiting', who(r));
        return;
      case Share.TIMED_OUT:
        // We did not answer in time: the BMC gave them full access.
        this.shareAsked = null;
        send('kvm:shareRequest', null);
        send('kvm:info', { sharedWith: who(r) });
        send('kvm:notice', { title: `${who(r)} now shares this console with full control.`, detail: 'Their request was not answered in time.' });
        return;
      case Share.ANSWER:
        if (detail === ShareAnswer.VIEW_ONLY) {
          this.setAccess('view-only', who(r));
          send('kvm:notice', { title: `${r.user || 'The other user'} allowed view only.`, detail: 'You can watch the screen and copy text, but keyboard, mouse and power are off.' });
        } else {
          this.setAccess('full', who(r));
          send('kvm:notice', detail === ShareAnswer.FULL_BY_TIMEOUT
            ? { title: 'You have full control.', detail: `${r.user || 'The other user'} did not answer the access request in time.` }
            : { title: `${r.user || 'The other user'} allowed full access.`, detail: 'You both control this console.' });
        }
        return;
      default:
        return;
    }
  }

  private announceKeyboard() {
    this.d.send('kvm:info', { keyboardMode: this.keyboard.mode, keyboardModeAuto: this.keyboardOverride === null, typingLayout: this.typingLayout });
  }

  // --- input -----------------------------------------------------------------

  /** A physical key (DOM KeyboardEvent.code) went down or up. Unknown codes are ignored. */
  key(code: string, down: boolean) {
    if (!this.kvm || !this.canControl || (USAGE[code] === undefined && MODIFIER_BITS[code] === undefined)) return;
    const r = this.keyboard.handle(code, down);
    if (r) this.kvm.sendKeyboard(r);
  }

  releaseKeys() {
    const r = this.keyboard.releaseAll();
    if (r && this.kvm) this.kvm.sendKeyboard(r);
  }

  /** Size of the decoded video, needed to map normalised pointer positions. */
  setFrameSize(w: number, h: number) {
    if (w > 0 && h > 0 && w < 10000 && h < 10000) this.frameSize = { w, h };
  }

  /** Absolute input is x/y in 0..1 of the screen; relative input is dx/dy in pixels. */
  mouse(m: MouseInput) {
    const kvm = this.kvm;
    if (!kvm || !this.canControl) return;
    if (typeof m.buttons === 'number') this.buttons = m.buttons & 7;
    const wheel = typeof m.wheel === 'number' ? Math.max(-1, Math.min(1, Math.round(m.wheel))) : 0;
    if (isRelativeMouse(kvm.mouseMode)) {
      kvm.sendMouseRelative(this.buttons, Math.round(Number(m.dx) || 0), Math.round(Number(m.dy) || 0), wheel);
      return;
    }
    const { w, h } = this.frameSize;
    if (typeof m.x === 'number' && typeof m.y === 'number' && w > 0) {
      const px = Math.max(0, Math.min(w - 1, m.x * w));
      const py = Math.max(0, Math.min(h - 1, m.y * h));
      this.lastAbs = { x: toAbsolute(px, w), y: toAbsolute(py, h) };
    }
    kvm.sendMouseAbsolute(this.buttons, this.lastAbs.x, this.lastAbs.y, wheel);
  }

  async chord(name: ChordName) {
    const codes = CHORDS[name];
    if (!codes) return;
    for (const r of chordReports(codes, this.keyboard.mode)) {
      if (!this.kvm || !this.canControl) return;
      this.kvm.sendKeyboard(r);
      await this.sleep(30);
    }
  }

  /**
   * Types text as physical key presses for the host's layout (the BMC only
   * sees keys, so the host's layout setting must match). Returns characters skipped.
   */
  async typeText(text: string): Promise<TypeResult> {
    const chars = [...text.replace(/\r\n?/g, '\n')];
    const result: TypeResult = { typed: 0, skipped: 0, cancelled: false };
    if (!this.kvm || !this.canControl) return { ...result, cancelled: true };
    // One run at a time; a new one replaces the old.
    if (this.typing) this.typing.cancelled = true;
    const run = { cancelled: false };
    this.typing = run;
    // Keys still held (e.g. Ctrl+Alt from the paste shortcut) would turn text into shortcuts.
    this.releaseKeys();
    // Caps Lock on the server would swap the case of every letter: off while typing, then back on.
    const session = this.kvm;
    const caps = (await this.serverLeds(session)) & CAPS_LOCK;
    const tapCapsLock = async () => {
      for (const r of chordReports(['CapsLock'], this.keyboard.mode)) {
        session.sendKeyboard(r);
        await this.sleep(12);
      }
    };
    if (caps) await tapCapsLock();
    let lastProgress = 0;
    try {
      for (let i = 0; i < chars.length; i++) {
        const strokes = layoutKeys(chars[i], this.typingLayout);
        if (!strokes) {
          result.skipped++;
          continue;
        }
        // Usually one stroke; two for a dead key (accent, then the letter or Space).
        for (const k of strokes) {
          for (const r of chordReports(strokeCodes(k), this.keyboard.mode)) {
            if (run.cancelled || !this.kvm) return { ...result, cancelled: true };
            this.kvm.sendKeyboard(r);
            await this.sleep(12);
          }
        }
        result.typed++;
        if (Date.now() - lastProgress > 200) {
          lastProgress = Date.now();
          this.d.send('kvm:typing', { done: i + 1, total: chars.length });
        }
      }
      return result;
    } finally {
      if (caps && this.kvm === session) await tapCapsLock();
      if (this.typing === run) this.typing = null;
      this.d.send('kvm:typing', { done: chars.length, total: chars.length });
    }
  }

  /** The server's keyboard LEDs, asked afresh (the last known state if the BMC does not answer quickly). */
  private serverLeds(s: KvmSession): Promise<number> {
    return new Promise((resolve) => {
      // Replies to earlier requests may still be on their way: wait for the last one.
      const done = (l: number) => {
        if (this.ledRequests > 0) return;
        clearTimeout(t);
        s.off('keyboardLeds', done);
        resolve(l);
      };
      const t = setTimeout(() => { s.off('keyboardLeds', done); resolve(this.leds); }, 400);
      s.on('keyboardLeds', done);
      this.askLeds(s);
    });
  }

  private askLeds(s: KvmSession) {
    this.ledRequests++;
    s.requestKeyboardLeds();
  }

  /** Asks the BMC for the keyboard LEDs (called when the window gets focus). */
  syncLeds() {
    if (this.kvm?.state === 'connected') this.askLeds(this.kvm);
  }

  cancelTyping() {
    if (this.typing) this.typing.cancelled = true;
  }

  setTypingLayout(layout: TypingLayoutChoice) {
    this.typingLayout = layout;
    const srv = this.serverId ? this.d.store.getServer(this.serverId) : undefined;
    if (srv) this.persist({ ...srv, typingLayout: layout });
    this.announceKeyboard();
  }

  private persist(s: ServerEntry) {
    Promise.resolve(this.d.store.upsertServer(s)).catch((e) => this.d.log('warn', `could not save server settings: ${(e as Error).message}`));
  }

  // --- session commands --------------------------------------------------------

  /** Sends a power command and waits up to 10 s for the BMC to accept or refuse it. */
  async power(action: PowerActionName): Promise<PowerResult> {
    const s = this.kvm;
    if (!s || !this.canControl) return 'not-allowed';
    this.d.log('info', `power control: ${action}`);
    const response = new Promise<number | null>((resolve) => {
      const done = (r: number | null) => { clearTimeout(t); s.off('powerResponse', done); s.off('closed', gone); resolve(r); };
      const gone = () => done(null);
      const t = setTimeout(gone, 10000);
      s.on('powerResponse', done);
      s.once('closed', gone);
    });
    s.powerControl(POWER[action]);
    const r = await response;
    if (r !== 0) return r === null ? 'no-answer' : 'refused';
    this.powerWatch(action);
    return 'done';
  }

  refresh() {
    this.kvm?.refresh();
  }

  wake() {
    if (this.kvm && this.canControl) this.wakeDisplay(this.kvm, 'button');
  }

  answerShare(decision: 0 | 1 | 2) {
    const asked = this.shareAsked;
    // A late answer (the request was withdrawn or timed out, or the session ended) is dropped.
    if (!asked || !this.kvm) return;
    this.shareAsked = null;
    this.kvm.answerShareRequest(decision);
    if (decision !== 1) this.d.send('kvm:info', { sharedWith: who(asked) });
  }

  /**
   * A sleeping host display makes the BMC report "no signal" (BLANK_SCREEN).
   * A Shift tap and a tiny mouse nudge wake it without typing anything.
   */
  private wakeDisplay(s: KvmSession, reason: string) {
    if (s.state !== 'connected') return;
    for (const r of chordReports(['ShiftLeft'], this.keyboard.mode)) s.sendKeyboard(r);
    if (isRelativeMouse(s.mouseMode)) {
      s.sendMouseRelative(0, 1, 0);
      s.sendMouseRelative(0, -1, 0);
    } else {
      s.sendMouseAbsolute(0, this.lastAbs.x + 64, this.lastAbs.y);
      s.sendMouseAbsolute(0, this.lastAbs.x, this.lastAbs.y);
    }
    s.requestFullScreen();
    this.d.log('info', `wake display (${reason}): Shift tap + mouse nudge`);
  }
}
