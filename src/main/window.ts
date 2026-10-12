/** The app window and the security settings that apply to it. */
import { BrowserWindow, Menu, screen, session } from 'electron';
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
  // Never larger than the screen: macOS treats a window that fills it as maximised, and the
  // console doesn't resize a maximised window to show the server's screen at actual size.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1100, area.width - 48),
    height: Math.min(820, area.height - 48),
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
