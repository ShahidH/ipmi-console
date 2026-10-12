/**
 * ASPEED video-engine (AST2050/2100/2300/2400 family) tile decoder.
 *
 * The BMC sends a frame as an 86-byte VideoHeader followed by a compressed
 * bitstream of 8x8 (YUV 4:4:4) or 16x16 (YUV 4:2:0) tiles. Each tile starts with
 * a 4-bit block code selecting baseline-JPEG (DCT/Huffman), a "pass 2" JPEG delta
 * against the previous frame, or a 1/2/4-colour VQ tile; codes with bit 3 set
 * also carry an explicit tile position (skip coding).
 *
 * Tested pixel-for-pixel against ASPEED's reference decoder (aspeed_codec).
 * `DecoderOptions.pass2Mode` selects ASPEED's pass-2 accumulation instead.
 */
import {
  AC_CHR_LENGTHS, AC_CHR_NRCODES, AC_CHR_VALUES, AC_LUM_LENGTHS, AC_LUM_NRCODES, AC_LUM_VALUES,
  DC_CHR_LENGTHS, DC_CHR_NRCODES, DC_CHR_VALUES, DC_LUM_LENGTHS, DC_LUM_NRCODES, DC_LUM_VALUES,
  DEZIGZAG, QUANT_UV as Q_UV, QUANT_Y as Q_Y,
} from './tables';

export const VIDEO_HEADER_SIZE = 86;

export interface VideoHeader {
  engineVersion: number;
  headerLength: number;
  sourceWidth: number;
  sourceHeight: number;
  destWidth: number;
  destHeight: number;
  frameNumber: number;
  compressionMode: number;
  jpegScaleFactor: number;
  jpegTableSelector: number;
  jpegYuvTableMapping: number;
  sharpModeSelection: number;
  advanceTableSelector: number;
  advanceScaleFactor: number;
  numberOfMB: number;
  rc4Enable: number;
  rc4Reset: number;
  mode420: number;
  vqMode: number;
  sourceFrameSize: number;
  compressSize: number;
  inputSignal: number;
  cursorX: number;
  cursorY: number;
}

/** Parses the 86-byte little-endian VideoHeader. */
export function parseVideoHeader(buf: Uint8Array): VideoHeader {
  if (buf.length < VIDEO_HEADER_SIZE) throw new Error(`video frame too short (${buf.length} bytes)`);
  const v = new DataView(buf.buffer, buf.byteOffset, VIDEO_HEADER_SIZE);
  return {
    engineVersion: v.getUint16(0, true),
    headerLength: v.getUint16(2, true),
    sourceWidth: v.getUint16(4, true),
    sourceHeight: v.getUint16(6, true),
    destWidth: v.getUint16(13, true),
    destHeight: v.getUint16(15, true),
    frameNumber: v.getUint32(26, true),
    compressionMode: v.getUint8(42),
    jpegScaleFactor: v.getUint8(43),
    jpegTableSelector: v.getUint8(44),
    jpegYuvTableMapping: v.getUint8(45),
    sharpModeSelection: v.getUint8(46),
    advanceTableSelector: v.getUint8(47),
    advanceScaleFactor: v.getUint8(48),
    numberOfMB: v.getInt32(49, true),
    rc4Enable: v.getUint8(53),
    rc4Reset: v.getUint8(54),
    mode420: v.getUint8(55),
    vqMode: v.getUint8(64),
    sourceFrameSize: v.getInt32(65, true),
    compressSize: v.getInt32(69, true),
    inputSignal: v.getUint8(81),
    cursorX: v.getInt16(82, true),
    cursorY: v.getInt16(84, true),
  };
}

export interface DecoderOptions {
  /**
   * Pass-2 (delta) tile reconstruction. 'clamp' (default): clamp previous+delta
   * to 0..255 without updating the stored frame. 'accumulate' (aspeed_codec):
   * byte-wrapping add that updates the stored frame. Which one matches the
   * hardware has not been verified on captures yet.
   */
  pass2Mode?: 'clamp' | 'accumulate';
}

export interface DecodeResult {
  header: VideoHeader;
  /** True when the frame carried tile data (header-only frames mean "no change"). */
  updated: boolean;
  /** Frame dimensions of the RGBA buffer. */
  width: number;
  height: number;
  /** Dirty rectangle in pixels covering every tile touched, or null. */
  dirty: { x: number; y: number; w: number; h: number } | null;
  /** Non-fatal problem encountered while decoding, if any. */
  warning?: string;
}

const AAN = [1.0, 1.3870399, 1.306563, 1.1758755, 1.0, 0.78569496, 0.5411961, 0.27589938].map(Math.fround);

class HuffTable {
  /** Code length for each 16-bit look-ahead value. */
  readonly len = new Uint8Array(65536);
  readonly minor = new Int16Array(17);
  /** Symbol for (length << 8 | index-within-length). */
  readonly values = new Int16Array(65536);

  constructor(nrcodes: number[], symbols: number[], lengths: number[]) {
    let k = 0;
    for (let l = 1; l <= 16; l++) {
      for (let i = 0; i < nrcodes[l]; i++) this.values[(l << 8) | i] = symbols[k++];
    }
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      this.minor[l] = code;
      code += nrcodes[l];
      code *= 2;
      if (nrcodes[l] === 0) this.minor[l] = -1;
    }
    // len[65535] intentionally stays 0.
    this.len[0] = 2;
    let n = 2;
    for (let i = 1; i < 65535; i++) {
      if (!(i < lengths[n])) n += 2;
      this.len[i] = lengths[n + 1] & 0xff;
    }
  }
}

const HT_DC = [new HuffTable(DC_LUM_NRCODES, DC_LUM_VALUES, DC_LUM_LENGTHS), new HuffTable(DC_CHR_NRCODES, DC_CHR_VALUES, DC_CHR_LENGTHS)];
const HT_AC = [new HuffTable(AC_LUM_NRCODES, AC_LUM_VALUES, AC_LUM_LENGTHS), new HuffTable(AC_CHR_NRCODES, AC_CHR_VALUES, AC_CHR_LENGTHS)];

/** Clamps IDCT and colour-conversion results to 0..255 (index = value + 256). */
const RANGE_LIMIT = (() => {
  const t = new Uint8Array(1408);
  for (let n = 0; n < 256; n++) t[256 + n] = n;
  t.fill(255, 512, 896);
  t.fill(0, 896, 1280);
  for (let n = 1280; n < 1408; n++) t[n] = n & 0xff;
  return t;
})();

const FIX = (d: number) => Math.trunc(d * 65536 + 0.5);
const Y_TO_RGB = new Int32Array(256);
const CR_TO_R = new Int32Array(256);
const CB_TO_B = new Int32Array(256);
const CR_TO_G = new Int32Array(256);
const CB_TO_G = new Int32Array(256);
for (let i = 0, c = -128; i < 256; i++, c++) {
  CR_TO_R[i] = (FIX(1.597656) * c + 32768) >> 16;
  CB_TO_B[i] = (FIX(2.015625) * c + 32768) >> 16;
  CR_TO_G[i] = (-FIX(0.8125) * c + 32768) >> 16;
  CB_TO_G[i] = (-FIX(0.390625) * c + 32768) >> 16;
}
for (let i = 0, y = -16; i < 256; i++, y++) Y_TO_RGB[i] = (FIX(1.164) * y + 32768) >> 16;
/** Green chroma contribution for (cb << 8 | cr). */
const CH_TO_G = new Int32Array(65536);
for (let cb = 0; cb < 256; cb++) for (let cr = 0; cr < 256; cr++) CH_TO_G[(cb << 8) | cr] = CB_TO_G[cb] + CR_TO_G[cr];
/** Clamp to 0..255 for v in -1024..1023 (index v + 1024). Equals the range-limit lookup used by writeRgb. */
const CLAMP = new Uint8Array(2048);
for (let v = -1024; v < 1024; v++) CLAMP[v + 1024] = v < 0 ? 0 : v > 255 ? 255 : v;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** YCbCr → packed RGBA (little-endian byte order R,G,B,A), identical to writeRgb. */
function packRgba(y: number, cb: number, cr: number): number {
  const yy = Y_TO_RGB[y] + 1024;
  return (0xff000000 | (CLAMP[yy + CB_TO_B[cb]] << 16) | (CLAMP[yy + CH_TO_G[(cb << 8) | cr]] << 8) | CLAMP[yy + CR_TO_R[cr]]) >>> 0;
}

export class AspeedDecoder {
  private readonly opts: Required<DecoderOptions>;
  /** RGBA output, width*height*4. Persistent across frames (delta tiles). */
  rgba = new Uint8ClampedArray(0);
  /** 32-bit view of `rgba` for single-store pixel writes (little-endian hosts). */
  private rgba32 = new Uint32Array(0);
  width = 0;
  height = 0;
  /** Previous YUV per pixel, packed y<<16 | cb<<8 | cr, for pass-2 delta tiles. */
  private prevYuv = new Uint32Array(0);
  private readonly vqRgba = new Uint32Array(4);
  private readonly vqYuv = new Uint32Array(4);

  // Bitstream state.
  private words: Uint32Array = new Uint32Array(0);
  private reg0 = 0;
  private reg1 = 0;
  private idx = 0;
  private newbits = 0;

  /** Dequantization multipliers (quantizer x AAN scale, truncated). */
  private readonly qt = [new Int32Array(64), new Int32Array(64), new Int32Array(64), new Int32Array(64)];
  private readonly coeff = new Int32Array(384);
  private readonly ws = new Int32Array(64);
  private readonly tile = new Int32Array(768);
  private dcY = 0;
  private dcCb = 0;
  private dcCr = 0;
  private readonly vqColor = new Uint32Array(4);
  private readonly vqIndex = new Uint8Array(4);

  private mode420 = 1;
  private gridW = 0; // destination width padded to the tile grid
  private gridH = 0;
  private txb = 0;
  private tyb = 0;
  private dirtyMinX = 0;
  private dirtyMinY = 0;
  private dirtyMaxX = 0;
  private dirtyMaxY = 0;

  constructor(opts: DecoderOptions = {}) {
    this.opts = { pass2Mode: 'clamp', ...opts };
  }

  /** Clears decoder state; the next frame must be a full refresh. */
  reset(): void {
    this.width = 0;
    this.height = 0;
    this.rgba = new Uint8ClampedArray(0);
    this.prevYuv = new Uint32Array(0);
    this.rgba32 = new Uint32Array(0);
  }

  /**
   * Decodes one reassembled frame (VideoHeader + compressed data) into `rgba`.
   * Throws on frames that cannot be decoded at all (bad header, encrypted).
   */
  decode(frame: Uint8Array): DecodeResult {
    const h = parseVideoHeader(frame);
    const w = h.sourceWidth;
    const ht = h.sourceHeight;
    if (w < 1 || ht < 1 || w > 4096 || ht > 4096) throw new Error(`invalid video resolution ${w}x${ht}`);
    if (w !== this.width || ht !== this.height) this.resize(w, ht);
    const result: DecodeResult = { header: h, updated: false, width: w, height: ht, dirty: null };
    // Header-only frames and CompressSize 12 ("no change") carry no tiles.
    if (frame.length <= VIDEO_HEADER_SIZE || h.compressSize === 12) return result;
    if (frame[VIDEO_HEADER_SIZE] === 0xff && frame[VIDEO_HEADER_SIZE + 1] === 0xd8) {
      throw new Error('AST2500 JPEG capture mode (standard JPEG rectangles) is not supported yet');
    }
    if (h.jpegTableSelector > 11 || h.advanceTableSelector > 11) {
      result.warning = `quantization selector ${h.jpegTableSelector}/${h.advanceTableSelector} out of range; clamped to 11`;
    }
    if (h.rc4Enable === 1) {
      // Refuse rather than paint garbage.
      throw new Error('RC4-encrypted video frames are not supported');
    }
    this.mode420 = h.mode420;
    const unit = this.mode420 === 1 ? 16 : 8;
    this.gridW = roundUp(h.destWidth, unit);
    this.gridH = roundUp(h.destHeight, unit);
    const sel = Math.min(h.jpegTableSelector, 11);
    const adv = Math.min(h.advanceTableSelector, 11);
    const chroma = h.jpegYuvTableMapping === 1 ? Q_Y : Q_UV;
    this.loadQuant(this.qt[0], Q_Y[sel]);
    this.loadQuant(this.qt[1], chroma[sel]);
    this.loadQuant(this.qt[2], Q_Y[adv]);
    this.loadQuant(this.qt[3], chroma[adv]);

    this.words = toWords(frame.subarray(VIDEO_HEADER_SIZE));
    this.reg0 = this.words[0] ?? 0;
    this.reg1 = this.words[1] ?? 0;
    this.idx = 2;
    this.newbits = 32;
    this.dcY = this.dcCb = this.dcCr = 0;
    this.txb = this.tyb = 0;
    this.vqIndex.set([0, 1, 2, 3]);
    this.vqColor.set([0x008080, 0xff8080, 0x808080, 0xc08080]);
    this.dirtyMinX = this.dirtyMinY = Infinity;
    this.dirtyMaxX = this.dirtyMaxY = -Infinity;

    const endWord = Math.min(Math.floor(h.compressSize / 4), this.words.length);
    let blocks = 0;
    try {
      do {
        const code = this.reg0 >>> 28;
        if (code === 9) break; // frame end
        if (code & 8) {
          this.txb = (this.reg0 >>> 20) & 0xff;
          this.tyb = (this.reg0 >>> 12) & 0xff;
          this.skip(20);
        } else {
          this.skip(4);
        }
        switch (code & 7) {
          case 0: this.jpegTile(0); break;          // JPEG
          case 4: this.jpegTile(2); break;          // low-quality JPEG (pass-2 tables)
          case 2: this.pass2Tile(); break;          // JPEG delta vs previous frame
          case 5: this.vqTile(1, 0); break;         // VQ, 1 colour
          case 6: this.vqTile(2, 1); break;         // VQ, 2 colours
          case 7: this.vqTile(4, 2); break;         // VQ, 4 colours
          default:
            // Cannot continue without knowing the block length: stop.
            result.warning = `unknown block code ${code} after ${blocks} blocks`;
            this.idx = endWord;
            continue;
        }
        this.advanceTile();
        blocks++;
      } while (this.idx < endWord);
    } catch (e) {
      result.warning = `bitstream error after ${blocks} blocks: ${(e as Error).message}`;
    }
    result.updated = blocks > 0;
    if (this.dirtyMaxX >= this.dirtyMinX) {
      const x = this.dirtyMinX;
      const y = this.dirtyMinY;
      result.dirty = { x, y, w: Math.min(this.dirtyMaxX, w) - x, h: Math.min(this.dirtyMaxY, ht) - y };
    }
    return result;
  }

  private resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
    this.rgba32 = new Uint32Array(this.rgba.buffer, this.rgba.byteOffset, w * h);
    this.prevYuv = new Uint32Array(w * h);
  }

  private loadQuant(out: Int32Array, table: number[]): void {
    for (let i = 0; i < 64; i++) {
      // Scale factor fixed at 16: q*16/16, clamped to 1..255.
      let q = Math.trunc((table[i] * 16) / 16);
      if (q <= 0) q = 1;
      if (q > 255) q = 255;
      // Stored as a 16.16 multiplier, computed in binary32 like ASPEED's decoder.
      out[i] = Math.trunc(Math.fround(Math.fround(Math.fround(q * AAN[i >> 3]) * AAN[i & 7]) * 65536));
    }
  }

  // --- bit reader (MSB-first over little-endian 32-bit words) -------------

  private peek(k: number): number {
    return k === 0 ? 0 : this.reg0 >>> (32 - k);
  }

  private skip(k: number): void {
    if (k === 0) return;
    if (this.newbits - k <= 0) {
      const next = this.idx < this.words.length ? this.words[this.idx] : 0;
      const carry = this.newbits >= 32 ? 0 : next >>> this.newbits;
      this.reg0 = ((this.reg0 << k) | ((this.reg1 | carry) >>> (32 - k))) >>> 0;
      const sh = k - this.newbits;
      this.reg1 = sh >= 32 ? 0 : (next << sh) >>> 0;
      this.newbits = 32 + this.newbits - k;
      this.idx++;
    } else {
      this.reg0 = ((this.reg0 << k) | (this.reg1 >>> (32 - k))) >>> 0;
      this.reg1 = (this.reg1 << k) >>> 0;
      this.newbits -= k;
    }
  }

  /** Reads a k-bit JPEG magnitude-category value and sign-extends it. */
  private getSigned(k: number): number {
    let v = this.peek(k);
    if ((v & (1 << (k - 1))) === 0) v += 1 - (1 << k);
    this.skip(k);
    return (v << 16) >> 16;
  }

  private huff(t: HuffTable): number {
    const l = t.len[this.reg0 >>> 16];
    const code = this.peek(l);
    this.skip(l);
    return t.values[(l << 8) | ((code - t.minor[l]) & 0xff)];
  }

  // --- tile decoding ------------------------------------------------------

  private decodeBlock(dcT: number, acT: number, comp: 0 | 1 | 2, off: number): void {
    const c = this.coeff;
    c.fill(0, off, off + 64); // only this block's window is read by idct()
    const cat = (this.huff(HT_DC[dcT]) << 24) >> 24;
    const pred = comp === 0 ? this.dcY : comp === 1 ? this.dcCb : this.dcCr;
    if (cat === 0) {
      c[off] = pred;
    } else {
      const dc = pred + this.getSigned(cat);
      c[off] = dc;
      const wrapped = (dc << 16) >> 16; // predictor wraps at 16 bits
      if (comp === 0) this.dcY = wrapped; else if (comp === 1) this.dcCb = wrapped; else this.dcCr = wrapped;
    }
    const ac = HT_AC[acT];
    let k = 1;
    do {
      const sym = (this.huff(ac) << 24) >> 24;
      const size = sym & 0xf;
      const run = (sym >> 4) & 0xf;
      if (size === 0) {
        if (run !== 15) break;
        k += 16;
        continue;
      }
      k += run;
      c[off + DEZIGZAG[k]] = this.getSigned(size);
      k++;
    } while (k < 64);
  }

  /** AAN integer IDCT into `tile[off..off+63]`, level-shifted and range-limited. */
  private idct(off: number, q: Int32Array): void {
    const c = this.coeff;
    const ws = this.ws;
    // Dequantize: (coef * q16) >> 16 with the product truncated to 32 bits before
    // the shift, as in ASPEED's decoder. Constant multiplies are (a * b) >> 8.
    for (let col = 0; col < 8; col++) {
      const b = off + col;
      if ((c[b + 8] | c[b + 16] | c[b + 24] | c[b + 32] | c[b + 40] | c[b + 48] | c[b + 56]) === 0) {
        const dc = Math.imul(c[b], q[col]) >> 16;
        ws[col] = dc; ws[col + 8] = dc; ws[col + 16] = dc; ws[col + 24] = dc;
        ws[col + 32] = dc; ws[col + 40] = dc; ws[col + 48] = dc; ws[col + 56] = dc;
        continue;
      }
      let t0 = Math.imul(c[b], q[col]) >> 16;
      let t1 = Math.imul(c[b + 16], q[col + 16]) >> 16;
      let t2 = Math.imul(c[b + 32], q[col + 32]) >> 16;
      let t3 = Math.imul(c[b + 48], q[col + 48]) >> 16;
      const t10 = t0 + t2, t11 = t0 - t2, t13 = t1 + t3;
      const t12 = (Math.imul(t1 - t3, 362) >> 8) - t13;
      t0 = t10 + t13; t3 = t10 - t13; t1 = t11 + t12; t2 = t11 - t12;
      const t4 = Math.imul(c[b + 8], q[col + 8]) >> 16;
      const t5 = Math.imul(c[b + 24], q[col + 24]) >> 16;
      const t6 = Math.imul(c[b + 40], q[col + 40]) >> 16;
      const t7 = Math.imul(c[b + 56], q[col + 56]) >> 16;
      const z13 = t6 + t5, z10 = t6 - t5, z11 = t4 + t7, z12 = t4 - t7;
      const o7 = z11 + z13;
      const s11 = Math.imul(z11 - z13, 362) >> 8;
      const z5 = Math.imul(z10 + z12, 473) >> 8;
      const s10 = (Math.imul(z12, 277) >> 8) - z5;
      const s12 = (Math.imul(z10, -669) >> 8) + z5;
      const o6 = s12 - o7, o5 = s11 - o6, o4 = s10 + o5;
      ws[col] = t0 + o7; ws[col + 56] = t0 - o7;
      ws[col + 8] = t1 + o6; ws[col + 48] = t1 - o6;
      ws[col + 16] = t2 + o5; ws[col + 40] = t2 - o5;
      ws[col + 32] = t3 + o4; ws[col + 24] = t3 - o4;
    }
    const out = this.tile;
    const range = RANGE_LIMIT;
    for (let w = 0; w < 64; w += 8) {
      const o = off + w;
      const w0 = ws[w], w1 = ws[w + 1], w2 = ws[w + 2], w3 = ws[w + 3], w4 = ws[w + 4], w5 = ws[w + 5], w6 = ws[w + 6], w7 = ws[w + 7];
      const t10 = w0 + w4, t11 = w0 - w4, t13 = w2 + w6;
      const t12 = (Math.imul(w2 - w6, 362) >> 8) - t13;
      const t0 = t10 + t13, t3 = t10 - t13, t1 = t11 + t12, t2 = t11 - t12;
      const z13 = w5 + w3, z10 = w5 - w3, z11 = w1 + w7, z12 = w1 - w7;
      const t7 = z11 + z13;
      const s11 = Math.imul(z11 - z13, 362) >> 8;
      const z5 = Math.imul(z10 + z12, 473) >> 8;
      const s10 = (Math.imul(z12, 277) >> 8) - z5;
      const s12 = (Math.imul(z10, -669) >> 8) + z5;
      const t6 = s12 - t7, t5 = s11 - t6, t4 = s10 + t5;
      out[o] = range[384 + (((t0 + t7) >> 3) & 0x3ff)]; out[o + 7] = range[384 + (((t0 - t7) >> 3) & 0x3ff)];
      out[o + 1] = range[384 + (((t1 + t6) >> 3) & 0x3ff)]; out[o + 6] = range[384 + (((t1 - t6) >> 3) & 0x3ff)];
      out[o + 2] = range[384 + (((t2 + t5) >> 3) & 0x3ff)]; out[o + 5] = range[384 + (((t2 - t5) >> 3) & 0x3ff)];
      out[o + 4] = range[384 + (((t3 + t4) >> 3) & 0x3ff)]; out[o + 3] = range[384 + (((t3 - t4) >> 3) & 0x3ff)];
    }
  }

  private jpegTile(q: 0 | 2): void {
    const qY = this.qt[q];
    const qC = this.qt[q + 1];
    this.decodeBlock(0, 0, 0, 0); this.idct(0, qY);
    if (this.mode420 === 1) {
      this.decodeBlock(0, 0, 0, 64); this.idct(64, qY);
      this.decodeBlock(0, 0, 0, 128); this.idct(128, qY);
      this.decodeBlock(0, 0, 0, 192); this.idct(192, qY);
      this.decodeBlock(1, 1, 1, 256); this.idct(256, qC);
      this.decodeBlock(1, 1, 2, 320); this.idct(320, qC);
    } else {
      this.decodeBlock(1, 1, 1, 64); this.idct(64, qC);
      this.decodeBlock(1, 1, 2, 128); this.idct(128, qC);
    }
    this.putTile();
  }

  private pass2Tile(): void {
    this.decodeBlock(0, 0, 0, 0); this.idct(0, this.qt[2]);
    this.decodeBlock(1, 1, 1, 64); this.idct(64, this.qt[3]);
    this.decodeBlock(1, 1, 2, 128); this.idct(128, this.qt[3]);
    if (this.mode420 !== 0) return; // pass-2 data is ignored in YUV420 mode
    this.put444(true);
  }

  private vqTile(colors: number, bits: number): void {
    for (let i = 0; i < colors; i++) {
      const slot = (this.reg0 >>> 29) & 3;
      this.vqIndex[i] = slot;
      if ((this.reg0 >>> 31) === 0) {
        this.skip(3);
      } else {
        this.vqColor[slot] = (this.reg0 >>> 5) & 0xffffff;
        this.skip(27);
      }
    }
    if (this.mode420 === 0 && LITTLE_ENDIAN) return this.vq444(bits);
    const t = this.tile;
    for (let i = 0; i < 64; i++) {
      let color: number;
      if (bits === 0) {
        color = this.vqColor[this.vqIndex[0]];
      } else {
        color = this.vqColor[this.vqIndex[this.peek(bits)]];
        this.skip(bits);
      }
      t[i] = (color >>> 16) & 0xff;
      t[i + 64] = (color >>> 8) & 0xff;
      t[i + 128] = color & 0xff;
    }
    this.putTile();
  }

  /** 4:4:4 VQ: convert the (at most 4) palette entries once, then fill. */
  private vq444(bits: number): void {
    const n = 1 << bits;
    for (let i = 0; i < n; i++) {
      const col = this.vqColor[this.vqIndex[i]];
      this.vqYuv[i] = col & 0xffffff;
      this.vqRgba[i] = packRgba((col >>> 16) & 0xff, (col >>> 8) & 0xff, col & 0xff);
    }
    const x0 = this.txb * 8;
    const y0 = this.tyb * 8;
    const W = this.width;
    const cols = Math.min(8, W - x0);
    const rows = Math.min(8, this.height - y0);
    const out = this.rgba32;
    const prev = this.prevYuv;
    // The pixel bitmap must be consumed even for clipped tiles.
    for (let r = 0; r < 8; r++) {
      const rowBase = (y0 + r) * W + x0;
      for (let c = 0; c < 8; c++) {
        let s = 0;
        if (bits !== 0) {
          s = this.reg0 >>> (32 - bits);
          this.skip(bits);
        }
        if (r < rows && c < cols) {
          out[rowBase + c] = this.vqRgba[s];
          prev[rowBase + c] = this.vqYuv[s];
        }
      }
    }
    if (cols > 0 && rows > 0) this.markDirty(x0, y0, cols, rows);
  }

  private putTile(): void {
    if (this.mode420 === 0) this.put444(false);
    else this.put420();
  }

  private markDirty(x: number, y: number, w: number, h: number): void {
    if (x < this.dirtyMinX) this.dirtyMinX = x;
    if (y < this.dirtyMinY) this.dirtyMinY = y;
    if (x + w > this.dirtyMaxX) this.dirtyMaxX = x + w;
    if (y + h > this.dirtyMaxY) this.dirtyMaxY = y + h;
  }

  private put444(delta: boolean): void {
    const x0 = this.txb * 8;
    const y0 = this.tyb * 8;
    const W = this.width;
    const cols = Math.min(8, W - x0);
    const rows = Math.min(8, this.height - y0);
    if (cols <= 0 || rows <= 0) return;
    const t = this.tile;
    const prev = this.prevYuv;
    const accumulate = this.opts.pass2Mode === 'accumulate';
    const out32 = LITTLE_ENDIAN ? this.rgba32 : null;
    for (let r = 0; r < rows; r++) {
      const rowBase = (y0 + r) * W + x0;
      for (let c = 0; c < cols; c++) {
        const ti = (r << 3) + c;
        const p = rowBase + c;
        let y = t[ti], cb = t[ti + 64], cr = t[ti + 128];
        if (delta) {
          const pv = prev[p];
          if (accumulate) {
            y = ((pv >>> 16) + y - 128) & 0xff;
            cb = (((pv >>> 8) & 0xff) + cb - 128) & 0xff;
            cr = ((pv & 0xff) + cr - 128) & 0xff;
            prev[p] = (y << 16) | (cb << 8) | cr;
          } else {
            y = clamp255((pv >>> 16) + y - 128);
            cb = clamp255(((pv >>> 8) & 0xff) + cb - 128);
            cr = clamp255((pv & 0xff) + cr - 128);
          }
        } else {
          prev[p] = (y << 16) | (cb << 8) | cr;
        }
        if (out32) out32[p] = packRgba(y, cb, cr);
        else writeRgb(this.rgba, p * 4, y, cb, cr);
      }
    }
    this.markDirty(x0, y0, cols, rows);
  }

  private put420(): void {
    const x0 = this.txb * 16;
    const y0 = this.tyb * 16;
    const W = this.width;
    const cols = Math.min(16, W - x0);
    const rows = Math.min(16, this.height - y0);
    if (cols <= 0 || rows <= 0) return;
    const t = this.tile;
    const out = this.rgba;
    const out32 = LITTLE_ENDIAN ? this.rgba32 : null;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const y = t[(((r >> 3) << 1) + (c >> 3)) * 64 + ((r & 7) << 3) + (c & 7)];
        const ci = ((r >> 1) << 3) + (c >> 1);
        if (out32) out32[(y0 + r) * W + x0 + c] = packRgba(y, t[256 + ci], t[320 + ci]);
        else writeRgb(out, ((y0 + r) * W + x0 + c) * 4, y, t[256 + ci], t[320 + ci]);
      }
    }
    this.markDirty(x0, y0, cols, rows);
  }

  private advanceTile(): void {
    this.txb++;
    const unit = this.mode420 === 1 ? 16 : 8;
    if (this.txb >= this.gridW / unit) {
      this.tyb++;
      if (this.tyb >= this.gridH / unit) this.tyb = 0;
      this.txb = 0;
    }
  }
}

function writeRgb(out: Uint8ClampedArray, o: number, y: number, cb: number, cr: number): void {
  const yy = Y_TO_RGB[y];
  const b = yy + CB_TO_B[cb];
  const g = yy + CB_TO_G[cb] + CR_TO_G[cr];
  const r = yy + CR_TO_R[cr];
  // Indices stay below 895, where both range-limit tables agree.
  out[o] = r >= 0 ? RANGE_LIMIT[r + 256] : 0;
  out[o + 1] = g >= 0 ? RANGE_LIMIT[g + 256] : 0;
  out[o + 2] = b >= 0 ? RANGE_LIMIT[b + 256] : 0;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function roundUp(v: number, unit: number): number {
  return v % unit === 0 ? v : v + unit - (v % unit);
}

/** Packs bytes into little-endian 32-bit words, zero-padding the tail. */
function toWords(b: Uint8Array): Uint32Array {
  const out = new Uint32Array(Math.ceil(b.length / 4));
  const full = b.length >> 2;
  for (let i = 0; i < full; i++) {
    const j = i << 2;
    out[i] = (b[j] | (b[j + 1] << 8) | (b[j + 2] << 16) | (b[j + 3] << 24)) >>> 0;
  }
  for (let j = full << 2, s = 0; j < b.length; j++, s += 8) out[full] |= b[j] << s;
  return out;
}
