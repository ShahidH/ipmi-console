/**
 * The IPC boundary. Every handler checks the sender is our own window and
 * validates its arguments before anything reaches the controller or store:
 * the renderer is treated as untrusted input.
 */
import { clipboard, dialog, ipcMain, screen, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { readFileSync } from 'node:fs';
import { MAX_TYPE_TEXT, type DetectResult, type TypeClipboardResult } from '../shared/api';
import { detectFamily, FAMILY_NAMES, SUPPORTED_FAMILIES } from '../protocol/detect';
import type { KvmController } from './kvm-controller';
import type { LogBook } from './log';
import { tcpReachable } from './reachability';
import { deleteServer, getPin, getServer, listServers, setPin, upsertServer } from './store';
import { CHORD_NAMES, InvalidArgument, num, oneOf, parseServerInput, POWER_ACTIONS, str, TYPING_LAYOUTS } from './validate';

export function registerIpc(getWindow: () => BrowserWindow | null, kvm: KvmController, logs: LogBook, takeNotices: () => string[]) {
  const ours = (e: IpcMainInvokeEvent | IpcMainEvent) => {
    const win = getWindow();
    return !!win && e.sender === win.webContents;
  };
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!ours(e)) throw new Error('unauthorised IPC sender');
      return fn(...args);
    });
  // High-rate input: fire-and-forget; invalid messages are dropped silently.
  const on = (channel: string, fn: (...args: unknown[]) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (!ours(e)) return;
      try {
        fn(...args);
      } catch (err) {
        if (!(err instanceof InvalidArgument)) throw err;
      }
    });

  // Saved servers
  handle('servers:list', () => listServers());
  handle('servers:save', (s) => upsertServer(parseServerInput(s)));
  handle('servers:delete', (id) => deleteServer(str(id, 64)));
  handle('servers:detect', async (host, scheme, port): Promise<DetectResult> => {
    const h = str(host, 255).trim();
    const sch = scheme === 'https' ? 'https' : 'http';
    const p = port === undefined || port === null ? undefined : num(port, 1, 65535);
    const d = await detectFamily({ host: h, scheme: sch, port: p, tls: { pinnedFingerprint: getPin(h) } });
    const reachable = !(d.family === 'unknown' && d.evidence[0]?.startsWith('no response'));
    return { reachable, family: d.family, familyName: FAMILY_NAMES[d.family], supported: SUPPORTED_FAMILIES.includes(d.family), scheme: sch };
  });
  handle('servers:reachability', async (ids) => {
    if (!Array.isArray(ids) || ids.length > 500) throw new InvalidArgument();
    const out: Record<string, boolean> = {};
    await Promise.all(ids.map(async (id) => {
      const s = getServer(str(id, 64));
      if (s) out[s.id] = await tcpReachable(s.host, s.webPort ?? (s.webScheme === 'https' ? 443 : 80));
    }));
    return out;
  });
  handle('tls:trust', (host, fp) => setPin(str(host, 255), str(fp, 128)));

  // Session lifecycle
  handle('kvm:connect', (req) => {
    const r = (req ?? {}) as Record<string, unknown>;
    return kvm.connect(str(r.serverId, 64), r.password ? str(r.password, 128) : undefined);
  });
  handle('kvm:openJnlp', async () => {
    const win = getWindow();
    if (!win) return { error: 'no window' };
    const r = await dialog.showOpenDialog(win, { title: 'Open JViewer launch file', filters: [{ name: 'JNLP', extensions: ['jnlp'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { cancelled: true };
    return kvm.connectJnlp(readFileSync(r.filePaths[0], 'utf8'));
  });
  handle('kvm:openJnlpText', (xml) => kvm.connectJnlp(str(xml, 256 * 1024)));
  handle('kvm:disconnect', () => kvm.disconnect());
  handle('kvm:retryNow', () => kvm.retryNow());

  // Input and session commands
  on('kvm:key', (code, down) => kvm.key(str(code, 32), !!down));
  on('kvm:releaseKeys', () => kvm.releaseKeys());
  on('kvm:frameSize', (w, h) => kvm.setFrameSize(num(w, 1, 9999), num(h, 1, 9999)));
  on('kvm:mouse', (m) => {
    if (typeof m !== 'object' || !m) throw new InvalidArgument();
    kvm.mouse(m as Record<string, number>);
  });
  handle('kvm:chord', (name) => kvm.chord(oneOf(name, CHORD_NAMES)));
  handle('kvm:typeClipboard', async (): Promise<TypeClipboardResult> => {
    if (!kvm.live) return { status: 'no-session' };
    const text = await clipboard.readText();
    if (!text) return { status: 'empty' };
    if (text.length > MAX_TYPE_TEXT) return { status: 'too-long', length: text.length };
    return { status: 'typed', ...(await kvm.typeText(text)) };
  });
  handle('kvm:cancelTyping', () => kvm.cancelTyping());
  handle('clipboard:write', (text) => clipboard.writeText(str(text, 1_000_000)));
  handle('kvm:power', (action) => kvm.power(oneOf(action, POWER_ACTIONS)));
  handle('kvm:refresh', () => kvm.refresh());
  handle('kvm:wake', () => kvm.wake());
  handle('kvm:share', (d) => kvm.answerShare(num(d, 0, 2) as 0 | 1 | 2));
  handle('kvm:setTypingLayout', (l) => kvm.setTypingLayout(oneOf(l, TYPING_LAYOUTS)));

  // Logs
  handle('logs:get', () => logs.text());
  handle('logs:path', () => logs.file);

  // Window
  handle('window:fit', (w, h) => {
    const win = getWindow();
    const width = Math.round(num(w, 200, 20000));
    const height = Math.round(num(h, 200, 20000));
    if (!win || win.isMaximized() || win.isFullScreen()) return false;
    // Outer size = content + the OS frame; it must fit the screen's work area.
    const [ow, oh] = win.getSize();
    const [cw, ch] = win.getContentSize();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    if (width + ow - cw > area.width || height + oh - ch > area.height) return false;
    win.setContentSize(width, height);
    // Keep the resized window on screen.
    const b = win.getBounds();
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - b.width);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height);
    if (x !== b.x || y !== b.y) win.setPosition(x, y);
    return true;
  });

  // App
  handle('app:notices', () => takeNotices());
  on('app:reportError', (message) => logs.log('error', `window: ${str(message, 4000)}`));
}
