import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fingerprintJars, parseClass, readZip } from '../src/protocol/jarprobe';
import { JVIEWER_LEGACY, RD450X_373, selectProfile } from '../src/protocol/profiles';
import { toLaunchConfig } from '../src/protocol/jnlp';

/** Builds a minimal class file declaring `static final int` constants. */
function classWith(name: string, ints: Record<string, number>): Buffer {
  const pool: Buffer[] = [];
  const utf = (s: string) => { const b = Buffer.from(s); pool.push(Buffer.concat([Buffer.from([1, b.length >> 8, b.length & 255]), b])); return pool.length; };
  const int = (v: number) => { const b = Buffer.alloc(5); b[0] = 3; b.writeInt32BE(v, 1); pool.push(b); return pool.length; };
  const nameIdx = utf(name);
  pool.push(Buffer.from([7, 0, nameIdx])); const cls = pool.length;
  const sup = utf('java/lang/Object'); pool.push(Buffer.from([7, 0, sup])); const supCls = pool.length;
  const cv = utf('ConstantValue'); const desc = utf('I');
  const fields = Object.entries(ints).map(([k, v]) => {
    const n = utf(k); const c = int(v);
    return Buffer.from([0, 0x19, 0, n, 0, desc, 0, 1, 0, cv, 0, 0, 0, 2, 0, c]);
  });
  const head = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 49, 0, pool.length + 1]);
  return Buffer.concat([head, ...pool, Buffer.from([0, 0x21, 0, cls, 0, supCls, 0, 0, 0, fields.length]), ...fields, Buffer.from([0, 0, 0, 0])]);
}

function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = deflateRawSync(data); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

const launch = toLaunchConfig({ hostname: 'h', kvmtoken: 't' });

describe('JViewer jar fingerprinting', () => {
  it('reads constants from a synthetic newer-generation jar and picks the 373 profile', () => {
    const jar = zip({ 'com/ami/kvm/jviewer/kvmpkts/IVTPPktHdr.class': classWith('com/ami/kvm/jviewer/kvmpkts/IVTPPktHdr', { VIDEO_PACKET_SIZE: 373, IVTP_KEEP_ALIVE_PKT: 57, IVTP_CONNECTION_COMPLETE_PKT: 58 }) });
    expect(readZip(jar).map((e) => e.name)).toHaveLength(1);
    const fp = fingerprintJars([jar]);
    expect(fp).toMatchObject({ validatePacketSize: 373, hasKeepAlive: true, hasConnectionComplete: true });
    expect(selectProfile(launch, undefined, fp).profile).toBe(RD450X_373);
  });

  it('warns on an unknown validate size', () => {
    const jar = zip({ 'com/ami/kvm/jviewer/kvmpkts/IVTPPktHdr.class': classWith('com/ami/kvm/jviewer/kvmpkts/IVTPPktHdr', { VIDEO_PACKET_SIZE: 260 }) });
    const c = selectProfile(launch, undefined, fingerprintJars([jar]));
    expect(c.warning).toMatch(/Unrecognised/);
  });

  it('parses a class file it built', () => {
    expect(parseClass(classWith('a/B', { X: 7 })).constants).toEqual({ X: 7 });
  });

  // Optional: OJV_REAL_JARS names a folder holding JViewer.jar and JViewer-SOC.jar
  // as downloaded from a 2017-era MegaRAC SP BMC.
  const real = process.env.OJV_REAL_JARS ?? '';
  it.skipIf(!real || !existsSync(join(real, 'JViewer.jar')))('fingerprints 2017 JViewer jars as the 195-byte generation', () => {
    const fp = fingerprintJars(['JViewer.jar', 'JViewer-SOC.jar'].map((j) => readFileSync(join(real, j))));
    expect(fp).toMatchObject({ validatePacketSize: 195, hasKeepAlive: false, hasConnectionComplete: false, hasSinglePort: true, socPackages: ['soc'] });
    expect(selectProfile(launch, undefined, fp).profile).toBe(JVIEWER_LEGACY);
  });
});
