// Bitstream synthesizer for the ASPEED tile codec (tests and simulator): builds frames
// of any block type from given coefficients or palettes, so the decoder can be tested
// without hardware captures. It is not a real video encoder.
import {
  AC_CHR_NRCODES, AC_CHR_VALUES, AC_LUM_NRCODES, AC_LUM_VALUES,
  DC_CHR_NRCODES, DC_CHR_VALUES, DC_LUM_NRCODES, DC_LUM_VALUES, DEZIGZAG,
} from '../video/tables';
import { VIDEO_HEADER_SIZE } from '../video/decoder';

type Code = { code: number; len: number };

function canonical(nrcodes: number[], values: number[]): Map<number, Code> {
  const m = new Map<number, Code>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < nrcodes[len]; i++) m.set(values[k++], { code: code++, len });
    code <<= 1;
  }
  return m;
}

const DC = [canonical(DC_LUM_NRCODES, DC_LUM_VALUES), canonical(DC_CHR_NRCODES, DC_CHR_VALUES)];
const AC = [canonical(AC_LUM_NRCODES, AC_LUM_VALUES), canonical(AC_CHR_NRCODES, AC_CHR_VALUES)];

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class BitWriter {
  private words: number[] = [];
  private cur = 0;
  private used = 0;

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      if (++this.used === 32) {
        this.words.push(this.cur >>> 0);
        this.cur = 0;
        this.used = 0;
      }
    }
  }

  /** Flushes and appends `padWords` zero words; returns little-endian bytes. */
  finish(padWords = 0): Uint8Array {
    if (this.used > 0) this.write(0, 32 - this.used);
    for (let i = 0; i < padWords; i++) this.words.push(0);
    const out = new Uint8Array(this.words.length * 4);
    const dv = new DataView(out.buffer);
    this.words.forEach((w, i) => dv.setUint32(i * 4, w, true));
    return out;
  }
}

function sizeOf(v: number): number {
  let a = Math.abs(v);
  let n = 0;
  while (a) { n++; a >>= 1; }
  return n;
}

export interface FrameSpec {
  width: number;
  height: number;
  mode420: 0 | 1;
  tableSelector?: number;
  advanceSelector?: number;
  mapping?: number;
  /** Extra zero words after the end code; some decoders stop reading 2 words early otherwise. */
  padWords?: number;
}

export class FrameBuilder {
  readonly bw = new BitWriter();
  private pred = [0, 0, 0];

  constructor(readonly spec: FrameSpec) {}

  private block(coef: number[], table: 0 | 1, comp: number): void {
    const diff = coef[0] - this.pred[comp];
    this.pred[comp] = coef[0];
    const cat = sizeOf(diff);
    const dc = DC[table].get(cat)!;
    this.bw.write(dc.code, dc.len);
    if (cat) this.bw.write(diff > 0 ? diff : diff + (1 << cat) - 1, cat);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coef[DEZIGZAG[k]];
      if (v === 0) { run++; continue; }
      while (run > 15) {
        const z = AC[table].get(0xf0)!;
        this.bw.write(z.code, z.len);
        run -= 16;
      }
      const s = sizeOf(v);
      const c = AC[table].get((run << 4) | s)!;
      this.bw.write(c.code, c.len);
      this.bw.write(v > 0 ? v : v + (1 << s) - 1, s);
      run = 0;
    }
    if (run > 0) {
      const eob = AC[table].get(0x00)!;
      this.bw.write(eob.code, eob.len);
    }
  }

  private header(code: number, pos?: [number, number]): void {
    if (pos) {
      this.bw.write(code | 8, 4);
      this.bw.write(pos[0], 8);
      this.bw.write(pos[1], 8);
    } else {
      this.bw.write(code, 4);
    }
  }

  /** JPEG tile: blocks are natural-order coefficient arrays (4 Y + Cb + Cr in 4:2:0). */
  jpeg(blocks: number[][], opts: { low?: boolean; pos?: [number, number] } = {}): void {
    this.header(opts.low ? 4 : 0, opts.pos);
    const nY = this.spec.mode420 ? 4 : 1;
    for (let i = 0; i < nY; i++) this.block(blocks[i], 0, 0);
    this.block(blocks[nY], 1, 1);
    this.block(blocks[nY + 1], 1, 2);
  }

  pass2(blocks: number[][], pos?: [number, number]): void {
    this.header(2, pos);
    this.block(blocks[0], 0, 0);
    this.block(blocks[1], 1, 1);
    this.block(blocks[2], 1, 2);
  }

  /** VQ tile. entries: [slot, colour | undefined]; pixels: 64 indices into entries. */
  vq(entries: Array<[number, number | undefined]>, pixels: number[], pos?: [number, number]): void {
    const code = entries.length === 1 ? 5 : entries.length === 2 ? 6 : 7;
    const bits = entries.length === 1 ? 0 : entries.length === 2 ? 1 : 2;
    this.header(code, pos);
    for (const [slot, colour] of entries) {
      if (colour === undefined) this.bw.write(slot, 3);
      else { this.bw.write(4 | slot, 3); this.bw.write(colour, 24); }
    }
    if (bits) for (const p of pixels) this.bw.write(p, bits);
  }

  end(): Uint8Array {
    this.bw.write(9, 4);
    const data = this.bw.finish(this.spec.padWords ?? 3);
    return buildFrame(this.spec, data);
  }
}

function buildFrame(spec: FrameSpec, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(VIDEO_HEADER_SIZE + data.length);
  const v = new DataView(out.buffer);
  v.setUint16(4, spec.width, true);
  v.setUint16(6, spec.height, true);
  v.setUint16(13, spec.width, true);
  v.setUint16(15, spec.height, true);
  v.setUint8(42, spec.mode420 ? 0 : 1);
  v.setUint8(44, spec.tableSelector ?? 4);
  v.setUint8(45, spec.mapping ?? 0);
  v.setUint8(47, spec.advanceSelector ?? 4);
  v.setUint8(55, spec.mode420);
  v.setInt32(69, data.length, true);
  out.set(data, VIDEO_HEADER_SIZE);
  return out;
}

/** Random sparse coefficient block in natural order. */
export function randomBlock(r: () => number, density = 0.15, maxMag = 300): number[] {
  const b = new Array(64).fill(0);
  b[0] = Math.round((r() - 0.5) * 2 * 500);
  for (let i = 1; i < 64; i++) if (r() < density) b[i] = Math.round((r() - 0.5) * 2 * maxMag) || 1;
  return b;
}
