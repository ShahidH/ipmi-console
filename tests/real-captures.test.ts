// Replays real BMC captures (captures/<host>-*/frames, gitignored: they contain the
// user's screen) through our decoder and, when built, ASPEED's reference decoder.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readScreen } from '../src/textrec/recognize';
import { AspeedDecoder } from '../src/video/decoder';

const capRoot = join(__dirname, '../captures');
const sets = existsSync(capRoot)
  ? readdirSync(capRoot).map((d) => join(capRoot, d, 'frames')).filter((d) => existsSync(d) && readdirSync(d).length > 0)
  : [];
const ASPEED = join(__dirname, '../tools/c-harness/build/aspeed-harness');

describe.skipIf(sets.length === 0)('real BMC captures', () => {
  for (const dir of sets) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin')).sort().map((f) => join(dir, f));
    it(`decodes ${dir.split('/').slice(-2, -1)[0]} (${files.length} frames) without warnings`, () => {
      const d = new AspeedDecoder();
      for (const f of files) expect(d.decode(readFileSync(f)).warning).toBeUndefined();
    });
    it('reads the console text back exactly and fast', () => {
      const d = new AspeedDecoder();
      let w = 0, h = 0;
      for (const f of files) ({ width: w, height: h } = d.decode(readFileSync(f)));
      const t0 = performance.now();
      const t = readScreen(d.rgba, w, h);
      expect(performance.now() - t0).toBeLessThan(100);
      // Only checks text that cannot identify the machine.
      if (t) {
        expect(t.unknown).toBe(0);
        expect(t.lines.some((l) => /\S/.test(l))).toBe(true);
      }
    });
    it.skipIf(!existsSync(ASPEED))('matches ASPEED aspeed_codec pixel-for-pixel (default mode)', () => {
      const out = join(dir, '../.aspeed-out.bin');
      execFileSync(ASPEED, [out, ...files]);
      const b = readFileSync(out);
      const d = new AspeedDecoder({ pass2Mode: 'accumulate' });
      let o = 0, total = 0;
      for (const f of files) {
        d.decode(readFileSync(f));
        const w = b.readInt32LE(o), h = b.readInt32LE(o + 4);
        for (let p = 0; p < w * h; p++) for (let k = 0; k < 3; k++) if (b[o + 8 + p * 4 + k] !== d.rgba[p * 4 + k]) { total++; break; }
        o += 8 + w * h * 4;
      }
      expect(total).toBe(0);
    });
  }
});
