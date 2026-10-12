import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { encodeHeader, encodePacket, FrameAssembler, IvtpReader, Op } from '../src/protocol/ivtp';
import { kvmAllowed, parseJnlp, redactArgs, toLaunchConfig } from '../src/protocol/jnlp';
import { HidPacketizer, toAbsolute } from '../src/protocol/hid';
import { blowfishEcb, kmCipher } from '../src/protocol/blowfish';
import { chordReports, KeyboardState } from '../src/protocol/keymap';

/** A JDK on PATH or JAVA_HOME, for the optional cross-check against Java's own Blowfish. */
const JAVA = (() => {
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
  try {
    execFileSync(java, ['-version'], { stdio: 'ignore' });
    return java;
  } catch {
    return undefined;
  }
})();

describe('IVTP framing', () => {
  it('encodes little-endian headers', () => {
    expect([...encodeHeader(18, 203, 0)]).toEqual([18, 0, 203, 0, 0, 0, 0, 0]);
    expect([...encodeHeader(0x1002, 0x01020304, 0xff)]).toEqual([0x02, 0x10, 4, 3, 2, 1, 0xff, 0]);
  });

  it('reassembles packets split at arbitrary boundaries', () => {
    const stream = Buffer.concat([
      encodePacket(Op.SESSION_ACCEPTED, Buffer.from('users')),
      encodePacket(Op.VALIDATE_VIDEO_SESSION_RESPONSE, Buffer.from([1])),
      encodeHeader(Op.BLANK_SCREEN, 0),
    ]);
    for (let split = 1; split < stream.length; split++) {
      const r = new IvtpReader();
      const pk = [...r.push(stream.subarray(0, split)), ...r.push(stream.subarray(split))];
      expect(pk.map((p) => p.type)).toEqual([23, 19, 9]);
      expect(pk[0].body.toString()).toBe('users');
      expect(r.pending).toBe(0);
    }
  });

  it('reads BW_DETECT_RESP bodies size*status bytes long (as JViewer does)', () => {
    const r = new IvtpReader();
    const pk = r.push(Buffer.concat([encodeHeader(Op.BW_DETECT_RESP, 4, 3), Buffer.alloc(12), encodeHeader(Op.BLANK_SCREEN, 0)]));
    expect(pk.map((p) => [p.type, p.body.length])).toEqual([[17, 12], [9, 0]]);
  });

  it('rejects absurd sizes instead of buffering forever', () => {
    expect(() => new IvtpReader().push(encodeHeader(25, 0x7fffffff))).toThrow(/refusing/);
  });
});

describe('video fragment reassembly', () => {
  const frag = (n: number, data: string) => {
    const b = Buffer.alloc(2 + data.length);
    b.writeUInt16LE(n, 0);
    b.write(data, 2);
    return b;
  };
  it('joins fragments and emits on the last-fragment bit', () => {
    const a = new FrameAssembler();
    expect(a.push(frag(0, 'ab'))).toBeNull();
    expect(a.push(frag(1, 'cd'))).toBeNull();
    expect(a.push(frag(0x8002, 'ef'))!.toString()).toBe('abcdef');
  });
  it('completed frames own their whole ArrayBuffer (never the shared Buffer pool)', () => {
    // The frame's ArrayBuffer is cloned into the renderer; a pooled slab would leak other data.
    const f = new FrameAssembler().push(frag(0x8000, 'tiny'))!;
    expect(f.buffer.byteLength).toBe(f.length);
    expect(f.byteOffset).toBe(0);
  });
  it('single-fragment frame', () => {
    expect(new FrameAssembler().push(frag(0x8000, 'xyz'))!.toString()).toBe('xyz');
  });
  it('drops a frame with a missing fragment', () => {
    const a = new FrameAssembler();
    a.push(frag(0, 'ab'));
    expect(a.push(frag(0x8002, 'ef'))).toBeNull();
    expect(a.dropped).toBe(1);
    expect(a.push(frag(0x8000, 'ok'))!.toString()).toBe('ok');
  });
});

describe('JNLP', () => {
  const xml = readFileSync(join(__dirname, 'fixtures/megarac-sp-195.jnlp'), 'utf8');
  it('parses a MegaRAC SP launch file', () => {
    const j = parseJnlp(xml);
    expect(j.jars).toEqual(['release/JViewer.jar', 'release/JViewer-SOC.jar']);
    expect(j.nativeLibs).toContain('release/Win64.jar');
    const c = toLaunchConfig(j.args);
    expect(c).toMatchObject({
      appType: 'JViewer', host: '10.0.0.42', kvmToken: 'TESTTOKEN0123456', kvmSecure: false, kvmPort: 80,
      singlePort: true, webSecurePort: 443, webCookie: 'TESTCOOKIEabcdefghijklmnopqrstuv000', userPrivileges: 4,
    });
    expect(c.oemFeatures).toBeUndefined();
    expect(kvmAllowed(c)).toBe(true);
  });
  it('redacts secrets', () => {
    const r = redactArgs(parseJnlp(xml).args);
    expect(JSON.stringify(r)).not.toContain('TESTTOKEN');
    expect(JSON.stringify(r)).not.toContain('TESTCOOKIE');
  });
  it('uses JViewer defaults for absent args', () => {
    const c = toLaunchConfig({ hostname: 'h', kvmtoken: 't' });
    expect(c.kvmPort).toBe(7578);
    expect(c.singlePort).toBe(false);
  });
});

describe('HID packets', () => {
  it('builds the keyboard packet byte-for-byte as JViewer does', () => {
    const h = new HidPacketizer();
    const p = h.keyboard(Uint8Array.from([0x02, 0, 0x04, 0, 0, 0, 0, 0]));
    expect(p.length).toBe(49);
    expect(p.readUInt16LE(0)).toBe(1);
    expect(p.readUInt32LE(2)).toBe(41);
    expect(p.subarray(8, 16).toString()).toBe('IUSB    ');
    expect([p[16], p[17], p[18]]).toEqual([1, 0, 32]);
    expect(p.readUInt32LE(20)).toBe(9);
    expect([p[24], p[25], p[26], p[27], p[28], p[29]]).toEqual([0, 0x30, 0x10, 0x80, 2, 0]);
    expect(p.readUInt32LE(32)).toBe(0);
    expect(p[40]).toBe(8);
    expect([...p.subarray(41)]).toEqual([2, 0, 4, 0, 0, 0, 0, 0]);
    let sum = 0;
    for (let i = 8; i < 40; i++) sum += p[i];
    expect(sum & 0xff).toBe(0);
    expect(h.keyboard(new Uint8Array(8)).readUInt32LE(32)).toBe(1);
  });
  it('builds absolute and relative mouse packets', () => {
    const h = new HidPacketizer();
    const a = h.mouseAbsolute(1, 16384, 32767, -1);
    expect(a.length).toBe(47);
    expect(a.readUInt32LE(2)).toBe(39);
    expect([a[25], a[26], a[29], a.readUInt32LE(20), a[40]]).toEqual([0x31, 0x20, 1, 7, 6]);
    expect([a[41], a.readInt16LE(42), a.readInt16LE(44), a.readInt8(46)]).toEqual([1, 16384, 32767, -1]);
    const r = h.mouseRelative(0, -5, 200);
    expect(r.length).toBe(45);
    expect([r.readUInt32LE(20), r[40], r.readInt8(42), r.readInt8(43)]).toEqual([5, 4, -5, 127]);
    expect(r.readUInt32LE(32)).toBe(1); // mouse sequence is separate from keyboard
  });
  it('encrypted reports use status 0xFF and an 8-byte payload', () => {
    const h = new HidPacketizer(kmCipher('TESTTOKEN0123456'));
    for (const p of [h.keyboard(new Uint8Array(8)), h.mouseAbsolute(0, 1, 2), h.mouseRelative(0, 1, 1)]) {
      expect(p.length).toBe(49);
      expect(p.readUInt32LE(2)).toBe(41);
      expect(p.readUInt16LE(6)).toBe(0xff);
    }
  });
  it('scales absolute coordinates like JViewer', () => {
    expect(toAbsolute(0, 1024)).toBe(0);
    expect(toAbsolute(512, 1024)).toBe(16384);
    expect(toAbsolute(1023, 1024)).toBe(32735);
    expect(toAbsolute(400, 832)).toBe(toAbsolute(400, 800));
  });
});

describe('keyboard state', () => {
  it('tracks modifiers and 6-key rollover', () => {
    const k = new KeyboardState();
    expect([...k.handle('ShiftLeft', true)!]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
    expect([...k.handle('KeyA', true)!]).toEqual([2, 0, 4, 0, 0, 0, 0, 0]);
    expect(k.handle('KeyA', true)).toBeNull(); // auto-repeat
    expect([...k.handle('KeyB', true)!]).toEqual([2, 0, 4, 5, 0, 0, 0, 0]);
    expect([...k.handle('KeyA', false)!]).toEqual([2, 0, 5, 0, 0, 0, 0, 0]);
    expect(k.handle('Unidentified', true)).toBeNull();
    expect([...k.releaseAll()!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('JViewer single-key mode reports only the latest key', () => {
    const k = new KeyboardState('single');
    k.handle('KeyA', true);
    expect([...k.handle('KeyB', true)!]).toEqual([0, 0, 5, 0, 0, 0, 0, 0]);
    expect([...k.handle('KeyB', false)!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('JViewer auto-keybreak mode (the default JViewer behaviour)', () => {
    const k = new KeyboardState('autobreak');
    expect([...k.handle('ShiftLeft', true)!]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
    expect([...k.handle('KeyA', true)!]).toEqual([2, 1, 4, 0, 0, 0, 0, 0]);
    expect([...k.handle('KeyA', true)!]).toEqual([2, 1, 4, 0, 0, 0, 0, 0]); // auto-repeat resends
    expect(k.handle('KeyA', false)).toBeNull(); // BMC breaks the key itself
    expect([...k.handle('CapsLock', false)!]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]); // lock keys do send release
    expect([...k.handle('ShiftLeft', false)!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('Ctrl+Alt+Del chord', () => {
    expect(chordReports(['ControlLeft', 'AltLeft', 'Delete']).map((r) => [...r.subarray(0, 3)])).toEqual([
      [1, 0, 0], [5, 0, 0], [5, 0, 0x4c], [5, 0, 0], [1, 0, 0], [0, 0, 0],
    ]);
  });
});

describe('Blowfish', () => {
  const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
  it('matches published test vectors (Schneier/Eric Young)', () => {
    const v: Array<[string, string, string]> = [
      ['0000000000000000', '0000000000000000', '4ef997456198dd78'],
      ['ffffffffffffffff', 'ffffffffffffffff', '51866fd5b85ecb8a'],
      ['3000000000000000', '1000000000000001', '7d856f9a613063f2'],
      ['0123456789abcdef', '1111111111111111', '61f9c3802281b096'],
      ['fedcba9876543210', '0123456789abcdef', '0aceab0fc6a0a28d'],
    ];
    for (const [k, p, c] of v) {
      expect(Buffer.from(blowfishEcb(hex(k))(hex(p))).toString('hex')).toBe(c);
    }
  });
  it.skipIf(!JAVA)('matches the JDK\'s Blowfish/ECB/NoPadding, as used by Java clients', () => {
    const src = join(__dirname, 'helpers/BlowfishCheck.java');
    for (const [token, data] of [['Xq7LmN2pR4sT9vWz', '0200040000000000'], ['short', '01ff7f0080000000'], ['A1B2C3D4E5F6G7H8I9J0', '0000000000000000ffffffffffffffff']]) {
      const java = execFileSync(JAVA!, [src, token, data]).toString().trim();
      expect(kmCipher(token).encrypt(Buffer.from(data, 'hex')).toString('hex')).toBe(java);
    }
  });
});
