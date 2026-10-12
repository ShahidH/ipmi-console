/**
 * Physical key (DOM KeyboardEvent.code) → USB HID keyboard usage (HID Usage
 * Tables §10). Using physical codes makes the client layout-independent: the
 * *remote* OS keymap decides which character a key produces, as with a real
 * USB keyboard.
 */

export const MODIFIER_BITS: Record<string, number> = {
  ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08, OSLeft: 0x08,
  ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80, OSRight: 0x80,
};

export const USAGE: Record<string, number> = {
  KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07, KeyE: 0x08, KeyF: 0x09, KeyG: 0x0a, KeyH: 0x0b,
  KeyI: 0x0c, KeyJ: 0x0d, KeyK: 0x0e, KeyL: 0x0f, KeyM: 0x10, KeyN: 0x11, KeyO: 0x12, KeyP: 0x13,
  KeyQ: 0x14, KeyR: 0x15, KeyS: 0x16, KeyT: 0x17, KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b,
  KeyY: 0x1c, KeyZ: 0x1d,
  Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21, Digit5: 0x22,
  Digit6: 0x23, Digit7: 0x24, Digit8: 0x25, Digit9: 0x26, Digit0: 0x27,
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
  IntlHash: 0x32, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
  CapsLock: 0x39,
  F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,
  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a, PageUp: 0x4b,
  Delete: 0x4c, End: 0x4d, PageDown: 0x4e, ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57,
  NumpadEnter: 0x58, Numpad1: 0x59, Numpad2: 0x5a, Numpad3: 0x5b, Numpad4: 0x5c, Numpad5: 0x5d,
  Numpad6: 0x5e, Numpad7: 0x5f, Numpad8: 0x60, Numpad9: 0x61, Numpad0: 0x62, NumpadDecimal: 0x63,
  IntlBackslash: 0x64, ContextMenu: 0x65, Power: 0x66, NumpadEqual: 0x67,
  F13: 0x68, F14: 0x69, F15: 0x6a, F16: 0x6b, F17: 0x6c, F18: 0x6d, F19: 0x6e, F20: 0x6f,
  F21: 0x70, F22: 0x71, F23: 0x72, F24: 0x73,
  NumpadComma: 0x85, IntlRo: 0x87, KanaMode: 0x88, IntlYen: 0x89, Convert: 0x8a, NonConvert: 0x8b,
  Lang1: 0x90, Lang2: 0x91,
};

/**
 * Keyboard report modes:
 *  - 'state':     standard USB boot report [mods, 0, k1..k6] (6-key rollover).
 *  - 'autobreak': each key press is [mods, 1, key, 0…] and the BMC generates
 *                 the release itself; releases send nothing except for lock
 *                 keys; modifier changes send [mods, 0, 0…].
 *  - 'single':    auto-keybreak off: [mods, 0, key, 0…] on press,
 *                 [mods, 0, 0, 0…] on release.
 */
export type KeyboardMode = 'state' | 'autobreak' | 'single';

const LOCK_KEYS = new Set([0x39, 0x47, 0x53]); // CapsLock, ScrollLock, NumLock

export class KeyboardState {
  private modifiers = 0;
  private pressed: number[] = [];

  constructor(public mode: KeyboardMode = 'state') {}

  get singleKey(): boolean {
    return this.mode !== 'state';
  }

  /** Returns the report to send, or null if the key is unknown or nothing changed. */
  handle(code: string, down: boolean): Uint8Array | null {
    const mod = MODIFIER_BITS[code];
    if (mod !== undefined) {
      const before = this.modifiers;
      this.modifiers = down ? this.modifiers | mod : this.modifiers & ~mod;
      return before === this.modifiers ? null : this.report();
    }
    const usage = USAGE[code];
    if (usage === undefined) return null;
    if (this.mode === 'autobreak') {
      if (down) return this.report(usage, 1);
      return LOCK_KEYS.has(usage) ? this.report(0) : null;
    }
    const i = this.pressed.indexOf(usage);
    if (down) {
      if (i >= 0 && !this.singleKey) return null; // auto-repeat: state unchanged
      if (i >= 0) this.pressed.splice(i, 1);
      this.pressed.push(usage);
      if (this.pressed.length > 6) this.pressed.shift();
    } else {
      if (i < 0) return null;
      this.pressed.splice(i, 1);
    }
    return this.report(down ? usage : 0);
  }

  /** Releases everything (e.g. on focus loss) and returns the empty report if needed. */
  releaseAll(): Uint8Array | null {
    if (this.modifiers === 0 && this.pressed.length === 0) return null;
    this.modifiers = 0;
    this.pressed = [];
    return new Uint8Array(8);
  }

  private report(lastDown = 0, autobreak = 0): Uint8Array {
    const r = new Uint8Array(8);
    r[0] = this.modifiers;
    r[1] = autobreak;
    if (this.singleKey) {
      r[2] = lastDown;
    } else {
      this.pressed.slice(-6).forEach((u, i) => (r[2 + i] = u));
    }
    return r;
  }
}

/** A key chord as a sequence of reports: press each in order, then release all. */
export function chordReports(codes: string[], mode: KeyboardMode = 'state'): Uint8Array[] {
  const kb = new KeyboardState(mode);
  const out: Uint8Array[] = [];
  for (const c of codes) {
    const r = kb.handle(c, true);
    if (r) out.push(r);
  }
  for (const c of [...codes].reverse()) {
    const r = kb.handle(c, false);
    if (r) out.push(r);
  }
  return out;
}

export const CHORDS: Record<string, string[]> = {
  'ctrl-alt-del': ['ControlLeft', 'AltLeft', 'Delete'],
  'ctrl-alt-backspace': ['ControlLeft', 'AltLeft', 'Backspace'],
  'alt-tab': ['AltLeft', 'Tab'],
  'alt-f4': ['AltLeft', 'F4'],
  'ctrl-esc': ['ControlLeft', 'Escape'],
  'win': ['MetaLeft'],
  'printscreen': ['PrintScreen'],
  'alt-sysrq': ['AltLeft', 'PrintScreen'],
};
