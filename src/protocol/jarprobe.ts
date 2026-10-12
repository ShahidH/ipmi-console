/**
 * Reads protocol parameters from the client files (JViewer.jar) the BMC serves.
 * Each BMC ships the client that matches its own firmware, so its constants are
 * the best available indication of the protocol variant.
 *
 * Reads the ZIP central directory, inflates the relevant .class files and pulls
 * `static final` constants (ConstantValue attributes) plus string literals from
 * the constant pool. No Java runtime involved.
 */
import { inflateRawSync } from 'node:zlib';

export interface ClassInfo {
  name: string;
  /** static final constants with a ConstantValue attribute. */
  constants: Record<string, number | string>;
  /** UTF-8 constant-pool strings referenced as String literals. */
  strings: string[];
  /** Method names declared by the class. */
  methods: string[];
  /** Integer constants pushed (bipush/sipush/ldc int) per method, in order. */
  pushedInts: Record<string, number[]>;
}

export interface JarEntry {
  name: string;
  data(): Buffer;
}

export function readZip(buf: Buffer): JarEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP/JAR file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: JarEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({
      name,
      data: () => {
        const lnameLen = buf.readUInt16LE(local + 26);
        const lextraLen = buf.readUInt16LE(local + 28);
        const start = local + 30 + lnameLen + lextraLen;
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`unsupported ZIP compression ${method} for ${name}`);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function parseClass(b: Buffer): ClassInfo {
  if (b.readUInt32BE(0) !== 0xcafebabe) throw new Error('not a class file');
  let p = 10;
  const count = b.readUInt16BE(8);
  const pool: Array<{ tag: number; v?: number | string; ref?: number; ref2?: number }> = [];
  for (let i = 1; i < count; i++) {
    const tag = b[p++];
    switch (tag) {
      case 1: { const len = b.readUInt16BE(p); pool[i] = { tag, v: b.toString('utf8', p + 2, p + 2 + len) }; p += 2 + len; break; }
      case 3: pool[i] = { tag, v: b.readInt32BE(p) }; p += 4; break;
      case 4: pool[i] = { tag, v: b.readFloatBE(p) }; p += 4; break;
      case 5: pool[i] = { tag, v: Number(b.readBigInt64BE(p)) }; p += 8; i++; break;
      case 6: pool[i] = { tag, v: b.readDoubleBE(p) }; p += 8; i++; break;
      case 7: case 8: case 16: case 19: case 20: pool[i] = { tag, ref: b.readUInt16BE(p) }; p += 2; break;
      case 9: case 10: case 11: case 12: case 17: case 18: pool[i] = { tag, ref: b.readUInt16BE(p), ref2: b.readUInt16BE(p + 2) }; p += 4; break;
      case 15: pool[i] = { tag }; p += 3; break;
      default: throw new Error(`bad constant-pool tag ${tag}`);
    }
  }
  const utf = (i: number) => String(pool[i]?.v ?? '');
  const name = utf(pool[b.readUInt16BE(p + 2)]!.ref!);
  p += 6;
  p += 2 + 2 * b.readUInt16BE(p); // interfaces
  const constants: Record<string, number | string> = {};
  const fields = b.readUInt16BE(p); p += 2;
  for (let f = 0; f < fields; f++) {
    const fname = utf(b.readUInt16BE(p + 2));
    const attrs = b.readUInt16BE(p + 6); p += 8;
    for (let a = 0; a < attrs; a++) {
      const an = utf(b.readUInt16BE(p));
      const len = b.readUInt32BE(p + 2);
      if (an === 'ConstantValue') {
        const c = pool[b.readUInt16BE(p + 6)];
        constants[fname] = c?.tag === 8 ? utf(c.ref!) : (c?.v as number);
      }
      p += 6 + len;
    }
  }
  const methods: string[] = [];
  const pushedInts: Record<string, number[]> = {};
  const mcount = b.readUInt16BE(p); p += 2;
  for (let m = 0; m < mcount; m++) {
    const mname = utf(b.readUInt16BE(p + 2));
    methods.push(mname);
    const attrs = b.readUInt16BE(p + 6); p += 8;
    for (let a = 0; a < attrs; a++) {
      const len = b.readUInt32BE(p + 2);
      if (utf(b.readUInt16BE(p)) === 'Code') {
        const codeLen = b.readUInt32BE(p + 10);
        pushedInts[mname] = scanIntPushes(b.subarray(p + 14, p + 14 + codeLen), pool);
      }
      p += 6 + len;
    }
  }
  const strings = pool.filter((c) => c?.tag === 8).map((c) => utf(c!.ref!));
  return { name, constants, strings, methods, pushedInts };
}

/** Collects integer literals from a method's Code attribute (only the instruction forms that matter here). */
function scanIntPushes(code: Buffer, pool: Array<{ tag: number; v?: number | string } | undefined>): number[] {
  const out: number[] = [];
  const fixed: Record<number, number> = { 0x10: 2, 0x11: 3, 0x12: 2, 0x13: 3, 0x14: 3, 0x15: 2, 0x16: 2, 0x17: 2, 0x18: 2, 0x19: 2, 0x36: 2, 0x37: 2, 0x38: 2, 0x39: 2, 0x3a: 2, 0x84: 3, 0xa9: 2, 0xbc: 2, 0xc5: 4, 0xb2: 3, 0xb3: 3, 0xb4: 3, 0xb5: 3, 0xb6: 3, 0xb7: 3, 0xb8: 3, 0xbb: 3, 0xbd: 3, 0xc0: 3, 0xc1: 3, 0xc6: 3, 0xc7: 3, 0xa7: 3, 0xa8: 3, 0xb9: 5, 0xba: 5, 0xc8: 5, 0xc9: 5 };
  for (let i = 0; i >= 0 && i < code.length;) {
    const op = code[i];
    if (op === 0x10) out.push(code.readInt8(i + 1));
    else if (op === 0x11) out.push(code.readInt16BE(i + 1));
    else if (op === 0x12 || op === 0x13) {
      const c = pool[op === 0x12 ? code[i + 1] : code.readUInt16BE(i + 1)];
      if (c?.tag === 3) out.push(c.v as number);
    } else if (op >= 0x02 && op <= 0x08) out.push(op - 3);
    if (op >= 0x99 && op <= 0xa6) { i += 3; continue; } // if* branches
    if (op === 0xaa || op === 0xab) {
      // tableswitch / lookupswitch: padded to 4 bytes
      let j = i + 1 + ((4 - ((i + 1) % 4)) % 4);
      if (op === 0xaa) {
        const lo = code.readInt32BE(j + 4), hi = code.readInt32BE(j + 8);
        j += 12 + 4 * (hi - lo + 1);
      } else {
        j += 8 + 8 * code.readInt32BE(j + 4);
      }
      i = j;
      continue;
    }
    if (op === 0xc4) { i += code[i + 1] === 0x84 ? 6 : 4; continue; } // wide
    i += fixed[op] ?? 1;
  }
  return out;
}

export interface JViewerFingerprint {
  /** VIDEO_PACKET_SIZE constant (195 in the 2017 client; 324/373/438 elsewhere). */
  validatePacketSize?: number;
  /** The client writes VIDEO_PACKET_SIZE+8 into the VALIDATE header (seen in 195/324 jars). */
  validateHeaderPlus8?: boolean;
  /** IVTP_POWER_CONTROL_SOFT_RESET (4 in the 2017 client, 5 on newer firmware). */
  softResetCode?: number;
  /** IVTP opcode constants present in the client (name → value). */
  opcodes: Record<string, number>;
  hasKeepAlive: boolean;
  hasConnectionComplete: boolean;
  hasSinglePort: boolean;
  /** Cipher transformation used for keyboard/mouse encryption (e.g. "Blowfish/ECB/NoPadding"). */
  kmCipher?: string;
  defaultKvmPort?: number;
  /** Which SoC packages are present (e.g. ["soc"] or other vendor SoCs). */
  socPackages: string[];
  decoderMaxResolution?: number;
  manifestCreatedBy?: string;
  classCount: number;
  notes: string[];
}

/** Fingerprints one or more jars (JViewer.jar + JViewer-SOC.jar). */
export function fingerprintJars(jars: Buffer[]): JViewerFingerprint {
  let validateMethodInts: number[] | undefined;
  const fp: JViewerFingerprint = { opcodes: {}, hasKeepAlive: false, hasConnectionComplete: false, hasSinglePort: false, socPackages: [], classCount: 0, notes: [] };
  for (const jar of jars) {
    for (const e of readZip(jar)) {
      if (e.name === 'META-INF/MANIFEST.MF') {
        fp.manifestCreatedBy ??= /Created-By:\s*(.+)/.exec(e.data().toString('latin1'))?.[1]?.trim();
        continue;
      }
      if (!e.name.endsWith('.class')) continue;
      fp.classCount++;
      const soc = /^com\/ami\/kvm\/jviewer\/(\w*soc\w*)\//i.exec(e.name);
      if (soc && !fp.socPackages.includes(soc[1])) fp.socPackages.push(soc[1]);
      if (e.name.endsWith('/SinglePortKVM.class')) fp.hasSinglePort = true;
      if (!/(IVTPPktHdr|KMCrypt|JViewer|JViewerApp|Decoder)\.class$/.test(e.name)) continue;
      let c: ClassInfo;
      try {
        c = parseClass(e.data());
      } catch (err) {
        fp.notes.push(`could not parse ${e.name}: ${(err as Error).message}`);
        continue;
      }
      if (c.name.endsWith('kvmpkts/IVTPPktHdr')) {
        if (typeof c.constants.VIDEO_PACKET_SIZE === 'number') fp.validatePacketSize = c.constants.VIDEO_PACKET_SIZE;
        for (const [k, v] of Object.entries(c.constants)) if (k.startsWith('IVTP_') && typeof v === 'number') fp.opcodes[k] = v;
        fp.hasKeepAlive ||= Object.keys(c.constants).some((k) => /KEEP_?ALIVE/i.test(k));
        fp.hasConnectionComplete ||= Object.keys(c.constants).some((k) => /CONNECTION_COMPLETE/i.test(k));
        if (typeof c.constants.IVTP_POWER_CONTROL_SOFT_RESET === 'number') fp.softResetCode = c.constants.IVTP_POWER_CONTROL_SOFT_RESET;
      } else if (c.name.endsWith('/KMCrypt')) {
        fp.kmCipher = c.strings.find((s) => s.includes('/ECB/') || s.includes('/CBC/') || /^(Blowfish|AES|RC4|ARCFOUR)$/i.test(s));
      } else if (c.name.endsWith('/JViewerApp')) {
        validateMethodInts = c.pushedInts.OnsendWebsessionToken;
      } else if (c.name === 'com/ami/kvm/jviewer/JViewer') {
        fp.notes.push(...c.strings.filter((s) => s.startsWith('-') && s.length < 24).map((s) => `arg ${s}`));
      } else if (c.name.endsWith('video/Decoder') && typeof c.constants.MAX_X_RESOLUTION === 'number') {
        fp.decoderMaxResolution = c.constants.MAX_X_RESOLUTION;
      }
    }
  }
  if (fp.validatePacketSize !== undefined && validateMethodInts) {
    // The size the client puts in the VALIDATE header appears as an integer literal.
    if (validateMethodInts.includes(fp.validatePacketSize + 8)) fp.validateHeaderPlus8 = true;
    else if (validateMethodInts.includes(fp.validatePacketSize)) fp.validateHeaderPlus8 = false;
  }
  return fp;
}
