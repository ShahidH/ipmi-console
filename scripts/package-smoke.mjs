// Checks the packaged app (electron-builder --dir output in release/):
//  1. the app archive holds what the app needs and nothing it should not ship;
//  2. the full e2e suite passes against the packaged executable.
import { listPackage } from '@electron/asar';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('package.json', 'utf8')));
const product = pkg.build.productName;
const out = resolve(pkg.build.directories?.output ?? 'dist');
const layouts = {
  linux: { dir: 'linux-unpacked', exe: pkg.name, res: 'resources' },
  win32: { dir: 'win-unpacked', exe: `${product}.exe`, res: 'resources' },
  darwin: { dir: process.arch === 'arm64' ? 'mac-arm64' : 'mac', exe: `${product}.app/Contents/MacOS/${product}`, res: `${product}.app/Contents/Resources` },
};
const l = layouts[process.platform];
if (!l) throw new Error(`unsupported platform ${process.platform}`);
const exe = join(out, l.dir, l.exe);
const asar = join(out, l.dir, l.res, 'app.asar');
const resources = join(out, l.dir, l.res);
for (const f of [exe, asar]) if (!existsSync(f)) throw new Error(`missing ${f}: run npm run dist:dir first`);
// Licences must reach users of the installed app, not just the source repo.
for (const f of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) if (!existsSync(join(resources, f))) throw new Error(`missing ${f} in the packaged app`);
const notices = readFileSync(join(resources, 'THIRD_PARTY_NOTICES.md'), 'utf8');
for (const must of ['Mozilla Public License', '## react, react-dom, scheduler\n', '## ws\n', '## egoroof-blowfish\n', 'SIL OPEN FONT LICENSE', 'Copyright 2019 IBM Corp.', 'Copyright 2017 IBM Corp.']) {
  if (!notices.includes(must)) throw new Error(`THIRD_PARTY_NOTICES.md is missing: ${must}`);
}

const files = listPackage(asar, { isPack: false }).map((f) => f.replaceAll('\\', '/'));
const must = ['/dist/main/main.js', '/node_modules/@napi-rs/keyring/index.js', '/dist/main/icon.png', '/dist/preload/preload.js', '/dist/renderer/index.html', '/dist/renderer/renderer.js', '/dist/renderer/renderer.css', '/dist/renderer/decode-worker.js', '/package.json'];
const missing = must.filter((f) => !files.includes(f));
const fonts = files.filter((f) => f.startsWith('/dist/renderer/fonts/') && f.endsWith('.woff2'));
// The keychain module's native binary for this platform and CPU must sit outside the archive, where it can be loaded.
const binary = files.find((f) => f.startsWith(`/node_modules/@napi-rs/keyring-${process.platform}-${process.arch}`) && f.endsWith('.node'));
const keychainBinary = !!binary && existsSync(join(out, l.dir, l.res, 'app.asar.unpacked', binary));
const unwanted = files.filter((f) => f.endsWith('.map') || f.startsWith('/dist/cli') || f.startsWith('/src/') || f.startsWith('/tests/'));
const problems = [
  ...missing.map((f) => `missing from app.asar: ${f}`),
  ...(fonts.length < 4 ? [`expected 4 bundled fonts, found ${fonts.length}`] : []),
  ...(keychainBinary ? [] : ['the keychain module (@napi-rs/keyring) or its native binary is missing or packed into app.asar']),
  ...unwanted.map((f) => `should not ship: ${f}`),
];
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`app.asar: ${files.length} entries, contents OK`);

console.log(`running the e2e suite against ${exe}`);
const r = spawnSync('npx', ['playwright', 'test'], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, OJV_APP_PATH: exe } });
process.exit(r.status ?? 1);
