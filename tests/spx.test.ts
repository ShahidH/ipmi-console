// SP-X specifics and read-only family detection, against the simulator.
import { afterEach, describe, expect, it } from 'vitest';
import { KvmClient } from '../src/protocol/client';
import { detectFamily } from '../src/protocol/detect';
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

describe('family detection (unauthenticated, read-only)', () => {
  for (const [scenario, family] of [['spx-438', 'megarac-spx'], ['sp-195', 'megarac-sp']] as const) {
    it(`identifies ${family}`, async () => {
      bmc = new SimBmc(findScenario(scenario));
      await bmc.listen();
      expect((await detectFamily({ host: '127.0.0.1', port: bmc.webPort, scheme: 'http' })).family).toBe(family);
    });
  }
});

describe('SP-X session details', () => {
  it('sends 21 with the 35-byte h5viewercfg session after MEDIA_LICENSE_STATUS, echoes KEEP_ALIVE, sends FPS_DIFF', async () => {
    bmc = new SimBmc(findScenario('spx-438'));
    await bmc.listen();
    client = new KvmClient({ host: '127.0.0.1', webPort: bmc.webPort, username: 'admin', password: 'admin', autoReconnect: false });
    const s = await client.connect();
    expect(client.family).toBe('megarac-spx');
    expect(s.sessionId).toBe(7);
    await until(() => bmc!.received.some((p) => p.type === Op.GET_WEB_TOKEN));
    expect(bmc!.received.find((p) => p.type === Op.GET_WEB_TOKEN)!.body.length).toBe(35);
    await until(() => bmc!.received.some((p) => p.type === Op.FPS_DIFF), 1000);
    await until(() => bmc!.received.some((p) => p.type === Op.KEEP_ALIVE), 7000);
    await client.disconnect();
    expect(bmc.logouts).toBe(1);
  }, 15000);
});

describe('SP-X WebSocket failures', () => {
  it('rejects promptly (no hang) when the BMC answers the upgrade incorrectly', async () => {
    const http = await import('node:http');
    const srv = http.createServer();
    srv.on('upgrade', (_req, sock) => sock.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { WsStream } = await import('../src/protocol/websocket');
    const port = (srv.address() as import('node:net').AddressInfo).port;
    await expect(WsStream.connect({ host: '127.0.0.1', port, path: '/kvm', secure: false, timeoutMs: 3000 })).rejects.toThrow(/Sec-WebSocket-Accept/);
    srv.close();
  });
});
