/**
 * BMC side of one IVTP KVM session (shared by every transport). Behaviour is
 * driven by the firmware variant (firmware.ts) and the scenario (scenario.ts).
 * The handshake is enforced strictly so that client regressions show up as a
 * rejected or silently closed session, as they would on real hardware.
 */
import { encodeHeader, encodePacket, IvtpReader, Op, OP_NAMES, type IvtpPacket } from '../protocol/ivtp';
import type { SimFirmware } from './firmware';
import { InputDecoder, modifierNames, type InputEvent } from './input';
import type { Recording } from './recording';
import { packetBytes } from './recording';
import type { Fault, Scenario } from './scenario';
import { COLOR, TextScreen, type Cell, type VideoSource } from './video';

export interface SimStream {
  write(b: Buffer): unknown;
  destroy(): void;
  on(ev: 'data', fn: (d: Buffer) => void): unknown;
  on(ev: 'close', fn: () => void): unknown;
}

export type SimEventKind = 'session' | 'rx' | 'tx' | 'input' | 'fault' | 'warn';
export interface SimEvent { t: number; kind: SimEventKind; msg: string; input?: InputEvent }

export interface SimSessionOptions {
  firmware: SimFirmware;
  scenario: Scenario;
  /** Tokens/cookies the web layer issued; the session must present the latest. */
  token: () => string | undefined;
  webCookie: () => string | undefined;
  username: string;
  video: VideoSource;
  text?: TextScreen;
  recording?: Recording;
  emit: (e: SimEvent) => void;
  /** Called with every packet the client sent (tests inspect these). */
  onPacket?: (p: IvtpPacket) => void;
}

const FRAGMENT = 16 * 1024;

export class SimKvmSession {
  validated = false;
  closed = false;
  private reader = new IvtpReader();
  private sawWebToken = false;
  private sawConnComplete = false;
  private videoOn = false;
  private paused = false;
  private asleep: boolean;
  private power = 1;
  private input: InputDecoder;
  private timers: NodeJS.Timeout[] = [];
  private queue: Promise<void> = Promise.resolve();
  private latency = 0;
  private dropMidFrame = false;
  private corruptNext = false;
  private lastClientKeepAlive = Date.now();
  private started = Date.now();
  private mouseCell: { row: number; col: number; under: Cell } | null = null;
  private eventLines: string[] = [];
  private lastKey = '';
  private mouseLine = '';

  constructor(private readonly s: SimStream, private readonly o: SimSessionOptions) {
    this.asleep = !!o.scenario.displayAsleep;
    this.input = new InputDecoder(o.scenario.encryption ? o.token() : undefined);
    for (const f of o.scenario.faults ?? []) if (f.do === 'latency') this.latency = f.ms;
    s.on('data', (d) => this.onData(d));
    s.on('close', () => this.shutdown('client closed the connection'));
  }

  private log(kind: SimEventKind, msg: string, input?: InputEvent) {
    this.o.emit({ t: Date.now(), kind, msg, input });
  }

  start() {
    this.log('session', `KVM connection opened (${this.o.firmware.id})`);
    this.send(encodePacket(Op.SESSION_ACCEPTED, Buffer.alloc(127)));
  }

  /** Writes in order, optionally delayed (latency fault). */
  private send(b: Buffer) {
    if (this.closed) return;
    if (!this.latency) return void this.s.write(b);
    this.queue = this.queue.then(() => new Promise((r) => setTimeout(() => { if (!this.closed) this.s.write(b); r(); }, this.latency)));
  }

  private onData(d: Buffer) {
    let packets: IvtpPacket[];
    try {
      packets = this.reader.push(d);
    } catch (e) {
      this.log('warn', `unparseable data from client: ${(e as Error).message}`);
      return this.close('protocol error');
    }
    for (const p of packets) {
      this.o.onPacket?.(p);
      if (p.type !== Op.HID_PKT && p.type !== Op.FPS_DIFF) this.log('rx', `${OP_NAMES[p.type] ?? p.type} size=${p.size} status=${p.status}`);
      this.dispatch(p);
    }
  }

  private dispatch(p: IvtpPacket) {
    const fw = this.o.firmware;
    switch (p.type) {
      case Op.GET_WEB_TOKEN:
        if (!this.validated) this.sawWebToken = p.body.toString('latin1').replace(/\0+$/, '') === this.o.webCookie();
        return;
      case Op.CONNECTION_COMPLETE:
        this.sawConnComplete = true;
        return;
      case Op.VALIDATE_VIDEO_SESSION:
        return this.validate(p);
      case Op.RESUME_REDIRECTION:
        if (!this.validated) return;
        this.paused = false;
        return this.startVideo('resume');
      case Op.PAUSE_REDIRECTION:
        this.paused = true;
        return;
      case Op.GET_FULL_SCREEN:
      case Op.REFRESH_VIDEO_SCREEN:
        // In replay mode the recording is the only video source.
        if (this.validated && this.videoOn && !this.asleep && !this.o.recording) this.sendFrame(this.o.video.full());
        return;
      case Op.HID_PKT:
        return this.onHid(p);
      case Op.POWER_STATUS:
        return this.send(encodeHeader(Op.POWER_STATUS, 0, this.power));
      case Op.POWER_CONTROL_REQUEST: {
        const names: Record<number, string> = { 0: 'power off', 1: 'power on', 2: 'power cycle', 3: 'hard reset', [fw.softPowerCode]: 'soft reset (ACPI)' };
        this.log('input', `POWER CONTROL: ${names[p.status] ?? `unknown action ${p.status}`}`);
        if (p.status === 0) this.power = 0;
        if (p.status === 1) this.power = 1;
        if (this.o.scenario.faults?.some((f) => f.do === 'refuse-power')) {
          this.log('fault', 'power command refused');
          return this.send(encodeHeader(Op.POWER_CONTROL_RESPONSE, 0, 1));
        }
        this.addEvent(`power: ${names[p.status] ?? p.status}`);
        this.send(encodeHeader(Op.POWER_CONTROL_RESPONSE, 0, 0));
        return this.send(encodeHeader(Op.POWER_STATUS, 0, this.power));
      }
      case Op.GET_KEYBD_LED:
        return this.send(encodePacket(Op.GET_KEYBD_LED, Buffer.from([this.input.leds])));
      case Op.KEEP_ALIVE:
        this.lastClientKeepAlive = Date.now();
        return;
      case Op.KVM_SHARING: {
        const decision = (p.status >> 8) & 0xff;
        this.log('input', `KVM sharing answer: ${['allow full access', 'deny', 'view only'][decision] ?? decision}`);
        return this.addEvent(`sharing answer: ${['allow', 'deny', 'view only'][decision] ?? decision}`);
      }
      case Op.STOP_SESSION_IMMEDIATE:
        this.log('session', 'client sent STOP_SESSION');
        return this.close('client stop');
      default:
        return;
    }
  }

  private validate(p: IvtpPacket) {
    const fw = this.o.firmware;
    const faults = this.o.scenario.faults ?? [];
    if (faults.some((f) => f.do === 'max-sessions')) {
      this.log('fault', 'replying MAX_SESSION_CLOSING');
      this.send(encodeHeader(Op.MAX_SESSION_CLOSING, 0, 0));
      return setTimeout(() => this.close('max sessions'), 100);
    }
    // A size the firmware does not expect desynchronises a real BMC; it closes silently.
    if (p.size !== fw.validateHeaderSize) {
      this.log('warn', `VALIDATE size ${p.size}, firmware expects ${fw.validateHeaderSize} → silent close`);
      return this.close('validate size mismatch');
    }
    const tok = p.body.subarray(1, 130).toString('latin1').replace(/\0+$/, '');
    let result = 1;
    if (tok !== this.o.token()) result = 0;
    else if (fw.expectsWebToken && !this.sawWebToken) result = 3;
    else if (((fw.oemFeatures ?? 0) & 32) && !this.sawConnComplete) result = 3;
    const forced = faults.find((f): f is Extract<Fault, { do: 'reject-validate' }> => f.do === 'reject-validate');
    if (forced) result = forced.result;
    this.send(encodePacket(Op.VALIDATE_VIDEO_SESSION_RESPONSE, Buffer.from([result, 7])));
    if (result !== 1) {
      this.log('session', `validate rejected with result ${result}`);
      return setTimeout(() => this.close('validate rejected'), 200);
    }
    this.validated = true;
    this.started = Date.now();
    this.log('session', 'session validated');
    if (this.o.scenario.encryption) this.send(encodeHeader(Op.INITIAL_ENCRYPTION_STATUS, 0));
    const mm = Buffer.alloc(33);
    mm[0] = this.o.scenario.mouseMode ?? 2;
    mm.writeInt32LE(1, 17); mm.writeInt32LE(1, 21); mm.writeInt32LE(1, 25); // cd/fd/hd instances
    this.send(encodePacket(Op.MOUSE_MEDIA_INFO, mm));
    const users = Buffer.alloc(127);
    users.write(this.o.username, 0, 'latin1');
    users.write('127.0.0.1', 64, 'latin1');
    this.send(encodePacket(Op.GET_ACTIVE_CLIENTS, users));
    if (fw.sendsMediaLicense) this.send(encodeHeader(Op.MEDIA_LICENSE_STATUS, 0));
    if (fw.sendsKeepAlive) this.every(5000, () => this.send(encodeHeader(Op.KEEP_ALIVE, 0)));
    if (fw.expectsClientKeepAlive) {
      this.every(5000, () => {
        if (Date.now() - this.lastClientKeepAlive > 12000) this.log('warn', 'no KEEP_ALIVE from client for >12 s (this firmware would drop the session)');
      });
    }
    if (!fw.resumeAfterValidate) this.startVideo('validated');
    this.scheduleFaults();
    if (!this.o.recording) {
      this.renderStatic();
      this.every(1000, () => this.tickClock());
    }
  }

  private startVideo(why: string) {
    if (this.videoOn) return this.o.recording ? undefined : void this.sendFrameOrBlank(true);
    this.videoOn = true;
    this.log('session', `video started (${why})`);
    if (this.o.recording) return this.replay();
    this.sendFrameOrBlank(true);
    this.every(Math.round(1000 / (this.o.scenario.fps ?? 10)), () => this.sendFrameOrBlank(false));
  }

  private sendFrameOrBlank(full: boolean) {
    if (this.paused || this.closed) return;
    if (this.asleep) return this.send(encodeHeader(Op.BLANK_SCREEN, 0));
    const f = full ? this.o.video.full() : this.o.video.next();
    if (f) this.sendFrame(f);
  }

  private sendFrame(frame: Uint8Array) {
    let data = Buffer.from(frame);
    if (this.corruptNext && data.length > 120) {
      this.corruptNext = false;
      data = Buffer.from(data);
      for (let i = 90; i < data.length; i += 7) data[i] ^= 0x5a;
      this.log('fault', 'sent a corrupted video frame');
    }
    const n = Math.max(1, Math.ceil(data.length / FRAGMENT));
    for (let i = 0; i < n; i++) {
      const chunk = data.subarray(i * FRAGMENT, (i + 1) * FRAGMENT);
      const body = Buffer.alloc(2 + chunk.length);
      body.writeUInt16LE(i | (i === n - 1 ? 0x8000 : 0), 0);
      chunk.copy(body, 2);
      const pkt = encodePacket(Op.VIDEO_FRAGMENT, body);
      if (this.dropMidFrame) {
        this.log('fault', 'dropping the connection in the middle of a video frame');
        this.send(pkt.subarray(0, Math.floor(pkt.length / 2)));
        return void setTimeout(() => this.close('drop mid-frame'), 50);
      }
      this.send(pkt);
    }
  }

  /** Replays a recorded BMC stream (video and control packets) with its original timing. */
  private replay() {
    const rec = this.o.recording!;
    const skip = new Set<number>([Op.SESSION_ACCEPTED, Op.VALIDATE_VIDEO_SESSION_RESPONSE]);
    const pk = rec.packets.filter((p) => !skip.has(p.type));
    const t0 = pk[0]?.t ?? 0;
    for (const p of pk) this.timers.push(setTimeout(() => this.send(packetBytes(p)), p.t - t0));
    this.log('session', `replaying ${pk.length} recorded packets`);
  }

  private onHid(p: IvtpPacket) {
    for (const ev of this.input.handle(p.body, p.status)) {
      if (ev.kind === 'key') {
        const mods = modifierNames(ev.modifiers);
        this.lastKey = `${ev.down ? 'press' : 'release'} ${ev.name}${ev.char && ev.char !== ' ' ? ` '${ev.char}'` : ''}${mods ? ` with ${mods}` : ''}${ev.autobreak ? ' [auto-break]' : ''}`;
        this.log('input', `key ${this.lastKey}`, ev);
        if (ev.down) this.o.video.key?.(ev.usage);
      } else if (ev.kind === 'mouse') {
        const px = ev.absolute ? Math.round((ev.x * this.o.video.width) / 32767) : ev.x;
        const py = ev.absolute ? Math.round((ev.y * this.o.video.height) / 32767) : ev.y;
        this.mouseLine = ev.absolute ? `absolute ${px},${py} px  buttons=${ev.buttons}  wheel=${ev.wheel}` : `relative dx=${px} dy=${py}  buttons=${ev.buttons}  wheel=${ev.wheel}`;
        if (ev.buttons || ev.wheel) this.log('input', `mouse ${this.mouseLine}`, ev);
        if (ev.absolute) this.moveCursor(px, py);
      } else {
        this.lastKey = `modifiers ${modifierNames(ev.modifiers) || 'none'}`;
      }
    }
    if (this.asleep) {
      this.asleep = false;
      this.log('session', 'display woke up on input');
      this.addEvent('display woke up');
      this.sendFrameOrBlank(true);
    }
    this.renderInput();
  }

  // --- text screen ----------------------------------------------------------

  private renderStatic() {
    const t = this.o.text;
    if (!t) return;
    const sc = this.o.scenario;
    t.clear();
    t.line(0, ` IPMI Console BMC simulator  -  scenario: ${sc.name}`, COLOR.black, COLOR.grey);
    t.line(2, ` Firmware : ${this.o.firmware.description}`.slice(0, 80), COLOR.white);
    t.line(3, ` Transport: ${sc.transport ?? 'websocket'}   KM encryption: ${sc.encryption ? 'on' : 'off'}   Mouse: ${sc.mouseMode === 1 ? 'relative' : 'absolute'}`, COLOR.white);
    t.line(5, ' KEYBOARD TEST - type here (Backspace and Enter work):', COLOR.yellow);
    t.line(12, ' MOUSE TEST - move the pointer; a + marks where the BMC thinks it is:', COLOR.yellow);
    t.line(16, ' Recent events:', COLOR.yellow);
    t.line(59, ' Simulated BMC - not a real server. Close the app session or Ctrl+C the simulator to stop.', COLOR.black, COLOR.grey);
    this.renderInput();
  }

  private renderInput() {
    const t = this.o.text;
    if (!t) return;
    const lines = this.input.typed.split('\n').slice(-4);
    for (let i = 0; i < 4; i++) t.line(6 + i, `  ${(lines[i] ?? '').slice(-76)}${i === lines.length - 1 ? '_' : ''}`, COLOR.white);
    t.line(10, `  last key: ${this.lastKey}`.slice(0, 80), COLOR.cyan);
    t.line(13, `  ${this.mouseLine}`, COLOR.cyan);
  }

  private moveCursor(px: number, py: number) {
    const t = this.o.text;
    if (!t) return;
    const col = Math.min(t.cols - 1, Math.max(0, Math.floor(px / 8)));
    const row = Math.min(t.rows - 2, Math.max(1, Math.floor(py / 8)));
    if (this.mouseCell) t.set(this.mouseCell.row, this.mouseCell.col, this.mouseCell.under);
    this.mouseCell = { row, col, under: t.get(row, col) };
    t.write(row, col, '+', COLOR.red);
  }

  private addEvent(line: string) {
    const ts = new Date().toISOString().slice(11, 19);
    this.eventLines.push(`${ts} ${line}`);
    if (this.eventLines.length > 12) this.eventLines.shift();
    this.renderEvents();
  }

  private renderEvents() {
    const t = this.o.text;
    if (!t) return;
    for (let i = 0; i < 12; i++) t.line(17 + i, `  ${this.eventLines[i] ?? ''}`, COLOR.grey);
  }

  private tickClock() {
    const t = this.o.text;
    if (!t) return;
    const s = Math.floor((Date.now() - this.started) / 1000);
    t.write(0, 64, ` up ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}    `.slice(0, 16), COLOR.black, COLOR.grey);
  }

  // --- faults -----------------------------------------------------------------

  private scheduleFaults() {
    for (const f of this.o.scenario.faults ?? []) {
      if (!('at' in f)) continue;
      this.timers.push(setTimeout(() => this.fire(f), f.at));
    }
  }

  private fire(f: Fault) {
    if (this.closed) return;
    switch (f.do) {
      case 'drop':
        this.log('fault', 'dropping the connection');
        return this.close('fault: drop');
      case 'drop-mid-frame':
        this.dropMidFrame = true;
        return this.sendFrame(this.o.video.full());
      case 'stop':
        this.log('fault', `BMC stops the session (reason ${f.reason})`);
        this.send(encodeHeader(Op.STOP_SESSION_IMMEDIATE, 0, f.reason));
        return void setTimeout(() => this.close('fault: stop'), 200);
      case 'share-request': {
        this.log('fault', `KVM access request from ${f.user} (${f.ip})`);
        const b = Buffer.alloc(127);
        b.write(f.user, 0, 'latin1');
        b.write(f.ip, 64, 'latin1');
        return this.send(encodePacket(Op.KVM_SHARING, b, 1));
      }
      case 'share': {
        this.log('fault', `KVM sharing message ${f.code}/${f.answer ?? 0} about ${f.user} (${f.ip})`);
        const b = Buffer.alloc(127);
        b.write(f.user, 0, 'latin1');
        b.write(f.ip, 64, 'latin1');
        return this.send(encodePacket(Op.KVM_SHARING, b, f.code | ((f.answer ?? 0) << 8)));
      }
      case 'share-ended':
        this.log('fault', 'the other KVM session has ended');
        return this.send(encodeHeader(Op.KVM_SOCKET_STATUS, 0));
      case 'mouse-mode': {
        this.log('fault', `mouse mode changes to ${f.mode}`);
        const mm = Buffer.alloc(33);
        mm[0] = f.mode;
        mm.writeInt32LE(1, 17); mm.writeInt32LE(1, 21); mm.writeInt32LE(1, 25);
        return this.send(encodePacket(Op.MOUSE_MEDIA_INFO, mm));
      }
      case 'corrupt-frame':
        this.corruptNext = true;
        return this.sendFrame(this.o.video.full());
      case 'sleep':
        this.log('fault', 'host display goes to sleep');
        this.asleep = true;
        return;
      default:
        return;
    }
  }

  private every(ms: number, fn: () => void) {
    const t = setInterval(() => (this.closed ? clearInterval(t) : fn()), ms);
    this.timers.push(t);
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.log('session', `KVM connection closed (${reason})`);
    this.s.destroy();
  }

  private shutdown(reason: string) {
    if (!this.closed) this.close(reason);
  }
}
