// The real app (main + preload + React renderer + decoder worker) against the simulated BMC.
import { connectSeeded, expect, pressedKeys, SEEDED, simLog, test, typedText } from './fixtures';

test.describe('adding a server', () => {
  test.use({ seedServer: false });

  test('identifies the BMC before credentials, then saves and connects', async ({ page, bmc }) => {
    await expect(page.getByRole('heading', { name: 'Add your first server' })).toBeVisible();
    await page.getByRole('button', { name: 'Add server' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add server' });
    await dialog.getByLabel('BMC address').fill(`http://127.0.0.1:${bmc.webPort}/`);
    await expect(dialog.getByText('Found AMI MegaRAC SP (Java JViewer generation)')).toBeVisible();
    await dialog.getByLabel('Username').fill('admin');
    await dialog.getByLabel('Password', { exact: true }).fill('admin');
    await dialog.getByLabel('Name (optional)').fill('lab-bmc');
    await dialog.getByRole('button', { name: 'Save and connect' }).click();

    await expect(page.locator('.statusbar .state.ok')).toContainText('Connected');
    await expect(page.locator('.statusbar')).toContainText(/\d+ × \d+/);
    await expect(page.locator('.statusbar')).toContainText(/[1-9]\d* fps/);
    await expect(page.locator('.dock-chip')).toContainText('lab-bmc');
  });

  test('reports an address with no BMC', async ({ page }) => {
    await page.getByRole('button', { name: 'Add server' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add server' });
    await dialog.getByLabel('BMC address').fill('127.0.0.1:1');
    await expect(dialog.getByText('No answer from http://')).toBeVisible();
  });
});

test.describe('bundled assets', () => {
  test('fonts load from the app (no network) and the decoder worker draws video', async ({ page }) => {
    const loaded = await page.evaluate(async () => (await document.fonts.load('600 16px "IBM Plex Sans"')).length + (await document.fonts.load('14px "IBM Plex Mono"')).length);
    expect(loaded).toBe(2);
    await connectSeeded(page);
    // fps > 0 is reported by the worker only after it decoded and painted frames.
    await expect(page.locator('.statusbar')).toContainText(/[1-9]\d* fps/);
  });
});

test.describe('servers screen', () => {
  test('shows reachability and filters by search', async ({ page }) => {
    const card = page.getByRole('article', { name: SEEDED });
    await expect(card.getByText('Reachable')).toBeVisible();
    await page.keyboard.press('/');
    await page.keyboard.type('nothing-matches');
    await expect(card).toBeHidden();
    await page.getByRole('searchbox').fill('127.0.0');
    await expect(card).toBeVisible();
  });
});

test.describe('console session', () => {
  test('controls the server without a click; Ctrl+Alt+Shift pauses, a click resumes', async ({ page, bmc }) => {
    await connectSeeded(page);
    const pill = page.locator('.control-pill');
    // Keyboard straight after connecting, and the mouse on hover: no capture click.
    await expect(pill).toContainText('Controlling server');
    await page.keyboard.type('hello');
    await expect.poll(() => typedText(bmc)).toContain('hello');
    const box = (await page.getByLabel('Remote screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // The simulator logs mouse reports with a button or wheel change, so scroll (still no click).
    await page.mouse.wheel(0, -100);
    await expect.poll(() => bmc.events.some((e) => e.input?.kind === 'mouse' && (e.input as { wheel: number }).wheel !== 0)).toBe(true);

    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await expect(pill).toContainText('Paused');
    await page.keyboard.type('zz');
    await page.waitForTimeout(300);
    expect(typedText(bmc)).not.toContain('zz');

    await page.getByLabel('Remote screen').click();
    await expect(pill).toContainText('Controlling server');
    await page.keyboard.type('ok');
    await expect.poll(() => typedText(bmc)).toContain('ok');

    // The pill itself pauses too.
    await pill.click();
    await expect(pill).toContainText('Paused');
  });

  test('opens at actual size and asks for a window that fits the screen', async ({ app, page }) => {
    // Record the size the app asks for: some Linux window managers (e.g. WSLg) ignore
    // programmatic resizes, so the request is what can be checked everywhere.
    await page.waitForLoadState('load');
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const set = w.setContentSize.bind(w);
      w.setContentSize = (width: number, height: number) => {
        (globalThis as { fitRequest?: number[] }).fitRequest = [width, height];
        set(width, height);
      };
    });
    await connectSeeded(page);
    await expect(page.locator('.statusbar')).toContainText('640 × 480');
    await expect(page.getByRole('button', { name: 'Fit to window' })).toHaveAttribute('aria-pressed', 'false');
    const chrome = await page.evaluate(() => {
      const h = (sel: string) => document.querySelector<HTMLElement>(sel)!.offsetHeight;
      const vp = getComputedStyle(document.querySelector('.viewport')!);
      return h('.dock-strip') + h('.statusbar') + parseFloat(vp.paddingTop) + parseFloat(vp.paddingBottom);
    });
    // 640x480 at actual size, widened to the minimum that keeps the dock on one line.
    await expect.poll(() => app.evaluate(() => (globalThis as { fitRequest?: number[] }).fitRequest)).toEqual([760, 480 + chrome]);
  });

  test('Keys menu sends Ctrl+Alt+Del', async ({ page, bmc }) => {
    await connectSeeded(page);
    await page.getByRole('button', { name: 'Keys' }).click();
    await page.getByRole('menuitem', { name: 'Ctrl + Alt + Del' }).click();
    await expect.poll(() => pressedKeys(bmc)).toContain('Delete');
  });

  test('power actions run at once, without a confirmation dialog', async ({ page, bmc }) => {
    await connectSeeded(page);
    await page.getByRole('button', { name: 'Power' }).click();
    await page.getByRole('menuitem', { name: /Hard reset/ }).click();
    await expect(page.getByText(`Hard reset sent to ${SEEDED}.`)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => simLog(bmc).join('\n')).toContain('POWER CONTROL: hard reset');

    await page.getByRole('button', { name: 'Power' }).click();
    await page.getByRole('menuitem', { name: /Soft shutdown/ }).click();
    await expect.poll(() => simLog(bmc).join('\n')).toContain('POWER CONTROL: soft reset (ACPI)');
  });

  test('‹ Servers disconnects and returns to the server list', async ({ page }) => {
    await connectSeeded(page);
    await page.getByRole('button', { name: 'Servers', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    await expect(page.getByRole('article', { name: SEEDED })).toContainText('Just now');
  });

  test('asks again when the password is wrong', async ({ page }) => {
    await page.getByRole('article', { name: SEEDED }).getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('dialog', { name: 'Password' }).getByLabel(/Password for/).fill('wrong');
    await page.getByRole('dialog', { name: 'Password' }).getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText(/rejected the password/)).toBeVisible();
    await page.getByLabel(/rejected the password/).fill('admin');
    await page.getByRole('dialog', { name: 'Password' }).getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.statusbar .state.ok')).toContainText('Connected');
  });
});

test.describe('network drop', () => {
  test.use({ scenario: 'drop' });

  test('shows the reconnect panel, then recovers', async ({ page }) => {
    await connectSeeded(page);
    await expect(page.getByText(/Connection lost/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Attempt 1 of 8/)).toBeVisible();
    await page.getByRole('button', { name: 'Retry now' }).click();
    await expect(page.locator('.statusbar .state.ok')).toContainText('Connected', { timeout: 20_000 });
  });
});

test.describe('another user asks for access', () => {
  test.use({ scenario: 'kvm-in-use' });

  test('the answer reaches the BMC', async ({ page, bmc }) => {
    await connectSeeded(page);
    const dialog = page.getByRole('dialog', { name: 'KVM access request' });
    await expect(dialog).toContainText('operator (10.1.2.3)');
    await dialog.getByRole('button', { name: 'Allow view only' }).click();
    await expect.poll(() => simLog(bmc).join('\n')).toContain('KVM sharing answer: view only');
  });
});

test.describe('BMC refuses the session', () => {
  test.use({ scenario: 'max-sessions' });

  test('explains why and stays on the servers screen', async ({ page }) => {
    await page.getByRole('article', { name: SEEDED }).getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('dialog', { name: 'Password' }).getByLabel(/Password for/).fill('admin');
    await page.getByRole('dialog', { name: 'Password' }).getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Could not connect.')).toBeVisible();
    await expect(page.getByText(/Maximum number of KVM sessions/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
  });
});
