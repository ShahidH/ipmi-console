// Bundles main, preload, renderer (React + CSS + fonts), decoder worker and CLI with esbuild,
// then writes the third-party notices for everything that ships (scripts/notices.mjs).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { writeNotices } from './notices.mjs';

const cliOnly = process.argv.includes('--cli');
const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'es2022' };
/** Bundles that ship in the app; their metafiles drive the notices. */
const shipped = { ...common, metafile: true };
const jobs = [
  build({ ...common, entryPoints: ['src/cli/probe.ts'], outfile: 'dist/cli/probe.js', platform: 'node', format: 'cjs' }),
  build({ ...common, entryPoints: ['src/cli/sim.ts'], outfile: 'dist/cli/sim.js', platform: 'node', format: 'cjs' }),
];
if (!cliOnly) {
  rmSync('dist/renderer', { recursive: true, force: true });
  jobs.push(
    // The keychain module is native: it ships as a dependency in node_modules, not in the bundle.
    build({ ...shipped, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron', '@napi-rs/keyring'] }),
    build({ ...shipped, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
    build({
      ...shipped, entryPoints: { renderer: 'src/renderer/main.tsx' }, outdir: 'dist/renderer', platform: 'browser', format: 'iife',
      jsx: 'automatic', minify: true, loader: { '.woff2': 'file' }, assetNames: 'fonts/[name]',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({ ...shipped, entryPoints: ['src/renderer/decode-worker.ts'], outfile: 'dist/renderer/decode-worker.js', platform: 'browser', format: 'iife' }),
  );
  mkdirSync('dist/renderer', { recursive: true });
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  // The window icon on Linux and Windows; packaged apps also carry build/icon.* themselves.
  cpSync('build/icon-256.png', 'dist/main/icon.png');
}
const results = await Promise.all(jobs);
if (!cliOnly) {
  const bundled = writeNotices(results.filter((r) => r.metafile).map((r) => r.metafile), 'THIRD_PARTY_NOTICES.md', ['node_modules/@napi-rs/keyring']);
  console.log(`notices: ${bundled.join(', ')}`);
}
console.log('build ok');
