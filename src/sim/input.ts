/**
 * Decodes HID packets as a BMC receives them (IVTP type 1, IUSB header + USB
 * report, optionally Blowfish-encrypted) into key and mouse events, and
 * reconstructs the text a user typed. Handles both keyboard styles:
 * auto-keybreak ([mods, 1, key]) and standard USB state reports.
 */
import { Blowfish } from 'egoroof-blowfish';
import { USAGE } from '../protocol/keymap';

export type InputEvent =
  | { kind: 'key'; down: boolean; usage: number; name: string; char?: string; autobreak: boolean; modifiers: number }
  | { kind: 'modifiers'; modifiers: number }
  | { kind: 'mouse'; absolute: boolean; x: number; y: number; buttons: number; wheel: number };

const NAMES: Record<number, string> = Object.fromEntries(Object.entries(USAGE).map(([k, v]) => [v, k]));
const BASE = 'abcdefghijklmnopqrstuvwxyz1234567890';
const SHIFTED_DIGITS = '!@#$%^&*()';
const PUNCT: Record<number, [string, string]> = {
  0x2c: [' ', ' '], 0x2d: ['-', '_'], 0x2e: ['=', '+'], 0x2f: ['[', '{'], 0x30: [']', '}'], 0x31: ['\\', '|'],
  0x32: ['#', '~'], 0x33: [';', ':'], 0x34: ["'", '"'], 0x35: ['`', '~'], 0x36: [',', '<'], 0x37: ['.', '>'], 0x38: ['/', '?'],
};

/** Character a US-layout host would produce, or undefined for non-printing keys. */
function usageChar(usage: number, modifiers: number, capsLock = false): string | undefined {
  const shift = (modifiers & 0x22) !== 0;
  if (usage >= 0x04 && usage <= 0x1d) {
    const c = BASE[usage - 0x04];
    return shift !== capsLock ? c.toUpperCase() : c;
  }
  if (usage >= 0x1e && usage <= 0x27) return shift ? SHIFTED_DIGITS[usage - 0x1e] : BASE[26 + usage - 0x1e];
  const p = PUNCT[usage];
  return p ? p[shift ? 1 : 0] : undefined;
}

/** Blowfish-ECB decryption of block-aligned data without padding removal. */
function blowfishDecrypt(key: Uint8Array): (data: Uint8Array) => Uint8Array {
  const bf = new Blowfish(key, Blowfish.MODE.ECB, Blowfish.PADDING.PKCS5);
  // Append an encrypted full PKCS5 padding block so decode() strips exactly it.
  const padBlock = bf.encode(new Uint8Array(0));
  return (data) => {
    const joined = new Uint8Array(data.length + 8);
    joined.set(data);
    joined.set(padBlock, data.length);
    return bf.decode(joined, Blowfish.TYPE.UINT8_ARRAY) as Uint8Array;
  };
}

export class InputDecoder {
  private prevKeys = new Set<number>();
  /** Lock-key LEDs as a host keeps them: bit 0 Num Lock (on at boot), 1 Caps Lock, 2 Scroll Lock. */
  leds = 0x01;
  private decrypt?: (d: Uint8Array) => Uint8Array;
  /** Text typed so far (Backspace removes, Enter adds a newline). */
  typed = '';

  constructor(token?: string) {
    if (token) {
      const raw = Buffer.from(token, 'latin1');
      const key = raw.length < 16 ? Buffer.concat([raw, Buffer.alloc(16 - raw.length)]) : raw.subarray(0, 56);
      this.decrypt = blowfishDecrypt(key);
    }
  }

  /** `body` is the IVTP HID_PKT body (after the 8-byte IVTP header). */
  handle(body: Buffer, status: number): InputEvent[] {
    if (body.length < 34 || body.subarray(0, 8).toString('latin1') !== 'IUSB    ') return [];
    const device = body[17];
    const reportLen = body[32];
    let report: Uint8Array = body.subarray(33);
    if (status === 0xff) {
      if (!this.decrypt) return [];
      report = this.decrypt(report.subarray(0, Math.floor(report.length / 8) * 8));
    }
    report = report.subarray(0, reportLen);
    if (device === 0x30 && report.length >= 8) return this.keyboard(report);
    if (device === 0x31 && report.length === 6) {
      const v = Buffer.from(report);
      return [{ kind: 'mouse', absolute: true, buttons: v[0], x: v.readInt16LE(1), y: v.readInt16LE(3), wheel: v.readInt8(5) }];
    }
    if (device === 0x31 && report.length === 4) {
      const v = Buffer.from(report);
      return [{ kind: 'mouse', absolute: false, buttons: v[0], x: v.readInt8(1), y: v.readInt8(2), wheel: v.readInt8(3) }];
    }
    return [];
  }

  private keyboard(r: Uint8Array): InputEvent[] {
    const mods = r[0];
    const out: InputEvent[] = [];
    if (r[1] === 1 && r[2] !== 0) {
      // Auto-keybreak: a press the BMC releases by itself.
      out.push(this.key(r[2], true, true, mods));
      return out;
    }
    const now = new Set<number>([...r.subarray(2, 8)].filter((u) => u !== 0));
    for (const u of now) if (!this.prevKeys.has(u)) out.push(this.key(u, true, false, mods));
    for (const u of this.prevKeys) if (!now.has(u)) out.push(this.key(u, false, false, mods));
    this.prevKeys = now;
    if (out.length === 0) out.push({ kind: 'modifiers', modifiers: mods });
    return out;
  }

  private key(usage: number, down: boolean, autobreak: boolean, modifiers: number): InputEvent {
    if (down) this.leds ^= ({ 0x53: 0x01, 0x39: 0x02, 0x47: 0x04 } as Record<number, number>)[usage] ?? 0;
    const char = usageChar(usage, modifiers, (this.leds & 0x02) !== 0);
    if (down && (modifiers & 0x11) === 0 && (modifiers & 0x44) === 0) {
      if (char !== undefined) this.typed += char;
      else if (usage === 0x2a) this.typed = this.typed.slice(0, -1);
      else if (usage === 0x28) this.typed += '\n';
    }
    return { kind: 'key', down, usage, name: NAMES[usage] ?? `usage 0x${usage.toString(16)}`, char, autobreak, modifiers };
  }
}

export function modifierNames(m: number): string {
  const n = ['LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin'];
  return n.filter((_, i) => m & (1 << i)).join('+');
}
