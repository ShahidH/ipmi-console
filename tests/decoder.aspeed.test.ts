// Differential test: our decoder (default mode) vs ASPEED's aspeed_codec C decoder,
// compiled natively. Runs only when gcc is installed and OJV_ASPEED_CODEC points at
// an aspeed_codec source directory (the one containing decoder.c).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AspeedDecoder } from '../src/video/decoder';
import { FrameBuilder, randomBlock, rng, type FrameSpec } from './helpers/aspeed-encoder';

const root = join(__dirname, '..');
const SRC = process.env.OJV_ASPEED_CODEC ?? '';
const BIN = join(root, 'tools/c-harness/build/aspeed-harness');
const HAVE = !!SRC && existsSync(join(SRC, 'decoder.c')) && (() => { try { execFileSync('gcc', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function build() {
  if (existsSync(BIN)) return;
  // One correction to the reference copy: its VQ code sets default palette slot 1 to
  // 0xFF8000; the video engine's default (and our decoder's) is 0xFF8080.
  const dir = join(root, 'tools/c-harness/build');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'decoder.c'), readFileSync(join(SRC, 'decoder.c'), 'utf8').replace('vq->Color[1] = 0xFF8000;', 'vq->Color[1] = 0xFF8080;'));
  execFileSync('gcc', ['-O2', '-w', '-include', join(root, 'tools/c-harness/prelude.h'), '-I', join(root, 'tools/c-harness/stub'), '-I', SRC,
    '-o', BIN, join(root, 'tools/c-harness/harness.c'), join(dir, 'decoder.c'), '-lm']);
}

function runC(frames: Uint8Array[]) {
  build();
  const dir = mkdtempSync(join(tmpdir(), 'ojv-aspeed-'));
  const files = frames.map((f, i) => { const p = join(dir, `f${i}.bin`); writeFileSync(p, f); return p; });
  execFileSync(BIN, [join(dir, 'out'), ...files]);
  const b = readFileSync(join(dir, 'out'));
  const res = [];
  for (let o = 0; o < b.length;) {
    const w = b.readInt32LE(o), h = b.readInt32LE(o + 4);
    res.push({ w, h, rgba: b.subarray(o + 8, o + 8 + w * h * 4) });
    o += 8 + w * h * 4;
  }
  return res;
}

/** Frames without pass-2 tiles (our default pass-2 reconstruction differs by design). */
function frameNoPass2(seed: number, spec: FrameSpec, tiles: number): Uint8Array {
  const r = rng(seed);
  const fb = new FrameBuilder(spec);
  const n = spec.mode420 ? 6 : 3;
  const unit = spec.mode420 ? 16 : 8;
  for (let i = 0; i < tiles; i++) {
    const pos: [number, number] | undefined = r() < 0.3 ? [Math.floor(r() * spec.width / unit), Math.floor(r() * spec.height / unit)] : undefined;
    const k = r();
    if (k < 0.45) fb.jpeg(Array.from({ length: n }, () => randomBlock(r, 0.15, 120)), { pos });
    else if (k < 0.6) fb.jpeg(Array.from({ length: n }, () => randomBlock(r, 0.15, 120)), { pos, low: true });
    else if (!spec.mode420) {
      const c = [1, 2, 4][Math.floor(r() * 3)];
      fb.vq(Array.from({ length: c }, () => [Math.floor(r() * 4), r() < 0.6 ? Math.floor(r() * 0x1000000) : undefined] as [number, number | undefined]),
        Array.from({ length: 64 }, () => Math.floor(r() * c)), pos);
    } else fb.jpeg(Array.from({ length: n }, () => randomBlock(r, 0.05, 40)), { pos });
  }
  return fb.end();
}

function diffStats(c: { w: number; h: number; rgba: Buffer }, d: AspeedDecoder) {
  let px = 0, maxd = 0;
  for (let p = 0; p < c.w * c.h; p++) {
    let m = 0;
    for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(c.rgba[p * 4 + k] - d.rgba[p * 4 + k]));
    if (m) px++;
    maxd = Math.max(maxd, m);
  }
  return { px, maxd };
}

describe.skipIf(!HAVE)('decoder vs ASPEED aspeed_codec (C reference)', () => {
  const sweep: FrameSpec[] = [];
  for (let sel = 0; sel < 12; sel++) for (const m of [0, 1] as const) sweep.push({ width: 256, height: 128, mode420: m, tableSelector: sel, advanceSelector: 11 - sel, mapping: sel & 1 });
  for (const spec of sweep) {
    it(`selector ${spec.tableSelector}/${spec.advanceSelector} mode420=${spec.mode420} mapping=${spec.mapping}`, () => {
      const f = frameNoPass2(spec.tableSelector! * 31 + spec.mode420, spec, 300);
      const [c] = runC([f]);
      const d = new AspeedDecoder();
      const r = d.decode(f);
      expect(r.warning).toBeUndefined();
      const s = diffStats(c, d);
      expect(s, JSON.stringify(s)).toEqual({ px: 0, maxd: 0 });
    });
  }
});

describe.skipIf(!HAVE)('pass-2 delta tiles vs ASPEED', () => {
  it("pass2Mode 'accumulate' matches aspeed_codec, across frames", () => {
    const spec: FrameSpec = { width: 128, height: 64, mode420: 0, tableSelector: 5, advanceSelector: 7 };
    const r = rng(99);
    const frames = [0, 1, 2].map(() => {
      const fb = new FrameBuilder(spec);
      for (let i = 0; i < 128; i++) {
        if (r() < 0.5) fb.jpeg([0, 1, 2].map(() => randomBlock(r, 0.1, 60)), { pos: [i % 16, Math.floor(i / 16)] });
        else fb.pass2([0, 1, 2].map(() => randomBlock(r, 0.1, 30)), [i % 16, Math.floor(i / 16)]);
      }
      return fb.end();
    });
    const c = runC(frames);
    const d = new AspeedDecoder({ pass2Mode: 'accumulate' });
    frames.forEach((f, i) => {
      d.decode(f);
      expect(diffStats(c[i], d)).toEqual({ px: 0, maxd: 0 });
    });
  });
});
