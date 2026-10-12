/** Argument validation for IPC from the (untrusted) renderer. Electron-free, so it is unit-tested. */
import type { ChordName, KeyboardModeChoice, PowerActionName, TypingLayoutChoice } from '../shared/api';
import { CHORDS } from '../protocol/keymap';

export class InvalidArgument extends Error {
  constructor() {
    super('invalid argument');
  }
}

export function str(v: unknown, max = 256): string {
  if (typeof v !== 'string' || v.length > max) throw new InvalidArgument();
  return v;
}

export function num(v: unknown, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new InvalidArgument();
  return v;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new InvalidArgument();
  return v as T;
}

export const POWER_ACTIONS: readonly PowerActionName[] = ['on', 'soft', 'off', 'reset', 'cycle'];
const KEYBOARD_MODES: readonly KeyboardModeChoice[] = ['auto', 'autobreak', 'state', 'single'];
export const TYPING_LAYOUTS: readonly TypingLayoutChoice[] = ['us', 'gb', 'de', 'fr', 'es', 'jp'];
export const CHORD_NAMES = Object.keys(CHORDS) as ChordName[];

/** Validates a server form from the renderer into store input. */
export function parseServerInput(s: unknown) {
  if (typeof s !== 'object' || !s) throw new InvalidArgument();
  const o = s as Record<string, unknown>;
  const host = str(o.host, 255).trim();
  if (!host) throw new InvalidArgument();
  return {
    id: o.id ? str(o.id, 64) : undefined,
    name: str(o.name ?? '', 128).trim(),
    host,
    webScheme: o.webScheme === 'https' ? ('https' as const) : ('http' as const),
    webPort: o.webPort ? num(Number(o.webPort), 1, 65535) : undefined,
    username: str(o.username, 64),
    profile: str(o.profile ?? 'auto', 64),
    family: str(o.family ?? 'auto', 32),
    keyboardMode: oneOf(o.keyboardMode ?? 'auto', KEYBOARD_MODES),
    typingLayout: o.typingLayout === undefined ? 'us' : oneOf(o.typingLayout, TYPING_LAYOUTS),
    legacyTls: !!o.legacyTls,
    password: o.password ? str(o.password, 128) : undefined,
    savePassword: typeof o.savePassword === 'boolean' ? o.savePassword : undefined,
  };
}
