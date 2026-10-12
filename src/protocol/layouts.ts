/**
 * Host keyboard layouts for typing text into the server (Type clipboard).
 *
 * Live keystrokes do not use this: they are sent by physical position, so any
 * host layout works. Turning *characters* into keys does need to know which
 * layout the host (its OS, not its BIOS: firmware setup screens are US) uses.
 *
 * Each layout is a table of physical keys (KeyboardEvent.code, named by US
 * position) and the characters they give at the base, Shift and AltGr levels,
 * following the standard Windows layouts. A character is only included when
 * Windows and Linux (xkb) agree on how to type it; tests/layouts.test.ts checks
 * every entry against the xkb definitions. Where they disagree (e.g. "~" is a
 * dead key on French and Spanish Windows but not on Linux), the character is
 * left out and reported as skipped, rather than typed wrongly on one of them.
 */

/** One key press: a physical key plus modifiers. */
export interface KeyStroke { code: string; shift: boolean; altGr?: boolean }

export type TypingLayout = 'us' | 'gb' | 'de' | 'fr' | 'es' | 'jp';
export const TYPING_LAYOUTS: Record<TypingLayout, string> = {
  us: 'English (US)',
  gb: 'English (UK)',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  jp: 'Japanese',
};

/**
 * code → [base, Shift, AltGr]. "" = nothing at that level. A "dead:" prefix marks
 * a dead key (on both Windows and Linux): typing the character alone is the dead
 * key then Space; `compose` lists the letters it combines with.
 */
export interface LayoutSpec {
  keys: Record<string, [string, string?, string?]>;
  /** Letter keys that differ from US positions (QWERTZ, AZERTY): code → letter. */
  letters?: Record<string, string>;
  /** Dead key character → pairs of (base letter, result), e.g. "aâeê". */
  compose?: Record<string, string>;
}

const US_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const US_KEYS: LayoutSpec['keys'] = {
  Backquote: ['`', '~'], Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'], Digit5: ['5', '%'],
  Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('], Digit0: ['0', ')'], Minus: ['-', '_'], Equal: ['=', '+'],
  BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'], Semicolon: [';', ':'], Quote: ["'", '"'],
  Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
};

const CIRCUMFLEX = 'aâeêiîoôuûAÂEÊIÎOÔUÛ';
const GRAVE = 'aàeèiìoòuùAÀEÈIÌOÒUÙ';
const ACUTE = 'aáeéiíoóuúAÁEÉIÍOÓUÚ';
const DIAERESIS = 'aäeëiïoöuüAÄEËIÏOÖUÜ';

export const LAYOUT_SPECS: Record<TypingLayout, LayoutSpec> = {
  us: { keys: US_KEYS },

  // UK: "#~" and "\|" are the two ISO keys a US keyboard lacks.
  gb: {
    keys: {
      ...US_KEYS, Backquote: ['`', '¬'], Digit2: ['2', '"'], Digit3: ['3', '£'], Digit4: ['4', '$', '€'], Quote: ["'", '@'],
      Backslash: ['', ''], IntlHash: ['#', '~'], IntlBackslash: ['\\', '|'],
    },
  },

  // German (QWERTZ).
  de: {
    letters: { KeyY: 'z', KeyZ: 'y' },
    keys: {
      Backquote: ['dead:^', '°'], Digit1: ['1', '!'], Digit2: ['2', '"', '²'], Digit3: ['3', '§', '³'], Digit4: ['4', '$'], Digit5: ['5', '%'],
      Digit6: ['6', '&'], Digit7: ['7', '/', '{'], Digit8: ['8', '(', '['], Digit9: ['9', ')', ']'], Digit0: ['0', '=', '}'],
      Minus: ['ß', '?', '\\'], Equal: ['dead:´', 'dead:`'], KeyQ: ['', '', '@'], KeyE: ['', '', '€'], KeyM: ['', '', 'µ'],
      BracketLeft: ['ü', 'Ü'], BracketRight: ['+', '*', '~'], Semicolon: ['ö', 'Ö'], Quote: ['ä', 'Ä'], Backslash: ['#', "'"],
      IntlBackslash: ['<', '>', '|'], Comma: [',', ';'], Period: ['.', ':'], Slash: ['-', '_'],
    },
    compose: { '^': CIRCUMFLEX, '´': ACUTE + 'yýYÝ', '`': GRAVE },
  },

  // French (AZERTY). "~" and "`" are dead on Windows but not on Linux: left out.
  fr: {
    letters: { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', Semicolon: 'm', KeyM: '' },
    keys: {
      Backquote: ['²'], Digit1: ['&', '1'], Digit2: ['é', '2'], Digit3: ['"', '3', '#'], Digit4: ["'", '4', '{'], Digit5: ['(', '5', '['],
      Digit6: ['-', '6', '|'], Digit7: ['è', '7'], Digit8: ['_', '8', '\\'], Digit9: ['ç', '9', '^'], Digit0: ['à', '0', '@'],
      Minus: [')', '°', ']'], Equal: ['=', '+', '}'], KeyE: ['', '', '€'], BracketLeft: ['dead:^', 'dead:¨'], BracketRight: ['$', '£', '¤'],
      Quote: ['ù', '%'], Backslash: ['*', 'µ'], IntlBackslash: ['<', '>'], KeyM: [',', '?'], Comma: [';', '.'], Period: [':', '/'],
      Slash: ['!', '§'],
    },
    compose: { '^': CIRCUMFLEX, '¨': DIAERESIS + 'yÿ' },
  },

  // Spanish (Spain). "~" is dead on Windows but not on Linux: left out.
  es: {
    keys: {
      Backquote: ['º', 'ª', '\\'], Digit1: ['1', '!', '|'], Digit2: ['2', '"', '@'], Digit3: ['3', '·', '#'], Digit4: ['4', '$'],
      Digit5: ['5', '%'], Digit6: ['6', '&', '¬'], Digit7: ['7', '/'], Digit8: ['8', '('], Digit9: ['9', ')'], Digit0: ['0', '='],
      Minus: ["'", '?'], Equal: ['¡', '¿'], KeyE: ['', '', '€'], BracketLeft: ['dead:`', 'dead:^', '['], BracketRight: ['+', '*', ']'],
      Semicolon: ['ñ', 'Ñ'], Quote: ['dead:´', 'dead:¨', '{'], Backslash: ['ç', 'Ç', '}'], IntlBackslash: ['<', '>'],
      Comma: [',', ';'], Period: ['.', ':'], Slash: ['-', '_'],
    },
    compose: { '´': ACUTE, '`': GRAVE, '^': CIRCUMFLEX, '¨': DIAERESIS },
  },

  // Japanese (JIS, IME off / direct input). "¥" is left out: Windows and Linux differ.
  jp: {
    keys: {
      Digit1: ['1', '!'], Digit2: ['2', '"'], Digit3: ['3', '#'], Digit4: ['4', '$'], Digit5: ['5', '%'], Digit6: ['6', '&'],
      Digit7: ['7', "'"], Digit8: ['8', '('], Digit9: ['9', ')'], Digit0: ['0'], Minus: ['-', '='], Equal: ['^', '~'],
      IntlYen: ['\\', '|'], BracketLeft: ['@', '`'], BracketRight: ['[', '{'], Semicolon: [';', '+'], Quote: [':', '*'],
      Backslash: [']', '}'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], IntlRo: ['\\', '_'],
    },
  },
};

type CharMap = Map<string, KeyStroke[]>;
const SPACE: KeyStroke = { code: 'Space', shift: false };
const DEAD = 'dead:';

function build(spec: LayoutSpec): CharMap {
  const map: CharMap = new Map();
  const add = (ch: string, strokes: KeyStroke[]) => {
    if (ch && !map.has(ch)) map.set(ch, strokes);
  };
  add(' ', [SPACE]);
  add('\n', [{ code: 'Enter', shift: false }]);
  add('\t', [{ code: 'Tab', shift: false }]);
  const letters: Record<string, string> = {};
  for (const l of US_LETTERS) letters[`Key${l.toUpperCase()}`] = l;
  Object.assign(letters, spec.letters);
  for (const [code, l] of Object.entries(letters)) {
    if (!l) continue;
    add(l, [{ code, shift: false }]);
    add(l.toUpperCase(), [{ code, shift: true }]);
  }
  // Preference when a character is on several keys: a plain key over AltGr, and
  // any direct key over a dead key (which needs a second press).
  const dead = new Map<string, KeyStroke>();
  for (const pass of ['direct', 'dead'] as const) {
    for (const level of [0, 1, 2] as const) {
      for (const [code, chars] of Object.entries(spec.keys)) {
        const c = chars[level];
        if (!c || c.startsWith(DEAD) !== (pass === 'dead')) continue;
        const stroke: KeyStroke = { code, shift: level === 1, ...(level === 2 ? { altGr: true } : {}) };
        if (pass === 'dead') {
          const ch = c.slice(DEAD.length);
          dead.set(ch, stroke);
          add(ch, [stroke, SPACE]);
        } else {
          add(c, [stroke]);
        }
      }
    }
  }
  for (const [d, pairs] of Object.entries(spec.compose ?? {})) {
    const deadStroke = dead.get(d);
    if (!deadStroke) throw new Error(`compose uses ${d}, which is not a dead key`);
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const base = map.get(pairs[i]);
      if (base?.length === 1) add(pairs[i + 1], [deadStroke, base[0]]);
    }
  }
  return map;
}

const BUILT = new Map<TypingLayout, CharMap>();

/** Key presses that type `ch` on the host layout; null if that layout cannot type it reliably. */
export function layoutKeys(ch: string, layout: TypingLayout = 'us'): KeyStroke[] | null {
  let map = BUILT.get(layout);
  if (!map) {
    map = build(LAYOUT_SPECS[layout]);
    BUILT.set(layout, map);
  }
  return map.get(ch) ?? null;
}

/** Key codes to press, in order, for one stroke. */
export function strokeCodes(k: KeyStroke): string[] {
  return [...(k.altGr ? ['AltRight'] : []), ...(k.shift ? ['ShiftLeft'] : []), k.code];
}

export function isTypingLayout(v: unknown): v is TypingLayout {
  return typeof v === 'string' && v in TYPING_LAYOUTS;
}
