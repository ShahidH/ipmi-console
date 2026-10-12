/**
 * Video sources for the simulator:
 *  - TextScreen: a synthetic text console (YUV 4:4:4, 8x8 VQ tiles: one per
 *    8x8 character, two per VGA 8x16 character). Only changed cells are sent,
 *    as positioned (skip-coded) tiles, which exercises delta decoding. The
 *    simulator writes typed text and mouse state onto it, so input can be
 *    checked visually end-to-end.
 *  - CaptureSource: replays real frames captured by the probe.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVideoHeader } from '../video/decoder';
import { FrameBuilder } from './encoder';
import { CP437 } from '../textrec/recognize';
import { VGA_8X16_HEX } from '../textrec/vga-8x16';
import { glyph } from './font8x8';

export interface VideoSource {
  readonly width: number;
  readonly height: number;
  /** A complete frame (start, GET_FULL_SCREEN, refresh). */
  full(): Uint8Array;
  /** The next frame of the stream, or null when nothing changed. */
  next(): Uint8Array | null;
  /** A key the server received (USB usage), for screens that react to the keyboard. */
  key?(usage: number): void;
}

/** YCbCr colours (BT.601 limited range) packed as Y<<16 | Cb<<8 | Cr. */
export const COLOR = {
  blue: 0x29f06e, white: 0xeb8080, grey: 0xb48080, black: 0x108080, yellow: 0xd21092,
  green: 0x913622, cyan: 0xaaa610, red: 0x515af0, darkgrey: 0x5a8080,
  /** The 16-colour VGA palette's blue (#0000AA) and light grey (#AAAAAA). */
  vgaBlue: 0x21cb74, vgaGrey: 0xa28080,
} as const;

export interface Cell { ch: string; fg: number; bg: number }

/**
 * Text cells: '8x8' is 80x60 cells at 640x480 (the simulator's test console);
 * 'vga' is 100x37 cells of the standard VGA 8x16 font at 800x600, as firmware setup screens use.
 */
export type TextFont = '8x8' | 'vga';

const CP437_CODE = new Map(Object.entries(CP437).map(([code, ch]) => [ch, Number(code)]));
const vgaRows = new Map<string, number[]>();
/** 16 rows of the VGA glyph for a character, most significant bit leftmost. */
function vgaGlyph(ch: string): number[] {
  let rows = vgaRows.get(ch);
  if (!rows) {
    const c = ch.charCodeAt(0);
    const code = c >= 0x20 && c <= 0x7e ? c : CP437_CODE.get(ch) ?? 0x3f;
    rows = Array.from({ length: 16 }, (_, r) => parseInt(VGA_8X16_HEX.substr((code * 16 + r) * 2, 2), 16));
    vgaRows.set(ch, rows);
  }
  return rows;
}

export class TextScreen implements VideoSource {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  /** Cell height in 8-pixel tile rows. */
  private readonly tilesHigh: number;
  private cells: Cell[];
  private sent: Cell[] | null = null;

  constructor(private readonly bg: number = COLOR.blue, readonly font: TextFont = '8x8') {
    const vga = font === 'vga';
    this.width = vga ? 800 : 640;
    this.height = vga ? 600 : 480;
    this.cols = this.width / 8;
    this.tilesHigh = vga ? 2 : 1;
    this.rows = Math.floor(this.height / (8 * this.tilesHigh));
    this.cells = Array.from({ length: this.cols * this.rows }, () => ({ ch: ' ', fg: COLOR.grey, bg }));
  }

  clear() {
    for (const c of this.cells) Object.assign(c, { ch: ' ', fg: COLOR.grey, bg: this.bg });
  }

  /** Writes text at a cell position, clipped to the line. */
  write(row: number, col: number, text: string, fg: number = COLOR.grey, bg: number = this.bg) {
    if (row < 0 || row >= this.rows) return;
    // The 8x8 font is ASCII-only: map common typographic characters.
    if (this.font === '8x8') text = text.replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2192/g, '>');
    for (let i = 0; i < text.length && col + i < this.cols; i++) {
      if (col + i < 0) continue;
      Object.assign(this.cells[row * this.cols + col + i], { ch: text[i], fg, bg });
    }
  }

  get(row: number, col: number): Cell {
    return { ...this.cells[row * this.cols + col] };
  }

  set(row: number, col: number, c: Cell) {
    Object.assign(this.cells[row * this.cols + col], c);
  }

  /** Writes text and blanks the rest of the line. */
  line(row: number, text: string, fg: number = COLOR.grey, bg: number = this.bg) {
    this.write(row, 0, text.padEnd(this.cols).slice(0, this.cols), fg, bg);
  }

  full(): Uint8Array {
    const fb = new FrameBuilder({ width: this.width, height: this.height, mode420: 0 });
    for (let t = 0; t < this.height / 8; t++) {
      const row = Math.floor(t / this.tilesHigh);
      for (let col = 0; col < this.cols; col++) {
        // Below the last text row (VGA: 37 rows fill 592 of 600 lines).
        if (row >= this.rows) fb.vq([[0, this.bg]], []);
        else this.tile(fb, this.cells[row * this.cols + col], t % this.tilesHigh);
      }
    }
    this.sent = this.cells.map((c) => ({ ...c }));
    return fb.end();
  }

  next(): Uint8Array | null {
    if (!this.sent) return this.full();
    const fb = new FrameBuilder({ width: this.width, height: this.height, mode420: 0 });
    const changed: number[] = [];
    this.cells.forEach((c, i) => {
      const s = this.sent![i];
      if (s.ch === c.ch && s.fg === c.fg && s.bg === c.bg) return;
      changed.push(i);
      this.sent![i] = { ...c };
    });
    if (!changed.length) return null;
    // Tiles in screen order: each cell row is tilesHigh tile rows.
    let i = 0;
    while (i < changed.length) {
      const row = Math.floor(changed[i] / this.cols);
      let j = i;
      while (j < changed.length && Math.floor(changed[j] / this.cols) === row) j++;
      for (let half = 0; half < this.tilesHigh; half++) {
        for (let k = i; k < j; k++) this.tile(fb, this.cells[changed[k]], half, [changed[k] % this.cols, row * this.tilesHigh + half]);
      }
      i = j;
    }
    return fb.end();
  }

  /** One 8x8 tile of a cell: the top or bottom half of a VGA cell. */
  private tile(fb: FrameBuilder, c: Cell, half: number, pos?: [number, number]) {
    const pixels: number[] = [];
    let any = false;
    if (this.font === 'vga') {
      const g = vgaGlyph(c.ch);
      for (let r = 0; r < 8; r++) for (let x = 0; x < 8; x++) {
        const on = (g[half * 8 + r] >> (7 - x)) & 1;
        pixels.push(on);
        any ||= on === 1;
      }
    } else {
      const g = glyph(c.ch);
      for (let r = 0; r < 8; r++) for (let x = 0; x < 8; x++) pixels.push((g[r] >> x) & 1);
      any = g.some((b) => b !== 0);
    }
    if (!any) return fb.vq([[0, c.bg]], [], pos);
    fb.vq([[0, c.bg], [1, c.fg]], pixels, pos);
  }
}

/** Replays frames captured by `probe` (captures/<host>-<time>/frames). */
export class CaptureSource implements VideoSource {
  readonly width: number;
  readonly height: number;
  private readonly frames: Uint8Array[];
  private readonly fullIndex: number;
  private i = 0;

  constructor(dir: string) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin')).sort();
    if (!files.length) throw new Error(`no frames in ${dir}`);
    this.frames = files.map((f) => new Uint8Array(readFileSync(join(dir, f))));
    const h = parseVideoHeader(this.frames[0]);
    this.width = h.sourceWidth;
    this.height = h.sourceHeight;
    // A full frame covers every tile (NumberOfMB = whole grid) or is the largest one.
    const unit = h.mode420 ? 16 : 8;
    const grid = Math.ceil(h.sourceWidth / unit) * Math.ceil(h.sourceHeight / unit);
    let idx = this.frames.findIndex((f) => parseVideoHeader(f).numberOfMB === grid);
    if (idx < 0) idx = this.frames.reduce((best, f, k) => (f.length > this.frames[best].length ? k : best), 0);
    this.fullIndex = idx;
    this.i = idx;
  }

  full(): Uint8Array {
    this.i = this.fullIndex + 1;
    return this.frames[this.fullIndex];
  }

  next(): Uint8Array | null {
    if (this.i >= this.frames.length) this.i = this.fullIndex;
    return this.frames[this.i++];
  }
}
