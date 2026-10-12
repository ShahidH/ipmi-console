/** The app window and the security settings that apply to it. */
import { BrowserWindow, Menu, session } from 'electron';
import { join } from 'node:path';

/** No remote content at all; fonts and scripts are bundled. */
export const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; worker-src 'self'";

/** Process-wide hardening; call once, after app ready. */
export function applySecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  // Only what the console needs: full screen, pointer lock (relative mouse) and keyboard lock.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'pointerLock' || perm === 'keyboardLock'));
  Menu.setApplicationMenu(null);
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: 'IPMI Console',
    backgroundColor: '#0F1114',
    // macOS takes the icon from the app bundle.
    ...(process.platform === 'darwin' ? {} : { icon: join(__dirname, 'icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  void win.loadFile(join(__dirname, '../renderer/index.html'));
  // The UI never navigates or opens windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}
