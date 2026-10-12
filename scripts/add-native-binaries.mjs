// Adds the keychain module's prebuilt binaries for other platforms or CPUs. npm installs only
// the one for the machine it runs on, so building the Intel and Apple silicon macOS apps on
// one Mac, or a Windows app on Linux, needs the others added first.
// Usage: node scripts/add-native-binaries.mjs darwin-x64 darwin-arm64 [win32-x64-msvc …]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync('node_modules/@napi-rs/keyring/package.json', 'utf8'));
for (const target of process.argv.slice(2)) {
  const name = `@napi-rs/keyring-${target}`;
  const dest = join('node_modules', name);
  if (existsSync(dest)) {
    console.log(`${name}: already installed`);
    continue;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'native-'));
  execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp, '--silent'], { stdio: 'ignore', shell: process.platform === 'win32' });
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
  cpSync(join(tmp, 'package'), dest, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${name}@${version}: added`);
}
