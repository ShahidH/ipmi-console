/**
 * Builds a tiny synthetic JViewer.jar for the simulator, holding only the constants
 * the app's jar fingerprinting reads, so profile selection runs as it would against
 * a real BMC. Every byte is generated here.
 */
import { deflateRawSync } from 'node:zlib';

type Const = number;

/** Minimal class file: static final int constants + one method pushing `pushes`. */
function classFile(name: string, ints: Record<string, Const>, method?: { name: string; pushes: number[] }): Buffer {
  const pool: Buffer[] = [];
  const add = (b: Buffer) => { pool.push(b); return pool.length; };
  const utf = (s: string) => { const b = Buffer.from(s); return add(Buffer.concat([Buffer.from([1, b.length >> 8, b.length & 255]), b])); };
  const int = (v: number) => { const b = Buffer.alloc(5); b[0] = 3; b.writeInt32BE(v, 1); return add(b); };
  const u16 = (v: number) => Buffer.from([v >> 8, v & 255]);
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  const cls = add(Buffer.concat([Buffer.from([7]), u16(utf(name))]));
  const sup = add(Buffer.concat([Buffer.from([7]), u16(utf('java/lang/Object'))]));
  const cv = utf('ConstantValue');
  const desc = utf('I');
  const fields = Object.entries(ints).map(([k, v]) => Buffer.concat([u16(0x19), u16(utf(k)), u16(desc), u16(1), u16(cv), u32(2), u16(int(v))]));
  const methods: Buffer[] = [];
  if (method) {
    const code: number[] = [];
    for (const v of method.pushes) {
      if (v >= -128 && v <= 127) code.push(0x10, v & 255, 0x57); // bipush v; pop
      else code.push(0x11, (v >> 8) & 255, v & 255, 0x57); // sipush v; pop
    }
    code.push(0xb1); // return
    const codeAttr = Buffer.concat([u16(2), u16(1), u32(code.length), Buffer.from(code), u16(0), u16(0)]);
    methods.push(Buffer.concat([u16(0x09), u16(utf(method.name)), u16(utf('()V')), u16(1), u16(utf('Code')), u32(codeAttr.length), codeAttr]));
  }
  const head = Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 49]), u16(pool.length + 1)]);
  return Buffer.concat([head, ...pool, u16(0x21), u16(cls), u16(sup), u16(0), u16(fields.length), ...fields, u16(methods.length), ...methods, u16(0)]);
}

export function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp);
    central.push(ch, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  const count = Object.keys(files).length;
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(count, 8); e.writeUInt16LE(count, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

export function fakeJViewerJar(o: { videoPacketSize: number; headerPlus8: boolean; keepAlive: boolean; softReset: number }): Buffer {
  const consts: Record<string, number> = {
    VIDEO_PACKET_SIZE: o.videoPacketSize, IVTP_VALIDATE_VIDEO_SESSION: 18, IVTP_SESSION_ACCEPTED: 23,
    IVTP_POWER_CONTROL_SOFT_RESET: o.softReset,
  };
  if (o.keepAlive) Object.assign(consts, { IVTP_KEEP_ALIVE_PKT: 57, IVTP_CONNECTION_COMPLETE_PKT: 58 });
  const hdrSize = o.headerPlus8 ? o.videoPacketSize + 8 : o.videoPacketSize;
  return zip({
    'META-INF/MANIFEST.MF': Buffer.from('Manifest-Version: 1.0\nCreated-By: ipmi-console simulator\n'),
    'com/ami/kvm/jviewer/kvmpkts/IVTPPktHdr.class': classFile('com/ami/kvm/jviewer/kvmpkts/IVTPPktHdr', consts),
    'com/ami/kvm/jviewer/gui/JViewerApp.class': classFile('com/ami/kvm/jviewer/gui/JViewerApp', {}, { name: 'OnsendWebsessionToken', pushes: [21, hdrSize, 128] }),
    'com/ami/kvm/jviewer/gui/SinglePortKVM.class': classFile('com/ami/kvm/jviewer/gui/SinglePortKVM', {}),
  });
}

export function fakeSocJar(): Buffer {
  return zip({ 'com/ami/kvm/jviewer/soc/video/Decoder.class': classFile('com/ami/kvm/jviewer/soc/video/Decoder', { MAX_X_RESOLUTION: 1500 }) });
}
