// End-to-end checks of exact wire details against the simulator (scenario
// outcomes are covered by tests/scenarios.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { KvmClient } from '../src/protocol/client';
import { Op } from '../src/protocol/ivtp';
import { findScenario } from '../src/sim/scenario';
import { SimBmc } from '../src/sim/server';

let bmc: SimBmc | undefined;
let client: KvmClient | undefined;
afterEach(async () => {
  await client?.disconnect().catch(() => {});
  await bmc?.close();
  bmc = client = undefined;
});

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function connect(name: string, password = 'admin') {
  bmc = new SimBmc(findScenario(name));
  await bmc.listen();
  client = new KvmClient({ host: '127.0.0.1', webPort: bmc.webPort, username: 'admin', password, autoReconnect: false });
  return client.connect();
}

describe('wire details (legacy MegaRAC SP)', () => {
  it('single-port tunnel request and handshake bytes match JViewer', async () => {
    await connect('sp-195');
    expect(bmc!.tunnelRequests[0]).toMatch(/^CONNECT 127\.0\.0\.1:443 HTTP\/1\.1\n cookie \S+\r\n\r\nJVIEWER VIDEO cookie \S+\r\n\r\n$/);
    const types = bmc!.received.map((p) => p.type);
    expect(types.slice(0, 2)).toEqual([Op.GET_WEB_TOKEN, Op.VALIDATE_VIDEO_SESSION]);
    expect(bmc!.received[1].size).toBe(203); // header-inclusive size quirk
  });

  it('HID packets arrive with the IUSB layout', async () => {
    const s = await connect('sp-195');
    s.sendKeyboard(Uint8Array.from([0, 1, 0x04, 0, 0, 0, 0, 0]));
    s.sendMouseAbsolute(1, 100, 200);
    await until(() => bmc!.received.filter((p) => p.type === Op.HID_PKT).length === 2);
    const [kbd, mouse] = bmc!.received.filter((p) => p.type === Op.HID_PKT);
    expect(kbd.body.length).toBe(41);
    expect([...kbd.body.subarray(33, 36)]).toEqual([0, 1, 0x04]);
    expect(mouse.body.readInt16LE(34)).toBe(100);
  });

  it('encrypted scenario sends HID with status 0xFF and opaque payload', async () => {
    const s = await connect('encrypted');
    await until(() => s.encrypted);
    s.sendKeyboard(Uint8Array.from([0, 1, 0x04, 0, 0, 0, 0, 0]));
    await until(() => bmc!.received.some((p) => p.type === Op.HID_PKT));
    const p = bmc!.received.find((x) => x.type === Op.HID_PKT)!;
    expect(p.status).toBe(0xff);
    expect([...p.body.subarray(33, 36)]).not.toEqual([0, 1, 0x04]);
  });

  it('logs out of the web session on disconnect', async () => {
    await connect('sp-195');
    await client!.disconnect();
    expect(bmc!.logouts).toBe(1);
  });

  it('bad credentials give an auth error', async () => {
    await expect(connect('sp-195', 'wrong')).rejects.toMatchObject({ kind: 'auth' });
  });
});
