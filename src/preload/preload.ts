/**
 * The only bridge between the sandboxed renderer and the main process. Every
 * call is a fixed channel with simple arguments; main re-validates them.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, type OjvApi } from '../shared/api';

const api: OjvApi = {
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServer: (s) => ipcRenderer.invoke('servers:save', s),
  deleteServer: (id) => ipcRenderer.invoke('servers:delete', id),
  detect: (host, scheme, port) => ipcRenderer.invoke('servers:detect', host, scheme, port),
  reachability: (ids) => ipcRenderer.invoke('servers:reachability', ids),
  connect: (serverId, password) => ipcRenderer.invoke('kvm:connect', { serverId, password }),
  openJnlp: () => ipcRenderer.invoke('kvm:openJnlp'),
  openJnlpText: (xml) => ipcRenderer.invoke('kvm:openJnlpText', xml),
  disconnect: () => ipcRenderer.invoke('kvm:disconnect'),
  retryNow: () => ipcRenderer.invoke('kvm:retryNow'),
  trustCertificate: (host, fingerprint) => ipcRenderer.invoke('tls:trust', host, fingerprint),
  key: (code, down) => ipcRenderer.send('kvm:key', code, down),
  releaseKeys: () => ipcRenderer.send('kvm:releaseKeys'),
  mouse: (m) => ipcRenderer.send('kvm:mouse', m),
  frameSize: (w, h) => ipcRenderer.send('kvm:frameSize', w, h),
  chord: (name) => ipcRenderer.invoke('kvm:chord', name),
  typeClipboard: () => ipcRenderer.invoke('kvm:typeClipboard'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  cancelTyping: () => ipcRenderer.invoke('kvm:cancelTyping'),
  power: (action) => ipcRenderer.invoke('kvm:power', action),
  refresh: () => ipcRenderer.invoke('kvm:refresh'),
  wake: () => ipcRenderer.invoke('kvm:wake'),
  answerShare: (decision) => ipcRenderer.invoke('kvm:share', decision),
  setTypingLayout: (layout) => ipcRenderer.invoke('kvm:setTypingLayout', layout),
  logs: () => ipcRenderer.invoke('logs:get'),
  fitWindow: (width, height) => ipcRenderer.invoke('window:fit', width, height),
  notices: () => ipcRenderer.invoke('app:notices'),
  reportError: (message) => ipcRenderer.send('app:reportError', message),
  logPath: () => ipcRenderer.invoke('logs:path'),
  on: (channel, fn) => {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error('unknown channel');
    const h = (_e: IpcRendererEvent, ...args: unknown[]) => (fn as (...a: unknown[]) => void)(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.off(channel, h);
  },
};

contextBridge.exposeInMainWorld('ojv', api);
