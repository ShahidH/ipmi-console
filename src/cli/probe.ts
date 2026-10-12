/**
 * Headless connectivity probe for real hardware.
 *
 *   BMC_PASSWORD=... node dist/cli/probe.js --host 192.168.1.50 --user admin [options]
 *
 * Logs in, fingerprints the BMC's client jar, opens the KVM session, captures video
 * frames to captures/<host>-<time>/ (raw frames + PNG of the decoded screen) and
 * writes a sanitised report. Nothing secret is written to disk or stdout.
 *
 * Options: --frames N (default 30)  --seconds S (default 20)  --https  --port P
 *          --profile ID  --family auto|megarac-sp|megarac-spx  --legacy-tls
 *          --wake  (tap Shift + nudge the mouse to wake a sleeping display; no side effects)
 *          --record  (save the BMC→client packet stream, sanitised, as session.ivtprec.json for replay)  --trust-fingerprint SHA256  --type TEXT  --debug
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { KvmClient } from '../protocol/client';
import { chordReports, USAGE } from '../protocol/keymap';
import { AspeedDecoder, parseVideoHeader } from '../video/decoder';
import { Recorder } from '../sim/recording';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function png(rgba: Uint8ClampedArray, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const host = arg('host');
  const user = arg('user');
  const password = process.env.BMC_PASSWORD;
  if (!host || !user || !password) {
    console.error('usage: BMC_PASSWORD=... node dist/cli/probe.js --host <bmc> --user <name> [--frames N] [--seconds S] [--https] [--port P] [--profile ID]');
    process.exit(2);
  }
  const maxFrames = Number(arg('frames', '30'));
  const seconds = Number(arg('seconds', '20'));
  const dir = join('captures', `${host.replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(join(dir, 'frames'), { recursive: true });
  const logLines: string[] = [];
  const log = (level: string, msg: string) => {
    if (level === 'debug' && !flag('debug')) return;
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
    logLines.push(line);
    console.log(line);
  };
  const client = new KvmClient({
    host, username: user, password,
    webScheme: flag('https') ? 'https' : 'http',
    webPort: arg('port') ? Number(arg('port')) : undefined,
    profile: arg('profile'),
    family: (arg('family') as never) ?? 'auto',
    tls: { legacyProtocols: flag('legacy-tls'), pinnedFingerprint: arg('trust-fingerprint') },
    autoReconnect: false,
  }, log);
  client.on('status', (s) => log('info', `status: ${s.phase}${s.detail ? ` — ${s.detail}` : ''}`));
  // Ctrl+C must not leave the KVM session open on the BMC: close it first (a second Ctrl+C forces).
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log('warn', 'interrupted: closing the KVM session (Ctrl+C again to force)');
    void client.disconnect().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // Only BMC→client packets are recorded; user records are blanked (see src/sim/recording.ts).
  const recorder = flag('record') ? new Recorder() : null;
  if (recorder) client.on('session', (s) => s.on('packet', (p) => recorder.add(p)));

  const report: Record<string, unknown> = { host, startedAt: new Date().toISOString() };
  const decoder = new AspeedDecoder();
  let frames = 0;
  const headers: unknown[] = [];
  const decodeWarnings = new Set<string>();
  let lastSize = { w: 0, h: 0 };
  const tStart = Date.now();
  try {
    const session = await client.connect();
    report.timing = { connectMs: Date.now() - tStart } as Record<string, number>;
    report.connected = true;
    report.family = client.family;
    report.profile = session.profileId;
    report.launch = { singlePort: client.launch?.singlePort, kvmSecure: client.launch?.kvmSecure, kvmPort: client.launch?.kvmPort, oemFeatures: client.launch?.oemFeatures };
    report.fingerprint = client.jviewerFingerprint;
    const done = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, seconds * 1000);
      let decodeMs = 0;
      session.on('frame', (f) => {
        frames++;
        if (frames === 1) (report.timing as Record<string, number>).firstFrameMs = Date.now() - tStart;
        writeFileSync(join(dir, 'frames', `frame-${String(frames).padStart(4, '0')}.bin`), f);
        try {
          const h = parseVideoHeader(f);
          if (headers.length < 5) headers.push(h);
          const td = performance.now();
          const r = decoder.decode(f);
          decodeMs += performance.now() - td;
          (report.timing as Record<string, number>).avgDecodeMs = Math.round((decodeMs / frames) * 100) / 100;
          if (r.warning) decodeWarnings.add(r.warning);
          lastSize = { w: r.width, h: r.height };
        } catch (e) {
          decodeWarnings.add((e as Error).message);
        }
        if (frames >= maxFrames) { clearTimeout(t); resolve(); }
      });
      let blanks = 0;
      session.on('blank', () => {
        blanks++;
        report.blankScreens = blanks;
        if (blanks === 1 || blanks % 10 === 0) log('info', `BMC reports blank screen / no signal (${blanks}x)`);
      });
      session.on('mouseMode', (m) => (report.mouseMode = m));
      session.on('power', (p) => (report.hostPower = p));
      session.on('encryption', (e) => (report.kmEncryption = e));
      session.on('closed', (c) => { report.closedReason = c.reason; clearTimeout(t); resolve(); });
    });
    if (flag('wake')) {
      // A sleeping console (DPMS) makes the BMC report "no signal". Shift and a
      // tiny mouse movement wake it without typing anything.
      const wake = (n: number) => {
        if (n <= 0 || session.state !== 'connected') return;
        for (const r of chordReports(['ShiftLeft'], session.keyboardMode)) session.sendKeyboard(r);
        session.sendMouseAbsolute(0, 16384 + n * 64, 16384);
        session.sendMouseAbsolute(0, 16384, 16384);
        session.requestFullScreen();
        log('info', 'wake: Shift tap + mouse nudge + full-screen request');
        setTimeout(() => wake(n - 1), 3000);
      };
      setTimeout(() => wake(4), 1500);
    }
    const text = arg('type');
    if (text) {
      // Optional input test: types ASCII letters/digits into the host.
      setTimeout(() => {
        for (const ch of text) {
          const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : ch === ' ' ? 'Space' : null;
          if (code && USAGE[code] !== undefined) for (const r of chordReports([code], session.keyboardMode)) session.sendKeyboard(r);
        }
        log('info', `typed ${text.length} characters`);
      }, 3000);
    }
    await done;
    report.stats = { frames, bytesIn: session.stats.bytesIn, packetTypes: Object.fromEntries(session.stats.packets) };
  } catch (e) {
    report.connected = false;
    report.error = (e as Error).message;
    log('error', (e as Error).message);
  } finally {
    await client.disconnect();
  }
  report.videoHeaders = headers;
  report.decodeWarnings = [...decodeWarnings];
  if (lastSize.w > 0) {
    writeFileSync(join(dir, 'screen.png'), png(decoder.rgba, lastSize.w, lastSize.h));
    report.screenshot = 'screen.png';
  }
  if (recorder) {
    recorder.save(join(dir, 'session.ivtprec.json'), `probe of ${host}, ${frames} frames`);
    report.recording = `session.ivtprec.json (${recorder.packets.length} packets)`;
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, 'probe.log'), logLines.join('\n') + '\n');
  console.log(`\nwrote ${dir}/ (report.json, probe.log, ${frames} frames${lastSize.w ? ', screen.png' : ''})`);
  process.exit(report.connected ? 0 : 1);
}

void main();
