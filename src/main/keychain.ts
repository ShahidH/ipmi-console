/**
 * Saved passwords, kept in the operating system's own credential store: Windows
 * Credential Manager, the macOS Keychain, or the Secret Service on Linux (GNOME
 * Keyring, KWallet). One entry per saved server, under the service "IPMI Console"
 * with the server's id as the account.
 */
import { AsyncEntry } from '@napi-rs/keyring';

const SERVICE = 'IPMI Console';

// Linux: the Secret Service only. The kernel keyring the library would otherwise fall
// back to is emptied at reboot, which would lose passwords without saying so.
const entry = (serverId: string) => new AsyncEntry(SERVICE, serverId, { linux: { store: 'secret-service' } });

export async function savePassword(serverId: string, password: string): Promise<void> {
  try {
    await entry(serverId).setPassword(password);
  } catch (e) {
    const linux = process.platform === 'linux' ? ' On Linux, a keyring such as GNOME Keyring or KWallet must be running.' : '';
    throw new Error(`The password could not be saved in this computer's credential store (${(e as Error).message}).${linux}`);
  }
}

/** The saved password, or undefined if there is none or the store can't be read. */
export async function readPassword(serverId: string): Promise<string | undefined> {
  try {
    return (await entry(serverId).getPassword()) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function forgetPassword(serverId: string): Promise<void> {
  try {
    await entry(serverId).deleteCredential();
  } catch {
    /* nothing saved, or the store is unavailable: nothing to remove */
  }
}
