// Text recognition: synthetic screens in the VGA font (colours, highlighted text,
// offsets, 9-dot cells, JPEG-like noise), the simulator's text through the real
// video codec, and the selection rules.
import { describe, expect, it } from 'vitest';
import { TextScreen } from '../src/sim/video';
import { readScreen, UNKNOWN } from '../src/textrec/recognize';
import { lineAt, selectionText, spans, wordAt } from '../src/textrec/selection';
import { VGA_8X16_HEX } from '../src/textrec/vga-8x16';
import { AspeedDecoder } from '../src/video/decoder';

type RGB = [number, number, number];

/** Draws text in the VGA 8x16 font into an RGBA buffer. */
function render(width: number, height: number, rows: Array<{ text: string; fg?: RGB; bg?: RGB }>, o: { cw?: number; ox?: number; oy?: number; bg?: RGB; noise?: number } = {}) {
  const cw = o.cw ?? 8;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const fill = o.bg ?? [0, 0, 0];
  for (let i = 0; i < width * height; i++) rgba.set([...fill, 255], i * 4);
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  rows.forEach(({ text, fg = [170, 170, 170], bg = fill }, r) => {
    [...text].forEach((ch, c) => {
      const code = ch.charCodeAt(0);
      for (let y = 0; y < 16; y++) {
        const bits = parseInt(VGA_8X16_HEX.substr((code * 16 + y) * 2, 2), 16);
        for (let x = 0; x < cw; x++) {
          let on = x < 8 && (bits & (0x80 >> x)) !== 0;
          if (o.noise && rand() < o.noise) on = !on;
          const p = ((o.oy ?? 0) + r * 16 + y) * width + (o.ox ?? 0) + c * cw + x;
          rgba.set([...(on ? fg : bg), 255], p * 4);
        }
      }
    });
  });
  return rgba;
}

const trimmed = (lines: string[]) => lines.map((l) => l.trimEnd()).filter(Boolean);

describe('text recognition', () => {
  it('reads a console screen in the VGA font exactly', () => {
    const text = ['root@server:~# ip -br addr', 'eth0  UP  192.168.1.20/24 fe80::1/64', 'Path: /var/log/{syslog,auth.log} | grep -i "error" > ~/out.txt'];
    const t = readScreen(render(1024, 768, text.map((x) => ({ text: x }))), 1024, 768)!;
    expect(t.grid).toMatchObject({ font: 'vga-8x16', cw: 8, ch: 16, cols: 128, rows: 48 });
    expect(trimmed(t.lines)).toEqual(text);
    expect(t.unknown).toBe(0);
  });

  it('handles colours, highlighted (inverse) text and box drawing', () => {
    const blue: RGB = [0, 0, 170];
    const t = readScreen(render(640, 400, [
      { text: '\xc9\xcd\xcd\xbb Setup', fg: [255, 255, 85], bg: blue },
      { text: 'Boot Order', fg: blue, bg: [170, 170, 170] },
      { text: 'Exit  F10', fg: [255, 255, 255], bg: blue },
    ], { bg: blue }), 640, 400)!;
    expect(trimmed(t.lines)).toEqual(['╔══╗ Setup', 'Boot Order', 'Exit  F10']);
  });

  it('finds a grid that does not start at the corner, and 9-dot text-mode cells', () => {
    const rows = [{ text: 'Offset grid works' }, { text: 'Second line 42' }];
    expect(trimmed(readScreen(render(800, 600, rows, { ox: 3, oy: 5 }), 800, 600)!.lines)).toEqual(['Offset grid works', 'Second line 42']);
    expect(readScreen(render(720, 400, rows, { cw: 9 }), 720, 400)!.grid.cw).toBe(9);
    expect(trimmed(readScreen(render(720, 400, rows, { cw: 9 }), 720, 400)!.lines)).toEqual(['Offset grid works', 'Second line 42']);
  });

  const pangram = 'The quick brown fox jumps over the lazy dog 0123456789';

  it('tolerates compression noise (a flipped pixel or so per character)', () => {
    const t = readScreen(render(1024, 768, [{ text: pangram }, { text: pangram.toUpperCase() }], { noise: 0.01 }), 1024, 768)!;
    expect(trimmed(t.lines)).toEqual([pangram, pangram.toUpperCase()]);
  });

  it('under heavy noise, marks what it cannot read and never guesses a wrong character', () => {
    // 3% of every cell's pixels flipped, blanks included: far harsher than real JPEG artefacts.
    const expected = [pangram, pangram.toUpperCase()];
    const t = readScreen(render(1024, 768, expected.map((text) => ({ text })), { noise: 0.03 }), 1024, 768)!;
    let right = 0;
    expected.forEach((line, r) => [...line].forEach((ch, c) => {
      const got = t.lines[r][c];
      expect([ch, UNKNOWN]).toContain(got);
      if (got === ch) right++;
    }));
    expect(right / (expected[0].length * 2)).toBeGreaterThan(0.95);
  });

  it('returns nothing for a screen without text', () => {
    const rgba = new Uint8ClampedArray(640 * 480 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([(i / 4) % 251, 80, 200, 255], i);
    expect(readScreen(rgba, 640, 480)).toBeNull();
  });

  it('is fast: a full 1024x768 screen in well under 50 ms', () => {
    const rows = Array.from({ length: 48 }, (_, i) => ({ text: `line ${i}: ${'abcdefghijklmnopqrstuvwxyz0123456789 '.repeat(3)}`.slice(0, 128) }));
    const rgba = render(1024, 768, rows, { noise: 0.01 });
    readScreen(rgba, 1024, 768);
    const t0 = performance.now();
    const t = readScreen(rgba, 1024, 768)!;
    // Coverage instrumentation slows everything several times over.
    expect(performance.now() - t0).toBeLessThan(process.env.npm_lifecycle_event === 'test:coverage' ? 500 : 50);
    expect(t.lines[47].startsWith('line 47:')).toBe(true);
  });

  it('reads the simulator screen through the real video encoder and decoder', () => {
    const screen = new TextScreen();
    screen.write(2, 1, 'Hello from the BMC: 10.0.20.11 uptime 42d');
    screen.write(5, 1, 'KEYBOARD TEST - type here');
    const d = new AspeedDecoder();
    const f = d.decode(screen.full());
    const t = readScreen(d.rgba, f.width, f.height)!;
    expect(t.grid.font).toBe('basic-8x8');
    expect(t.lines[2].trim()).toBe('Hello from the BMC: 10.0.20.11 uptime 42d');
    expect(t.lines[5].trim()).toBe('KEYBOARD TEST - type here');
    expect(t.unknown).toBe(0);
  });
});

describe('selection', () => {
  const lines = ['eth0  UP  192.168.1.20/24      ', 'lo    UNKNOWN 127.0.0.1/8      ', '                              '];
  it('selects a stream across lines, trimming trailing spaces', () => {
    expect(selectionText(lines, { r: 0, c: 10 }, { r: 1, c: 13 }, false)).toBe('192.168.1.20/24\nlo    UNKNOWN');
    // Either drag direction gives the same text.
    expect(selectionText(lines, { r: 1, c: 13 }, { r: 0, c: 10 }, false)).toBe('192.168.1.20/24\nlo    UNKNOWN');
  });
  it('selects a block (one column of a table)', () => {
    expect(selectionText(lines, { r: 0, c: 0 }, { r: 1, c: 4 }, true)).toBe('eth0\nlo');
    expect(spans({ r: 0, c: 6 }, { r: 1, c: 2 }, true, 30)).toEqual([{ r: 0, c0: 2, c1: 6 }, { r: 1, c0: 2, c1: 6 }]);
  });
  it('double-click takes the word (an address), triple-click the line', () => {
    expect(selectionText(lines, ...wordAt(lines, { r: 0, c: 14 })!, false)).toBe('192.168.1.20/24');
    expect(wordAt(lines, { r: 2, c: 3 })).toBeNull();
    expect(selectionText(lines, ...lineAt(lines, { r: 1, c: 3 }), false)).toBe('lo    UNKNOWN 127.0.0.1/8');
  });
  it('drops blank lines at the edges and keeps unreadable cells visible', () => {
    expect(selectionText(['', `a${UNKNOWN}c`, ''], { r: 0, c: 0 }, { r: 2, c: 5 }, false)).toBe(`a${UNKNOWN}c`);
  });
});
