/**
 * Electron main process entry: owns all network access (protocol engine),
 * credentials and logging. The renderer only gets the narrow, validated API in
 * ipc.ts. Session logic lives in kvm-controller.ts.
 */
import { app, powerMonitor, type BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { registerIpc } from './ipc';
import { KvmController } from './kvm-controller';
import { LogBook } from './log';
import * as store from './store';
import { applySecurityPolicy, createMainWindow } from './window';

// Tests run the app against a throwaway profile directory. Must precede the
// single-instance lock, which is scoped to the profile directory.
if (process.env.OJV_USER_DATA) app.setPath('userData', process.env.OJV_USER_DATA);

let win: BrowserWindow | null = null;
const logs = new LogBook();
logs.onLine = (line) => win?.webContents.send('log', line);
const kvm = new KvmController({
  send: (channel, ...args) => win?.webContents.send(channel, ...args),
  log: logs.log,
  store,
});
/** Messages shown to the user once the window has loaded (see app:notices). */
const notices: string[] = [];

// Unexpected errors are logged and reported instead of killing the session
// (or, by default, showing a modal error box over the console).
function reportFatal(kind: string, e: unknown) {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  logs.log('error', `${kind}: ${msg}`);
  win?.webContents.send('app:error', e instanceof Error ? e.message : String(e));
}
process.on('uncaughtException', (e) => reportFatal('uncaught exception', e));
process.on('unhandledRejection', (e) => reportFatal('unhandled rejection', e));

/** Ends the KVM session and logs out of the BMC, but never holds up closing for long. */
const disconnectBriefly = () => Promise.race([kvm.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);

function openWindow() {
  const w = createMainWindow();
  win = w;
  // Closing while connected: log out of the BMC first. Quitting without it leaves the KVM
  // session open on the BMC, which has very few slots, and later connections then fail.
  let closing = false;
  w.on('close', (e) => {
    if (closing || !kvm.active) return;
    e.preventDefault();
    closing = true;
    logs.log('info', 'window closing: ending the KVM session first');
    void disconnectBriefly().finally(() => w.close());
  });
  // Windows shutdown or log-off does not emit before-quit: start ending the session as soon as
  // Windows asks, without holding up the shutdown (it usually completes well within the time).
  w.on('query-session-end', () => {
    if (!kvm.active) return;
    logs.log('info', 'Windows is ending the user session: ending the KVM session');
    void kvm.disconnect();
  });
  // The server's lock-key lights may have changed while the window was in the background.
  w.on('focus', () => kvm.syncLeds());
  w.on('closed', () => {
    if (win === w) win = null;
    void kvm.disconnect();
  });
  // A crashed or killed renderer: the session it was showing is closed (no UI
  // to control it) and the window reloads with an explanation.
  w.webContents.on('render-process-gone', (_e, d) => {
    logs.log('error', `window process gone: ${d.reason} (exit code ${d.exitCode})`);
    if (d.reason === 'clean-exit' || w.isDestroyed()) return;
    void kvm.disconnect();
    notices.push(`The window stopped unexpectedly (${d.reason}) and was reloaded. The KVM session was closed; connect again to continue.`);
    w.reload();
  });
  w.webContents.on('unresponsive', () => logs.log('warn', 'window is not responding'));
}

if (!app.requestSingleInstanceLock()) {
  // Another instance owns this profile (and its KVM session): hand over to it.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    logs.file = join(dir, `session-${new Date().toISOString().slice(0, 10)}.log`);
    logs.log('info', `IPMI Console ${app.getVersion()} (Electron ${process.versions.electron}) starting`);
    const settingsNotice = store.openSettings();
    if (settingsNotice) {
      logs.log('warn', `settings: ${settingsNotice}`);
      notices.push(settingsNotice);
    }
    applySecurityPolicy();
    registerIpc(() => win, kvm, logs, () => notices.splice(0));
    // Linux and macOS shutdown: delay it briefly to end the KVM session (Windows: see openWindow).
    powerMonitor.on('shutdown', (e?: Electron.Event) => {
      if (!kvm.active) return;
      e?.preventDefault();
      logs.log('info', 'system shutting down: ending the KVM session first');
      void disconnectBriefly().finally(() => app.quit());
    });
    openWindow();
  });
  app.on('child-process-gone', (_e, d) => logs.log('warn', `${d.type} process gone: ${d.reason}`));
}

app.on('window-all-closed', () => app.quit());
// Quitting by other routes (e.g. the OS) while connected: same rule as closing the window.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !kvm.active) return;
  e.preventDefault();
  quitting = true;
  logs.log('info', 'quitting: ending the KVM session first');
  void disconnectBriefly().finally(() => app.quit());
});
