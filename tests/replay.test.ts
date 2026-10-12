// Record-and-replay regression tests.
//  1. Record a simulated session, replay it offline through the client's
//     framing/reassembly/decoder, then replay it through the simulator to a
//     live client: both must produce the same pixels.
//  2. Every real recording in captures/ (made with `probe --record`) must
//     replay through the client stack without decode errors.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KvmClient } from '../src/protocol/client';
import { FrameAssembler, IvtpReader, Op } from '../src/protocol/ivtp';
import { findScenario } from '../src/sim/scenario';
import { loadRecording, packetBytes, Recorder, type Recording } from '../src/sim/recording';
import { SimBmc } from '../src/sim/server';
import { AspeedDecoder } from '../src/video/decoder';

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Offline replay: recording → IVTP stream → frames → decoder. */
function replayOffline(rec: Recording) {
  const reader = new IvtpReader();
  const asm = new FrameAssembler();
  const dec = new AspeedDecoder();
  const warnings: string[] = [];
  let frames = 0;
  for (const pkt of reader.push(Buffer.concat(rec.packets.map(packetBytes)))) {
    if (pkt.type !== Op.VIDEO_FRAGMENT) continue;
    const f = asm.push(pkt.body);
    if (!f) continue;
    frames++;
    const r = dec.decode(f);
    if (r.warning) warnings.push(r.warning);
  }
  return { frames, warnings, hash: createHash('sha256').update(dec.rgba).digest('hex') };
}

let bmc: SimBmc | undefined;
let client: KvmClient | undefined;
afterEach(async () => {
  await client?.disconnect().catch(() => {});
  await bmc?.close();
  bmc = client = undefined;
});

describe('record and replay', () => {
  it('a recorded simulated session replays identically offline and through the simulator', async () => {
    // Record.
    bmc = new SimBmc(findScenario('sp-195'));
    await bmc.listen();
    client = new KvmClient({ host: '127.0.0.1', webPort: bmc.webPort, username: 'admin', password: 'admin', autoReconnect: false });
    const rec = new Recorder();
    client.on('session', (s) => s.on('packet', (p) => rec.add(p)));
    await client.connect();
    await until(() => rec.packets.filter((p) => p.type === Op.VIDEO_FRAGMENT).length >= 3);
    await new Promise((r) => setTimeout(r, 1200)); // let the clock tick produce delta frames
    await client.disconnect();
    await bmc.close();
    const file = join(mkdtempSync(join(tmpdir(), 'ojv-rec-')), 'session.ivtprec.json');
    rec.save(file, 'test');
    const recording = loadRecording(file);
    // User records must be blanked.
    const accepted = recording.packets.find((p) => p.type === Op.SESSION_ACCEPTED || p.type === Op.GET_ACTIVE_CLIENTS)!;
    expect(Buffer.from(accepted.body, 'base64').every((b) => b === 0)).toBe(true);

    // Offline replay.
    const offline = replayOffline(recording);
    expect(offline.warnings).toEqual([]);
    expect(offline.frames).toBeGreaterThanOrEqual(3);

    // Replay through the simulator to a live client.
    bmc = new SimBmc({ ...findScenario('sp-195'), video: { replay: file } });
    await bmc.listen();
    client = new KvmClient({ host: '127.0.0.1', webPort: bmc.webPort, username: 'admin', password: 'admin', autoReconnect: false });
    const dec = new AspeedDecoder();
    let live = 0;
    client.on('session', (s) => s.on('frame', (f) => { dec.decode(f); live++; }));
    await client.connect();
    await until(() => live >= offline.frames, 8000);
    expect(createHash('sha256').update(dec.rgba).digest('hex')).toBe(offline.hash);
  }, 20000);
});

const capRoot = join(__dirname, '../captures');
const recordings = existsSync(capRoot)
  ? readdirSync(capRoot).map((d) => join(capRoot, d, 'session.ivtprec.json')).filter((f) => existsSync(f))
  : [];

describe.skipIf(recordings.length === 0)('real recordings (captures/, gitignored)', () => {
  for (const f of recordings) {
    it(`replays ${f.split('/').slice(-2, -1)[0]} without decode errors`, () => {
      const r = replayOffline(loadRecording(f));
      expect(r.warnings).toEqual([]);
      expect(r.frames).toBeGreaterThan(0);
    });
  }
});
