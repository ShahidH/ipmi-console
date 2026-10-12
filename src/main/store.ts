/**
 * Persistent settings: saved servers, TLS certificate pins, cached jar
 * fingerprints. The file format lives in settings.ts. Passwords are saved only
 * on request, and only in the OS credential store (keychain.ts); the settings
 * file just records that one exists.
 */
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { JViewerFingerprint } from '../protocol/jarprobe';
import { forgetPassword, readPassword, savePassword } from './keychain';
import { loadSettingsFile, saveSettingsFile, type Loaded, type ServerEntry, type Settings } from './settings';

export type { ServerEntry } from './settings';

const file = () => join(app.getPath('userData'), 'settings.json');
let loaded: Loaded | undefined;

/** Loads once. Returns what the user should be told about the settings file, if anything. */
export function openSettings(): string | undefined {
  loaded ??= loadSettingsFile(file());
  return loaded.notice;
}

function data(): Settings {
  openSettings();
  return loaded!.settings;
}

function save() {
  if (loaded?.readOnly) return;
  saveSettingsFile(file(), data());
}

export function listServers(): Array<Omit<ServerEntry, 'secret' | 'passwordSaved'> & { hasPassword: boolean }> {
  return data().servers.map(({ secret, passwordSaved, ...s }) => ({ ...s, hasPassword: !!(passwordSaved || secret) }));
}

export function getServer(id: string): ServerEntry | undefined {
  return data().servers.find((s) => s.id === id);
}

export async function upsertServer(input: Omit<ServerEntry, 'id' | 'secret' | 'passwordSaved' | 'lastFamily' | 'lastConnectedAt'> & { id?: string; password?: string; savePassword?: boolean }): Promise<string> {
  const d = data();
  const id = input.id && d.servers.some((s) => s.id === input.id) ? input.id : randomUUID();
  const prev = d.servers.find((s) => s.id === id);
  let passwordSaved = prev?.passwordSaved;
  let secret = prev?.secret;
  if (input.savePassword === false) {
    if (passwordSaved) await forgetPassword(id);
    passwordSaved = secret = undefined;
  } else if (input.savePassword && input.password) {
    await savePassword(id, input.password);
    passwordSaved = true;
    secret = undefined;
  }
  const entry: ServerEntry = {
    id, name: input.name || input.host, host: input.host, webScheme: input.webScheme, webPort: input.webPort,
    username: input.username, profile: input.profile || 'auto', family: input.family || 'auto', keyboardMode: input.keyboardMode || 'auto',
    typingLayout: input.typingLayout || prev?.typingLayout || 'us', legacyTls: !!input.legacyTls, passwordSaved, secret,
    lastFamily: prev?.lastFamily, lastConnectedAt: prev?.lastConnectedAt,
  };
  // Edits keep their place in the list; new servers go last.
  const i = d.servers.findIndex((s) => s.id === id);
  if (i >= 0) d.servers[i] = entry;
  else d.servers.push(entry);
  save();
  return id;
}

/** Records a successful connect (shown on the servers screen). */
export function touchServer(id: string, family: string | undefined) {
  const s = data().servers.find((x) => x.id === id);
  if (!s) return;
  s.lastFamily = family ?? s.lastFamily;
  s.lastConnectedAt = Date.now();
  save();
}

export async function deleteServer(id: string) {
  const d = data();
  if (d.servers.find((s) => s.id === id)?.passwordSaved) await forgetPassword(id);
  d.servers = d.servers.filter((s) => s.id !== id);
  save();
}

export async function storedPassword(s: ServerEntry): Promise<string | undefined> {
  if (s.passwordSaved) return readPassword(s.id);
  if (!s.secret) return undefined;
  // Saved by an earlier build, encrypted with safeStorage: move it to the credential store.
  try {
    const password = (await safeStorage.decryptStringAsync(Buffer.from(s.secret, 'base64'))).result;
    await savePassword(s.id, password).then(() => {
      s.passwordSaved = true;
      s.secret = undefined;
      save();
    }, () => {});
    return password;
  } catch {
    return undefined;
  }
}

export function getPin(host: string): string | undefined {
  return data().pins[host.toLowerCase()];
}

export function setPin(host: string, fingerprint: string) {
  data().pins[host.toLowerCase()] = fingerprint;
  save();
}

export function fingerprintCache(): Map<string, JViewerFingerprint> {
  const d = data();
  const m = new Map(Object.entries(d.fingerprints));
  const set = m.set.bind(m);
  m.set = (k, v) => {
    d.fingerprints[k] = v;
    save();
    return set(k, v);
  };
  return m;
}
