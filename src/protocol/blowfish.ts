/**
 * Keyboard/mouse report encryption: Blowfish/ECB/NoPadding, key = session token
 * bytes (zero-padded to 16 when shorter), plaintext zero-padded to 8 by the caller.
 * Electron's BoringSSL has no Blowfish, hence the egoroof-blowfish package.
 */
import { Blowfish } from 'egoroof-blowfish';
import type { ReportCipher } from './hid';

/** ECB encryption of block-aligned data (NULL padding adds nothing to aligned input). */
export function blowfishEcb(key: Uint8Array): (block: Uint8Array) => Uint8Array {
  const bf = new Blowfish(key, Blowfish.MODE.ECB, Blowfish.PADDING.NULL);
  return (block) => {
    if (block.length % 8 !== 0) throw new Error('Blowfish ECB input must be a multiple of 8 bytes');
    return bf.encode(block);
  };
}

export function kmCipher(token: string): ReportCipher {
  const raw = Buffer.from(token, 'latin1');
  const key = raw.length < 16 ? Buffer.concat([raw, Buffer.alloc(16 - raw.length)]) : raw.subarray(0, 56);
  const enc = blowfishEcb(key);
  return { encrypt: (block: Buffer) => Buffer.from(enc(block)) };
}
