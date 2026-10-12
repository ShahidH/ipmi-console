// Decode throughput over a folder of captured frames (as written by `probe`).
// Usage: bundle with esbuild, then node <bundle> <frames-dir> [iterations]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AspeedDecoder } from '../src/video/decoder';

const dir = process.argv[2];
const iters = Number(process.argv[3] ?? 12);
const frames = readdirSync(dir).filter((f) => f.endsWith('.bin')).sort().map((f) => new Uint8Array(readFileSync(join(dir, f))));
const bytes = frames.reduce((s, f) => s + f.length, 0);
const d = new AspeedDecoder();
const per: number[] = [];
for (let it = 0; it < iters; it++) {
  const t0 = performance.now();
  for (const f of frames) d.decode(f);
  const ms = performance.now() - t0;
  per.push(ms / frames.length);
  if (it < 2 || it === iters - 1) console.log(`iter ${it}: ${ms.toFixed(2)} ms total, ${(ms / frames.length).toFixed(3)} ms/frame`);
}
// Per-frame detail for the last pass (full frame vs incremental).
const detail = frames.map((f) => { const t0 = performance.now(); const r = d.decode(f); return { ms: performance.now() - t0, kb: f.length / 1024, dirty: r.dirty ? r.dirty.w * r.dirty.h : 0 }; });
detail.sort((a, b) => b.ms - a.ms);
console.log(`frames=${frames.length} avg ${(bytes / frames.length / 1024).toFixed(1)} KB; slowest: ${detail.slice(0, 3).map((x) => `${x.ms.toFixed(2)}ms/${x.kb.toFixed(0)}KB`).join(', ')}`);
console.log(`steady-state ms/frame: ${Math.min(...per.slice(2)).toFixed(3)}`);
