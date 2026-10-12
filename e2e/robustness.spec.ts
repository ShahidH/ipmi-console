// Clipboard typing, crash recovery, damaged settings and the single-instance lock.
import { readdirSync } from 'node:fs';
import { connectSeeded, expect, launchApp, simLog, test, typedText } from './fixtures';

// The system clipboard is shared: everything that uses it runs in one serial group.
test.describe('clipboard', () => {
  test.describe.configure({ mode: 'serial' });

test.describe('type clipboard', () => {
  test('types this computer\'s clipboard from the toolbar and with Ctrl+Alt+V', async ({ app, page, bmc }) => {
    await connectSeeded(page);
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo hi'));
    await page.getByRole('button', { name: 'Type clipboard' }).click();
    await expect(page.getByText('Typed 7 characters.')).toBeVisible();
    await expect.poll(() => typedText(bmc)).toContain('echo hi');

    await app.evaluate(({ clipboard }) => clipboard.writeText('xyz'));
    await page.getByLabel('Remote screen').click();
    await page.keyboard.press('Control+Alt+KeyV');
    await expect.poll(() => typedText(bmc)).toContain('xyz');
    // The shortcut itself never reaches the host as Ctrl+Alt+V.
    expect(simLog(bmc).join('\n')).not.toMatch(/KeyV.*ctrl/i);
  });

  test('refuses an over-long clipboard with a clear message', async ({ app, page }) => {
    await connectSeeded(page);
    await app.evaluate(({ clipboard }) => clipboard.writeText('a'.repeat(70000)));
    await page.getByRole('button', { name: 'Type clipboard' }).click();
    await expect(page.getByText('The clipboard is too long to type.')).toBeVisible();
  });
});

test.describe('copy text from the screen', () => {
  test('Ctrl+Alt+C, then double-click a word, drag, or Copy all', async ({ app, page }) => {
    await connectSeeded(page);
    await expect(page.locator('.statusbar')).toContainText('640 × 480');
    const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
    // The simulator draws " KEYBOARD TEST - type here..." on 8x8 row 5.
    const box = (await page.getByLabel('Remote screen').boundingBox())!;
    const at = (col: number, row: number) => ({ x: box.x + (col * 8 + 4) * (box.width / 640), y: box.y + (row * 8 + 4) * (box.height / 480) });
    // Shortcuts need the screen to have the keyboard, which it takes when the pointer moves onto it
    // (in a parallel run, another test's window can hold the system focus).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('.control-pill')).toContainText('Controlling server');

    await page.keyboard.press('Control+Alt+KeyC');
    await expect(page.locator('.select-bar')).toContainText('Selecting text');
    const w = at(3, 5);
    await page.mouse.dblclick(w.x, w.y);
    await expect.poll(clip).toBe('KEYBOARD');
    await expect(page.getByText('Copied: KEYBOARD')).toBeVisible();
    // Copying ends select mode and hands control back.
    await expect(page.locator('.control-pill')).toContainText('Controlling server');

    await page.getByRole('button', { name: 'Select text' }).click();
    // The drag must start on the selection, so wait for it to be on screen.
    await expect(page.locator('.select-bar')).toContainText('Selecting text');
    const a = at(10, 5), b = at(13, 5);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(clip).toBe('TEST');

    await page.keyboard.press('Control+Alt+KeyC');
    await expect(page.locator('.select-bar')).toContainText('Selecting text');
    await page.getByRole('button', { name: 'Copy all' }).click();
    await expect.poll(clip).toContain('KEYBOARD TEST - type here');

    await page.keyboard.press('Control+Alt+KeyC');
    // Escape reaches the selection only once it's on screen and has the keyboard.
    await expect(page.locator('.select-bar')).toContainText('Selecting text');
    await page.keyboard.press('Escape');
    await expect(page.locator('.select-bar')).toHaveCount(0);
  });
});
});

test.describe('window crash', () => {
  test('reloads the window, closes the session and explains', async ({ app, page }) => {
    await connectSeeded(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    // Playwright's page dies with the renderer; read the reloaded window through the main process.
    // Each probe gets its own short timeout: one sent while the renderer is down never answers.
    const windowText = () => Promise.race([
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.body.innerText') as Promise<string>).catch(() => ''),
      new Promise<string>((r) => setTimeout(() => r(''), 2000)),
    ]);
    await expect.poll(windowText, { timeout: 15_000 }).toContain('stopped unexpectedly');
    expect(await windowText()).toContain('Servers');
  });
});

test.describe('closing while connected', () => {
  test('logs out of the BMC before the app exits, so no KVM session is left open', async ({ app, page, bmc }) => {
    await connectSeeded(page);
    expect(bmc.logouts).toBe(0);
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    expect(bmc.logouts).toBe(1);
  });
});

test.describe('damaged settings file', () => {
  test.use({ settingsFile: '{"servers": [ truncated' });

  test('starts clean, keeps the damaged file and says so', async ({ page, profileDir }) => {
    await expect(page.getByRole('dialog', { name: 'Please note' })).toContainText('could not be read');
    expect(readdirSync(profileDir).some((n) => n.startsWith('settings.json.corrupt-'))).toBe(true);
  });
});

test.describe('single instance', () => {
  test('a second launch with the same profile exits and leaves the first running', async ({ app, page, profileDir }) => {
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    const second = await launchApp(profileDir).catch(() => null);
    if (second) {
      // It quits on its own straight away.
      await expect.poll(() => second.windows().length, { timeout: 10_000 }).toBe(0);
      await second.close().catch(() => {});
    }
    expect(app.windows().length).toBe(1);
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
  });
});
