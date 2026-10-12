/**
 * The settings file format: versioned, migrated forward on load, and never
 * silently thrown away. Electron-free (store.ts adds paths and the credential store),
 * so loading, migration and recovery are unit-tested on real files.
 *
 * Adding a version: bump SETTINGS_VERSION, add a step to MIGRATIONS that turns
 * version N-1 into N, and a test with a file in the old shape.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JViewerFingerprint } from '../protocol/jarprobe';

export const SETTINGS_VERSION = 1;

export interface ServerEntry {
  id: string;
  name: string;
  host: string;
  webScheme: 'http' | 'https';
  webPort?: number;
  username: string;
  /** Firmware profile id or 'auto'. */
  profile: string;
  /** BMC family ('auto' = detect). */
  family?: string;
  /** Keyboard report style: 'auto' (firmware profile), 'autobreak', 'state' or 'single'. */
  keyboardMode?: string;
  /** Host keyboard layout used to type text ('us' or 'gb'). */
  typingLayout?: string;
  /** Allow TLS 1.0/1.1 for this host only. */
  legacyTls: boolean;
  /** A password for this server is saved in the OS credential store (keychain.ts). */
  passwordSaved?: boolean;
  /** A password saved by an earlier build, encrypted with safeStorage (base64); moved to the credential store when next used. */
  secret?: string;
  /** Family detected on the last successful connect. */
  lastFamily?: string;
  /** Epoch ms of the last successful connect. */
  lastConnectedAt?: number;
}

export interface Settings {
  version: number;
  servers: ServerEntry[];
  /** host → SHA-256 certificate fingerprint the user trusted. */
  pins: Record<string, string>;
  /** Cached JViewer jar fingerprints, by jar hash set. */
  fingerprints: Record<string, JViewerFingerprint>;
}

const emptySettings = (): Settings => ({ version: SETTINGS_VERSION, servers: [], pins: {}, fingerprints: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Each step turns the object for version i into version i + 1. */
const MIGRATIONS: Array<(raw: Record<string, unknown>) => Record<string, unknown>> = [
  // 0 → 1: the unversioned format of the first builds. Same fields; adds the
  // version and fills defaults introduced since (typing layout).
  (raw) => ({
    ...raw,
    servers: Array.isArray(raw.servers) ? raw.servers.map((s) => (isObj(s) ? { typingLayout: 'us', ...s } : s)) : [],
  }),
];

export class NewerSettingsError extends Error {
  constructor(readonly found: number) {
    super(`settings were saved by a newer version of the app (format ${found}; this version reads up to ${SETTINGS_VERSION})`);
  }
}

/** Keeps only well-formed server entries; normalises the rest of the shape. */
function sanitize(raw: Record<string, unknown>): { settings: Settings; dropped: number } {
  const servers: ServerEntry[] = [];
  let dropped = 0;
  for (const s of Array.isArray(raw.servers) ? raw.servers : []) {
    if (isObj(s) && typeof s.id === 'string' && typeof s.host === 'string' && s.host && typeof s.username === 'string') {
      servers.push({
        ...(s as unknown as ServerEntry),
        name: typeof s.name === 'string' && s.name ? s.name : s.host,
        webScheme: s.webScheme === 'https' ? 'https' : 'http',
        profile: typeof s.profile === 'string' ? s.profile : 'auto',
        legacyTls: s.legacyTls === true,
        passwordSaved: s.passwordSaved === true || undefined,
      });
    } else {
      dropped++;
    }
  }
  return {
    settings: {
      version: SETTINGS_VERSION,
      servers,
      pins: isObj(raw.pins) ? (raw.pins as Record<string, string>) : {},
      fingerprints: isObj(raw.fingerprints) ? (raw.fingerprints as Record<string, JViewerFingerprint>) : {},
    },
    dropped,
  };
}

/** Brings parsed settings JSON of any known version up to SETTINGS_VERSION. */
export function migrateSettings(raw: unknown): { settings: Settings; from: number; dropped: number } {
  if (!isObj(raw)) throw new Error('settings file is not a JSON object');
  const from = raw.version === undefined ? 0 : raw.version;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) throw new Error(`settings file has an invalid version (${String(raw.version)})`);
  if (from > SETTINGS_VERSION) throw new NewerSettingsError(from);
  let cur = raw;
  for (let v = from; v < SETTINGS_VERSION; v++) cur = MIGRATIONS[v](cur);
  return { ...sanitize(cur), from };
}

export interface Loaded {
  settings: Settings;
  /** Never write: the file is from a newer app version. */
  readOnly: boolean;
  /** Something the user should be told (recovered, migrated with losses, read-only). */
  notice?: string;
}

/**
 * Loads settings from `file`. A missing file is a first run. A damaged file is
 * moved aside (settings.json.corrupt-<time>) rather than overwritten. An older
 * format is backed up (settings.v<N>.bak.json) and migrated. A newer format is
 * used read-only, so a downgrade cannot destroy it.
 */
export function loadSettingsFile(file: string, now = new Date()): Loaded {
  if (!existsSync(file)) return { settings: emptySettings(), readOnly: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const aside = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, aside);
    return { settings: emptySettings(), readOnly: false, notice: `The settings file could not be read (${(e as Error).message}) and was moved to ${aside}. Saved servers need to be added again.` };
  }
  try {
    const { settings, from, dropped } = migrateSettings(raw);
    if (from < SETTINGS_VERSION) copyFileSync(file, file.replace(/\.json$/, '') + `.v${from}.bak.json`);
    const notice = dropped ? `${dropped} saved server${dropped === 1 ? ' was' : 's were'} damaged and could not be loaded.` : undefined;
    return { settings, readOnly: false, notice };
  } catch (e) {
    if (e instanceof NewerSettingsError && isObj(raw)) {
      // Best effort with the fields this version understands; never written back.
      return { settings: sanitize(raw).settings, readOnly: true, notice: `${e.message}. Changes made in this version will not be saved.` };
    }
    const aside = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, aside);
    return { settings: emptySettings(), readOnly: false, notice: `The settings file was not valid (${(e as Error).message}) and was moved to ${aside}.` };
  }
}

/** Atomic write (temp file + rename), owner-only permissions. */
export function saveSettingsFile(file: string, settings: Settings) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...settings, version: SETTINGS_VERSION }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
