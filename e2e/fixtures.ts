/**
 * Test fixtures: each test gets its own simulated BMC (src/sim) and its own
 * Electron app instance with a throwaway profile directory.
 */
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findScenario } from '../src/sim/scenario';
import { SimBmc } from '../src/sim/server';

export const SEEDED = 'sim-bmc';

interface Fixtures {
  /** Simulator scenario name (src/sim/scenario.ts). */
  scenario: string;
  /** Pre-save a server pointing at the simulator (no stored password). */
  seedServer: boolean;
  /** Raw settings.json content to start with, instead of seedServer. */
  settingsFile: string | undefined;
  /** The profile directory the app runs with. */
  profileDir: string;
  bmc: SimBmc;
  app: ElectronApplication;
  page: Page;
}

export const test = base.extend<Fixtures>({
  scenario: ['sp-195', { option: true }],
  seedServer: [true, { option: true }],
  settingsFile: [undefined, { option: true }],
  // eslint-disable-next-line no-empty-pattern
  profileDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'ipmi-console-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  bmc: async ({ scenario }, use) => {
    const bmc = new SimBmc(findScenario(scenario));
    await bmc.listen();
    await use(bmc);
    await bmc.close();
  },
  app: async ({ bmc, seedServer, settingsFile, profileDir: dir }, use) => {
    if (settingsFile !== undefined) {
      writeFileSync(join(dir, 'settings.json'), settingsFile);
    } else if (seedServer) {
      const server = { id: 'sim', name: SEEDED, host: '127.0.0.1', webScheme: 'http', webPort: bmc.webPort, username: 'admin', profile: 'auto', family: 'auto', keyboardMode: 'auto', legacyTls: false };
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ servers: [server], pins: {}, fingerprints: {} }));
    }
    const app = await launchApp(dir);
    await use(app);
    await app.close().catch(() => {});
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect };

/**
 * Starts the app with a profile directory. OJV_APP_PATH runs a packaged build
 * (see `npm run test:package`) instead of the development tree.
 */
export function launchApp(profileDir: string): Promise<ElectronApplication> {
  const env = { ...process.env, OJV_USER_DATA: profileDir } as Record<string, string>;
  const packaged = process.env.OJV_APP_PATH;
  return packaged ? electron.launch({ executablePath: packaged, args: [], env }) : electron.launch({ args: ['.'], env });
}

/** Connects to the seeded server, answering the password prompt. */
export async function connectSeeded(page: Page, password = 'admin') {
  await page.getByRole('article', { name: SEEDED }).getByRole('button', { name: 'Connect' }).click();
  const dialog = page.getByRole('dialog', { name: 'Password' });
  await dialog.getByLabel(/Password for/).fill(password);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.statusbar .state.ok')).toContainText('Connected');
}

/** Text the simulated host received as key presses (US layout). */
export function typedText(bmc: SimBmc): string {
  return bmc.events
    .filter((e) => e.kind === 'input' && e.input?.kind === 'key' && e.input.down && e.input.char)
    .map((e) => (e.input as { char: string }).char)
    .join('');
}

/** Names of keys the simulated host saw pressed. */
export function pressedKeys(bmc: SimBmc): string[] {
  return bmc.events.filter((e) => e.kind === 'input' && e.input?.kind === 'key' && e.input.down).map((e) => (e.input as { name: string }).name);
}

export function simLog(bmc: SimBmc): string[] {
  return bmc.events.map((e) => e.msg);
}
