// The settings file: first run, migration from the unversioned format, damaged
// files and files from a newer version. Nothing is ever silently discarded.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettingsFile, migrateSettings, NewerSettingsError, saveSettingsFile, SETTINGS_VERSION } from '../../src/main/settings';

const dir = () => mkdtempSync(join(tmpdir(), 'settings-'));
const v0Server = { id: 'a', name: 'nas', host: '10.0.0.5', webScheme: 'http', username: 'admin', profile: 'auto', legacyTls: false, secret: 'c2VjcmV0' };

describe('migrateSettings', () => {
  it('upgrades the unversioned format and fills new defaults', () => {
    const { settings, from } = migrateSettings({ servers: [v0Server], pins: { '10.0.0.5': 'AA' }, fingerprints: {} });
    expect(from).toBe(0);
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.servers[0]).toEqual({ ...v0Server, typingLayout: 'us' });
    expect(settings.pins).toEqual({ '10.0.0.5': 'AA' });
  });

  it('keeps values that are already set', () => {
    expect(migrateSettings({ servers: [{ ...v0Server, typingLayout: 'gb' }] }).settings.servers[0].typingLayout).toBe('gb');
  });

  it('drops damaged server entries and counts them', () => {
    const { settings, dropped } = migrateSettings({ version: 1, servers: [v0Server, { id: 'b' }, 'junk', null] });
    expect(settings.servers.map((s) => s.id)).toEqual(['a']);
    expect(dropped).toBe(3);
  });

  it('refuses newer and invalid versions', () => {
    expect(() => migrateSettings({ version: SETTINGS_VERSION + 1 })).toThrow(NewerSettingsError);
    expect(() => migrateSettings({ version: 'x' })).toThrow(/invalid version/);
    expect(() => migrateSettings([])).toThrow(/not a JSON object/);
  });
});

describe('loadSettingsFile', () => {
  it('starts empty on first run', () => {
    const f = join(dir(), 'settings.json');
    expect(loadSettingsFile(f)).toEqual({ settings: { version: SETTINGS_VERSION, servers: [], pins: {}, fingerprints: {} }, readOnly: false });
  });

  it('backs up an old-format file before migrating it', () => {
    const d = dir();
    const f = join(d, 'settings.json');
    const original = JSON.stringify({ servers: [v0Server], pins: {}, fingerprints: {} });
    writeFileSync(f, original);
    const r = loadSettingsFile(f);
    expect(r.notice).toBeUndefined();
    expect(r.settings.servers).toHaveLength(1);
    expect(readFileSync(join(d, 'settings.v0.bak.json'), 'utf8')).toBe(original);
    saveSettingsFile(f, r.settings);
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe(SETTINGS_VERSION);
  });

  it('moves a damaged file aside instead of overwriting it', () => {
    const d = dir();
    const f = join(d, 'settings.json');
    writeFileSync(f, '{"servers": [ truncated');
    const r = loadSettingsFile(f, new Date('2026-10-10T12:00:00Z'));
    expect(r.settings.servers).toEqual([]);
    expect(r.notice).toMatch(/could not be read/);
    expect(existsSync(f)).toBe(false);
    const aside = readdirSync(d).find((n) => n.startsWith('settings.json.corrupt-'))!;
    expect(readFileSync(join(d, aside), 'utf8')).toBe('{"servers": [ truncated');
  });

  it('opens a newer file read-only so a downgrade cannot destroy it', () => {
    const f = join(dir(), 'settings.json');
    writeFileSync(f, JSON.stringify({ version: SETTINGS_VERSION + 1, servers: [v0Server], somethingNew: true }));
    const r = loadSettingsFile(f);
    expect(r.readOnly).toBe(true);
    expect(r.notice).toMatch(/newer version/);
    expect(r.settings.servers.map((s) => s.id)).toEqual(['a']);
  });

  it('writes atomically with owner-only permissions', () => {
    const f = join(dir(), 'sub', 'settings.json');
    saveSettingsFile(f, { version: 1, servers: [], pins: {}, fingerprints: {} });
    expect(existsSync(f + '.tmp')).toBe(false);
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});
