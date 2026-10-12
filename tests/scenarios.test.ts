// Runs every simulator scenario against the real client stack and checks the
// expected outcome. Successful scenarios also verify video and typed input.
import { afterEach, describe, expect, it } from 'vitest';
import { KvmClient } from '../src/protocol/client';
import { chordReports } from '../src/protocol/keymap';
import type { KvmSession } from '../src/protocol/session';
import { SCENARIOS, findScenario, type Scenario } from '../src/sim/scenario';
import { SimBmc } from '../src/sim/server';
import { AspeedDecoder } from '../src/video/decoder';

const until = async (cond: () => boolean, ms = 4000, what = 'condition') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

let bmc: SimBmc | undefined;
let client: KvmClient | undefined;
afterEach(async () => {
  await client?.disconnect().catch(() => {});
  await bmc?.close();
  bmc = client = undefined;
});

async function start(sc: Scenario, opts: { autoReconnect?: boolean } = {}) {
  bmc = new SimBmc(sc);
  await bmc.listen();
  client = new KvmClient({ host: '127.0.0.1', webPort: bmc.webPort, username: 'admin', password: 'admin', autoReconnect: opts.autoReconnect ?? false, fingerprintCache: new Map() });
  const frames: Buffer[] = [];
  const sessions: KvmSession[] = [];
  client.on('session', (s) => {
    sessions.push(s);
    s.on('frame', (f) => frames.push(f));
  });
  return { frames, sessions };
}

function typeText(s: KvmSession, text: string) {
  const code = (ch: string) => (/[a-z]/.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : 'Space');
  for (const ch of text) for (const r of chordReports([code(ch)], s.keyboardMode)) s.sendKeyboard(r);
}

describe('simulator scenarios', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: ${sc.description}`, async () => {
      const { frames, sessions } = await start(sc, { autoReconnect: !!sc.expect.reconnects });
      if (!sc.expect.connects) {
        await expect(client!.connect()).rejects.toThrow(new RegExp(sc.expect.error ?? '.', 'i'));
        return;
      }
      const s = await client!.connect();
      expect(s.state).toBe('connected');
      if (sc.displayAsleep) {
        await until(() => bmc!.events.some((e) => e.msg.includes('BLANK') || e.kind === 'session'), 2000);
        expect(frames.length).toBe(0);
        typeText(s, ' ');
      }
      await until(() => frames.length > 0, 4000, 'first frame');
      const dec = new AspeedDecoder();
      expect(dec.decode(frames[0]).warning).toBeUndefined();
      if (sc.encryption) await until(() => s.encrypted, 2000, 'encryption');
      typeText(s, 'hello 42');
      const session = bmc!.sessions.at(-1)!;
      await until(() => ((session as unknown as { input: { typed: string } }).input.typed).endsWith('hello 42'), 3000, 'typed text at BMC');
      if (sc.expect.reconnects) {
        await until(() => bmc!.validations >= 2, 10000, 'reconnect');
        expect(sessions.length).toBeGreaterThanOrEqual(2);
      }
      if (sc.faults?.some((f) => f.do === 'share-request')) {
        const req = await new Promise<{ user: string }>((r) => s.once('shareRequest', r));
        expect(req.user).toBe('operator');
        s.answerShareRequest(2);
        await until(() => bmc!.events.some((e) => e.msg.includes('view only')), 2000, 'sharing answer');
      }
      if (sc.faults?.some((f) => f.do === 'stop')) {
        const c = await new Promise<{ reason: string }>((r) => s.once('closed', r));
        expect(c.reason).toMatch(/configuration changed/);
      }
      if (sc.faults?.some((f) => f.do === 'corrupt-frame')) {
        const before = frames.length;
        await until(() => frames.length > before + 5, 10000, 'frames after corruption');
        expect(s.state).toBe('connected');
      }
    }, 20000);
  }
});

describe('simulator details', () => {
  it('the text screen shows what was typed (end-to-end through the decoder)', async () => {
    const { frames } = await start(findScenario('sp-195'));
    const s = await client!.connect();
    await until(() => frames.length > 0);
    typeText(s, 'abc');
    const dec = new AspeedDecoder();
    const n0 = frames.length;
    await until(() => frames.length > n0 + 3, 3000, 'screen update');
    for (const f of frames) dec.decode(f);
    // Row 6 (y=48..55) starts with "  abc": the 'a' cell at x=16..23 must contain foreground (white) pixels.
    let white = 0;
    for (let y = 48; y < 56; y++) for (let x = 16; x < 24; x++) if (dec.rgba[(y * 640 + x) * 4] > 200) white++;
    expect(white).toBeGreaterThan(5);
  });

  it('serves a synthetic JViewer.jar so the client fingerprints the right profile', async () => {
    await start(findScenario('sp-324'));
    const logs: string[] = [];
    client = new KvmClient({ host: '127.0.0.1', webPort: bmc!.webPort, username: 'admin', password: 'admin', autoReconnect: false }, (_l, m) => logs.push(m));
    await client.connect();
    expect(logs.join('\n')).toMatch(/megarac-jviewer-324.*VIDEO_PACKET_SIZE=324/);
  });
});
