// README screenshots (`npm run screenshots`): the app against simulated BMCs, with
// invented server names. Skipped in normal test runs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findScenario } from '../src/sim/scenario';
import { SimBmc } from '../src/sim/server';
import { expect, launchApp, test } from './fixtures';

const OUT = resolve('.github/assets');

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 (npm run screenshots)');

test('README screenshots', async () => {
  mkdirSync(OUT, { recursive: true });
  const sims = await Promise.all([['demo', 8080], ['spx-438', 8081]].map(async ([name, webPort]) => {
    const b = new SimBmc(findScenario(name as string), { webPort: webPort as number });
    await b.listen();
    return b;
  }));
  const day = 86_400_000;
  const server = (id: string, name: string, host: string, port: number, family: string, ago: number) => ({
    id, name, host, webScheme: 'http', webPort: port, username: 'admin', profile: 'auto', family: 'auto',
    keyboardMode: 'auto', typingLayout: 'us', legacyTls: false, lastFamily: family, lastConnectedAt: Date.now() - ago,
  });
  const dir = mkdtempSync(join(tmpdir(), 'ipmi-console-shots-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    version: 1,
    servers: [
      server('a', 'storage-01', 'bmc-storage-01.lab', 8080, 'megarac-sp', 2 * 3_600_000),
      server('b', 'hypervisor-02', 'bmc-hv-02.lab', 8081, 'megarac-spx', day),
      server('c', 'backup-03', 'bmc-backup-03.lab', 8082, 'megarac-sp', 9 * day),
    ],
    pins: {}, fingerprints: {},
  }));
  const app = await launchApp(dir);
  try {
    await app.firstWindow();
    // The example *.lab hostnames resolve to this machine, where the simulators listen.
    await app.evaluate(() => {
      const dns = process.getBuiltinModule('node:dns') as typeof import('node:dns');
      const real = dns.lookup;
      (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) =>
        (real as (...a: unknown[]) => void)(host.endsWith('.lab') ? '127.0.0.1' : host, ...rest);
    });
    const page = await app.firstWindow();
    // Reachability was checked before the hostnames resolved: check again.
    await page.reload();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('article', { name: 'storage-01' }).getByText('Reachable')).toBeVisible();
    await expect(page.getByRole('article', { name: 'backup-03' }).getByText('No response')).toBeVisible();
    await page.screenshot({ path: join(OUT, 'servers.png') });

    await page.getByRole('button', { name: 'Add server' }).first().click();
    await page.getByLabel('BMC address').fill('bmc-storage-01.lab:8080');
    await page.getByLabel('Username').fill('admin');
    await expect(page.getByText(/Found AMI MegaRAC SP/)).toBeVisible();
    await page.screenshot({ path: join(OUT, 'add-server.png') });
    await page.keyboard.press('Escape');

    await page.getByRole('article', { name: 'storage-01' }).getByRole('button', { name: 'Connect' }).click();
    await page.getByLabel(/Password for/).fill('admin');
    await page.getByRole('dialog', { name: 'Password' }).getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.statusbar .state.ok')).toContainText('Connected');
    await expect(page.locator('.statusbar')).toContainText('800 × 600');
    // Scaled to the window, as the README shows it.
    await page.getByRole('button', { name: 'Fit to window' }).click();
    // The test window is not the OS's focused window, so give the screen focus as a user's would have.
    await page.getByLabel('Remote screen').focus();
    await page.mouse.move(5, 5);
    await expect(page.locator('.control-pill')).toContainText('Controlling server');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, 'console.png') });
  } finally {
    await app.close();
    await Promise.all(sims.map((s) => s.close()));
    rmSync(dir, { recursive: true, force: true });
  }
});
