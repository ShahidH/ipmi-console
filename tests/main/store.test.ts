// Saved passwords: kept only in the OS credential store (mocked here), never in the
// settings file, removed with the server, and moved over from the earlier safeStorage format.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'store-'));
const credentials = new Map<string, string>();
let storeAvailable = true;

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { decryptStringAsync: async (b: Buffer) => ({ result: b.toString().replace(/^enc:/, ''), shouldReEncrypt: false }) },
}));
vi.mock('../../src/main/keychain', () => ({
  savePassword: async (id: string, pw: string) => {
    if (!storeAvailable) throw new Error('The password could not be saved in this computer\'s credential store.');
    credentials.set(id, pw);
  },
  readPassword: async (id: string) => credentials.get(id),
  forgetPassword: async (id: string) => void credentials.delete(id),
}));

const server = { name: 'lab', host: 'bmc.example', webScheme: 'http' as const, username: 'admin', profile: 'auto', family: 'auto', keyboardMode: 'auto', typingLayout: 'us', legacyTls: false };
const settingsFile = () => readFileSync(join(dir, 'settings.json'), 'utf8');

async function freshStore(content?: object) {
  credentials.clear();
  storeAvailable = true;
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(content ?? { version: 1, servers: [], pins: {}, fingerprints: {} }));
  vi.resetModules();
  return import('../../src/main/store');
}

describe('saved passwords', () => {
  beforeEach(() => credentials.clear());

  it('go to the credential store, not the settings file', async () => {
    const store = await freshStore();
    const id = await store.upsertServer({ ...server, password: 'example-pw', savePassword: true });
    expect(credentials.get(id)).toBe('example-pw');
    expect(settingsFile()).not.toContain('example-pw');
    expect(store.listServers()[0]).toMatchObject({ id, hasPassword: true });
    expect(store.listServers()[0]).not.toHaveProperty('passwordSaved');
    expect(await store.storedPassword(store.getServer(id)!)).toBe('example-pw');
  });

  it('are removed when unticked or when the server is deleted', async () => {
    const store = await freshStore();
    const id = await store.upsertServer({ ...server, password: 'example-pw', savePassword: true });
    await store.upsertServer({ ...server, id, savePassword: false });
    expect(credentials.has(id)).toBe(false);
    expect(store.listServers()[0].hasPassword).toBe(false);

    await store.upsertServer({ ...server, id, password: 'example-pw', savePassword: true });
    await store.deleteServer(id);
    expect(credentials.has(id)).toBe(false);
  });

  it('are kept when a server is edited without retyping the password', async () => {
    const store = await freshStore();
    const id = await store.upsertServer({ ...server, password: 'example-pw', savePassword: true });
    await store.upsertServer({ ...server, id, name: 'renamed', savePassword: true });
    expect(await store.storedPassword(store.getServer(id)!)).toBe('example-pw');
  });

  it('fail clearly, without adding the server, when there is no credential store', async () => {
    const store = await freshStore();
    storeAvailable = false;
    await expect(store.upsertServer({ ...server, password: 'example-pw', savePassword: true })).rejects.toThrow(/credential store/);
    expect(store.listServers()).toEqual([]);
  });

  it('saved by an earlier build move into the credential store when first used', async () => {
    const legacy = { ...server, id: 'old', secret: Buffer.from('enc:example-pw').toString('base64') };
    const store = await freshStore({ version: 1, servers: [legacy], pins: {}, fingerprints: {} });
    expect(store.listServers()[0].hasPassword).toBe(true);
    expect(await store.storedPassword(store.getServer('old')!)).toBe('example-pw');
    expect(credentials.get('old')).toBe('example-pw');
    expect(JSON.parse(settingsFile()).servers[0]).toMatchObject({ passwordSaved: true });
    expect(JSON.parse(settingsFile()).servers[0]).not.toHaveProperty('secret');
  });
});
