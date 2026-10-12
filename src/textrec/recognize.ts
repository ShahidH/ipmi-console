/**
 * Reads text back from a decoded screen. Text consoles (Linux, BIOS setup,
 * boot screens) draw a fixed-width bitmap font on a fixed grid, so every
 * occurrence of a character is the same pattern of pixels. Each cell is
 * reduced to a bit pattern (text vs background, whatever the colours) and
 * looked up among known fonts: exactly, or by the fewest differing bits, since
 * the BMC's JPEG compression can flip a few pixels. No OCR involved.
 *
 * Runs in the decoder worker, on demand (select/copy), at native resolution.
 */
import { FONT8X8 } from '../sim/font8x8';
import { VGA_8X16_HEX } from './vga-8x16';

export interface Font {
  name: string;
  /** Glyph width (always 8 here) and height in pixels. */
  w: number;
  h: number;
  /** Per glyph: the character it draws, and its rows packed into 32-bit words (MSB = leftmost pixel). */
  glyphs: Array<{ ch: string; bits: Uint32Array }>;
}

export interface Grid {
  font: string;
  /** Cell size: the glyph width, or 9 for VGA text mode's 9-dot cells. */
  cw: number;
  ch: number;
  ox: number;
  oy: number;
  cols: number;
  rows: number;
}

export interface ScreenText {
  grid: Grid;
  /** One string per row, exactly `cols` characters; unreadable cells are U+FFFD. */
  lines: string[];
  /** Cells that held something but matched no known glyph. */
  unknown: number;
}

export const UNKNOWN = '�';

/** Code page 437 characters beyond ASCII that consoles and BIOS screens use (box drawing, blocks). */
export const CP437: Record<number, string> = {
  0xb0: '░', 0xb1: '▒', 0xb2: '▓', 0xb3: '│', 0xb4: '┤', 0xb9: '╣', 0xba: '║', 0xbb: '╗', 0xbc: '╝', 0xbf: '┐',
  0xc0: '└', 0xc1: '┴', 0xc2: '┬', 0xc3: '├', 0xc4: '─', 0xc5: '┼', 0xc8: '╚', 0xc9: '╔', 0xca: '╩', 0xcb: '╦',
  0xcc: '╠', 0xcd: '═', 0xce: '╬', 0xd9: '┘', 0xda: '┌', 0xdb: '█', 0xdc: '▄', 0xdd: '▌', 0xde: '▐', 0xdf: '▀',
  0x10: '►', 0x11: '◄', 0x18: '↑', 0x19: '↓', 0x1a: '→', 0x1b: '←', 0x1e: '▲', 0x1f: '▼', 0xf8: '°', 0xfe: '■',
};

const wordsFor = (h: number) => Math.ceil(h / 4);

function pack(rows: number[]): Uint32Array {
  const out = new Uint32Array(wordsFor(rows.length));
  rows.forEach((r, i) => { out[i >> 2] |= (r & 0xff) << ((3 - (i & 3)) * 8); });
  return out;
}

function vgaFont(): Font {
  const glyphs: Font['glyphs'] = [];
  for (let c = 0; c < 256; c++) {
    const ch = c >= 0x21 && c <= 0x7e ? String.fromCharCode(c) : CP437[c];
    if (!ch) continue;
    const rows: number[] = [];
    for (let r = 0; r < 16; r++) rows.push(parseInt(VGA_8X16_HEX.substr((c * 16 + r) * 2, 2), 16));
    glyphs.push({ ch, bits: pack(rows) });
  }
  return { name: 'vga-8x16', w: 8, h: 16, glyphs };
}

/** The simulator's 8x8 font (public domain); its rows are least-significant-bit = leftmost. */
function font8x8(): Font {
  const glyphs: Font['glyphs'] = [];
  const rev = (b: number) => { let r = 0; for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i; return r; };
  for (let c = 0x21; c <= 0x7e; c++) {
    const rows: number[] = [];
    for (let r = 0; r < 8; r++) rows.push(rev(FONT8X8[(c - 0x20) * 8 + r]));
    glyphs.push({ ch: String.fromCharCode(c), bits: pack(rows) });
  }
  return { name: 'basic-8x8', w: 8, h: 8, glyphs };
}

let fonts: Font[] | undefined;
function knownFonts(): Font[] {
  fonts ??= [vgaFont(), font8x8()];
  return fonts;
}

const popcount = (v: number) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Matches cell patterns to a font's glyphs, remembering every pattern it has resolved. */
class Matcher {
  private exact = new Map<string, string>();
  private cache = new Map<string, string | null>();
  /** Most bits that may differ (JPEG noise) and the lead the best match needs over the next. */
  private readonly maxDist: number;

  constructor(private readonly font: Font) {
    for (const g of font.glyphs) {
      const k = g.bits.join(',');
      if (!this.exact.has(k)) this.exact.set(k, g.ch);
    }
    this.maxDist = Math.round(font.w * font.h * 0.08);
  }

  /**
   * The character for a cell's pattern, or null. `bits` has the text as 1s
   * (the minority colour, so highlighted dark-on-light text reads the same);
   * `other` is the opposite polarity, tried for exact matches only (solid blocks).
   */
  match(bits: Uint32Array, other: Uint32Array, exactOnly = false): string | null {
    const k = bits.join(',');
    const hit = this.exact.get(k) ?? this.exact.get(other.join(','));
    if (hit !== undefined) return hit;
    if (isCursor(bits, this.font.h) || isCursor(other, this.font.h)) return ' ';
    if (exactOnly) return null;
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    // An empty cell is a candidate too: a blank with a few noisy pixels is nearest to it,
    // while a real small glyph (a 4-pixel full stop) matches its own shape.
    let best = bits.reduce((n, w) => n + popcount(w), 0);
    let second = Infinity;
    let ch: string | null = ' ';
    for (const g of this.font.glyphs) {
      let d = 0;
      for (let i = 0; i < bits.length && d < second; i++) d += popcount(bits[i] ^ g.bits[i]);
      if (d < best) { second = best; best = d; ch = g.ch; }
      else if (d < second && g.ch !== ch) second = d;
    }
    // Strictly closest wins; a tie stays unreadable rather than guessed.
    const result = best <= this.maxDist && second > best ? ch : null;
    this.cache.set(k, result);
    return result;
  }
}

/**
 * The text cursor: a solid bar over the bottom rows of an otherwise empty cell
 * (how the Linux console and most BIOSes draw it). It is not a character.
 */
function isCursor(bits: Uint32Array, h: number): boolean {
  let lit = 0;
  for (let y = 0; y < h; y++) {
    const row = (bits[y >> 2] >>> ((3 - (y & 3)) * 8)) & 0xff;
    if (row === 0) { if (lit) return false; continue; }
    if (row !== 0xff) return false;
    lit++;
  }
  return lit > 0 && lit <= Math.max(2, h >> 2);
}

const matchers = new Map<string, Matcher>();
const matcherFor = (f: Font) => {
  let m = matchers.get(f.name);
  if (!m) matchers.set(f.name, (m = new Matcher(f)));
  return m;
};

/** Luminance contrast below this means an empty cell (no text). */
const MIN_CONTRAST = 48;

/**
 * Reduces one cell to text/background bits: pixels brighter than the midpoint of
 * the cell's darkest and brightest are 1. Returns null for a blank cell.
 */
function cellBits(rgba: Uint8Array | Uint8ClampedArray, width: number, x0: number, y0: number, w: number, h: number): Uint32Array | null {
  let lo = 255;
  let hi = 0;
  const lum = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let o = ((y0 + y) * width + x0) * 4;
    for (let x = 0; x < w; x++, o += 4) {
      const l = (rgba[o] * 2 + rgba[o + 1] * 5 + rgba[o + 2]) >> 3;
      lum[y * w + x] = l;
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
  }
  if (hi - lo < MIN_CONTRAST) return null;
  const mid = (hi + lo) >> 1;
  const out = new Uint32Array(wordsFor(h));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) if (lum[y * w + x] > mid) row |= 0x80 >> x;
    out[y >> 2] |= row << ((3 - (y & 3)) * 8);
  }
  return out;
}

function invert(bits: Uint32Array, h: number): Uint32Array {
  const out = new Uint32Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = ~bits[i] >>> 0;
  // Only the rows that exist: a partial last word keeps its unused bytes clear.
  const rem = h & 3;
  if (rem) out[out.length - 1] &= (0xffffffff << ((4 - rem) * 8)) >>> 0;
  return out;
}

function readCells(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, font: Font, g: Omit<Grid, 'font'>, sample?: number, exactOnly = false): ScreenText {
  const m = matcherFor(font);
  const lines: string[] = [];
  let unknown = 0;
  const rowStep = sample ? Math.max(1, Math.floor(g.rows / sample)) : 1;
  for (let r = 0; r < g.rows; r += rowStep) {
    let line = '';
    for (let c = 0; c < g.cols; c++) {
      const x = g.ox + c * g.cw;
      const y = g.oy + r * g.ch;
      if (x + font.w > width || y + font.h > height) { line += ' '; continue; }
      const raw = cellBits(rgba, width, x, y, font.w, font.h);
      if (!raw) { line += ' '; continue; }
      // Text is the minority colour (so highlighted dark-on-light text reads the same).
      const lit = raw.reduce((n, w) => n + popcount(w), 0);
      const inverted = invert(raw, font.h);
      const [bits, other] = lit * 2 <= font.w * font.h ? [raw, inverted] : [inverted, raw];
      const ch = m.match(bits, other, exactOnly);
      if (ch === null) unknown++;
      line += ch ?? UNKNOWN;
    }
    lines.push(line);
  }
  return { grid: { font: font.name, ...g }, lines, unknown };
}

const gridCache = new Map<string, Grid>();

/**
 * How well a grid placement reads, on a sample of rows: exactly matched cells
 * minus unmatched ones. Exact lookups only, so trying many placements stays cheap.
 */
function scoreGrid(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, font: Font, g: Omit<Grid, 'font'>, sample?: number): { score: number; known: number; unknown: number } {
  const t = readCells(rgba, width, height, font, g, sample, true);
  let known = 0;
  for (const l of t.lines) for (const ch of l) if (ch !== ' ' && ch !== UNKNOWN) known++;
  return { score: known - t.unknown * 2, known, unknown: t.unknown };
}

/** Clearly the right grid: enough matches, and few misses (JPEG noise causes some). */
const decisive = (r: { known: number; unknown: number }) => r.known >= 12 && r.known >= 3 * r.unknown;

/**
 * Finds the character grid: which font, cell size and offset make the most
 * cells readable. Remembered per screen size, so it is found once.
 *
 * Cheapest first: exact matches at the corner (where framebuffer consoles and
 * VGA text start), then near matches at the corner (heavily compressed video),
 * then exact matches at every other offset.
 */
function findGrid(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Grid | null {
  const key = `${width}x${height}`;
  const fontOf = (name: string) => knownFonts().find((f) => f.name === name)!;
  const cached = gridCache.get(key);
  // Still the same screen layout if some cells still match exactly (a wrong grid matches next to none).
  if (cached && scoreGrid(rgba, width, height, fontOf(cached.font), cached).known >= 4) return cached;

  const candidates = knownFonts().flatMap((font) => (font.w === 8 && font.h === 16 ? [8, 9] : [font.w]).map((cw) => ({ font, cw })));
  const place = (font: Font, cw: number, ox: number, oy: number) =>
    ({ cw, ch: font.h, ox, oy, cols: Math.floor((width - ox) / cw), rows: Math.floor((height - oy) / font.h) });
  const accept = (font: Font, g: Omit<Grid, 'font'>) => {
    const grid = { font: font.name, ...g };
    gridCache.set(key, grid);
    return grid;
  };

  let best: { font: Font; g: Omit<Grid, 'font'>; score: number } | null = null;
  // The corner, every row: exact lookups are cheap enough to read the whole screen.
  for (const { font, cw } of candidates) {
    const g = place(font, cw, 0, 0);
    const r = scoreGrid(rgba, width, height, font, g);
    if (decisive(r)) return accept(font, g);
    if (!best || r.score > best.score) best = { font, g, score: r.score };
  }
  // The corner with near matches, for heavily compressed video.
  for (const { font, cw } of candidates) {
    const g = place(font, cw, 0, 0);
    const t = readCells(rgba, width, height, font, g, 16);
    let known = 0;
    for (const l of t.lines) for (const ch of l) if (ch !== ' ' && ch !== UNKNOWN) known++;
    if (decisive({ known, unknown: t.unknown })) return accept(font, g);
  }
  for (const { font, cw } of candidates) {
    for (let oy = 0; oy < font.h; oy++) {
      for (let ox = 0; ox < cw; ox++) {
        if (!ox && !oy) continue;
        const g = place(font, cw, ox, oy);
        const r = scoreGrid(rgba, width, height, font, g, 12);
        if (decisive(r)) return accept(font, g);
        if (!best || r.score > best.score) best = { font, g, score: r.score };
      }
    }
  }
  return best && best.score >= 8 ? accept(best.font, best.g) : null;
}

/** Reads the whole screen as text, or null if no known font is on it. */
export function readScreen(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): ScreenText | null {
  const grid = findGrid(rgba, width, height);
  if (!grid) return null;
  const font = knownFonts().find((f) => f.name === grid.font)!;
  return readCells(rgba, width, height, font, grid);
}
