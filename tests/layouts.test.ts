// Typing layouts: behaviour per layout, and every table entry checked against
// the Linux xkb definitions (when /usr/share/X11/xkb is installed).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutForLocale } from '../src/shared/api';
import { LAYOUT_SPECS, layoutKeys, strokeCodes, TYPING_LAYOUTS, type TypingLayout } from '../src/protocol/layouts';

/** Each character as "Mods+Code" strokes joined by " then ". */
const how = (ch: string, l: TypingLayout) => layoutKeys(ch, l)?.map((k) => strokeCodes(k).join('+')).join(' then ') ?? null;

describe('typing layouts', () => {
  it('US', () => {
    expect(how('a', 'us')).toBe('KeyA');
    expect(how('A', 'us')).toBe('ShiftLeft+KeyA');
    expect(how('@', 'us')).toBe('ShiftLeft+Digit2');
    expect(how('?', 'us')).toBe('ShiftLeft+Slash');
    expect(how('\\', 'us')).toBe('Backslash');
    expect(how('\n', 'us')).toBe('Enter');
    expect(how('é', 'us')).toBeNull();
    expect(how('£', 'us')).toBeNull();
  });

  it('UK uses the ISO keys and moves " and @', () => {
    expect(how('"', 'gb')).toBe('ShiftLeft+Digit2');
    expect(how('@', 'gb')).toBe('ShiftLeft+Quote');
    expect(how('#', 'gb')).toBe('IntlHash');
    expect(how('~', 'gb')).toBe('ShiftLeft+IntlHash');
    expect(how('\\', 'gb')).toBe('IntlBackslash');
    expect(how('|', 'gb')).toBe('ShiftLeft+IntlBackslash');
    expect(how('£', 'gb')).toBe('ShiftLeft+Digit3');
    expect(how('€', 'gb')).toBe('AltRight+Digit4');
    for (const ch of 'aZ1!/?;:[]{}') expect(how(ch, 'gb')).toBe(how(ch, 'us'));
  });

  it('German: QWERTZ, AltGr symbols, dead keys', () => {
    expect(how('z', 'de')).toBe('KeyY');
    expect(how('Y', 'de')).toBe('ShiftLeft+KeyZ');
    expect(how('ß', 'de')).toBe('Minus');
    expect(how('ü', 'de')).toBe('BracketLeft');
    expect(how('@', 'de')).toBe('AltRight+KeyQ');
    expect(how('{', 'de')).toBe('AltRight+Digit7');
    expect(how('\\', 'de')).toBe('AltRight+Minus');
    expect(how('|', 'de')).toBe('AltRight+IntlBackslash');
    expect(how('~', 'de')).toBe('AltRight+BracketRight');
    expect(how('/', 'de')).toBe('ShiftLeft+Digit7');
    expect(how('^', 'de')).toBe('Backquote then Space');
    expect(how('é', 'de')).toBe('Equal then KeyE');
    expect(how('È', 'de')).toBe('ShiftLeft+Equal then ShiftLeft+KeyE');
    expect(how('ô', 'de')).toBe('Backquote then KeyO');
  });

  it('French: AZERTY, shifted digits, dead keys; leaves out what Windows and Linux type differently', () => {
    expect(how('a', 'fr')).toBe('KeyQ');
    expect(how('q', 'fr')).toBe('KeyA');
    expect(how('w', 'fr')).toBe('KeyZ');
    expect(how('m', 'fr')).toBe('Semicolon');
    expect(how(',', 'fr')).toBe('KeyM');
    expect(how('1', 'fr')).toBe('ShiftLeft+Digit1');
    expect(how('é', 'fr')).toBe('Digit2');
    expect(how('@', 'fr')).toBe('AltRight+Digit0');
    expect(how('^', 'fr')).toBe('AltRight+Digit9');
    expect(how('ê', 'fr')).toBe('BracketLeft then KeyE');
    expect(how('ï', 'fr')).toBe('ShiftLeft+BracketLeft then KeyI');
    expect(how('.', 'fr')).toBe('ShiftLeft+Comma');
    expect(how('~', 'fr')).toBeNull();
    expect(how('`', 'fr')).toBeNull();
  });

  it('Spanish', () => {
    expect(how('ñ', 'es')).toBe('Semicolon');
    expect(how('@', 'es')).toBe('AltRight+Digit2');
    expect(how('\\', 'es')).toBe('AltRight+Backquote');
    expect(how('á', 'es')).toBe('Quote then KeyA');
    expect(how('ü', 'es')).toBe('ShiftLeft+Quote then KeyU');
    expect(how('¿', 'es')).toBe('ShiftLeft+Equal');
    expect(how('~', 'es')).toBeNull();
  });

  it('Japanese (JIS)', () => {
    expect(how('@', 'jp')).toBe('BracketLeft');
    expect(how(':', 'jp')).toBe('Quote');
    expect(how('_', 'jp')).toBe('ShiftLeft+IntlRo');
    expect(how('\\', 'jp')).toBe('IntlYen');
    expect(how('~', 'jp')).toBe('ShiftLeft+Equal');
    expect(how('"', 'jp')).toBe('ShiftLeft+Digit2');
  });

  it('types every printable ASCII character on US, UK, German and Japanese', () => {
    const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    for (const l of ['us', 'gb', 'de', 'jp'] as const) expect(ascii.filter((c) => !layoutKeys(c, l)), l).toEqual([]);
    // French and Spanish leave out only the keys Windows and Linux disagree on.
    expect(ascii.filter((c) => !layoutKeys(c, 'fr'))).toEqual(['`', '~']);
    expect(ascii.filter((c) => !layoutKeys(c, 'es'))).toEqual(['~']);
  });

  it('defaults new servers from this computer\'s language', () => {
    expect(layoutForLocale('en-US')).toBe('us');
    expect(layoutForLocale('en-GB')).toBe('gb');
    expect(layoutForLocale('de-DE')).toBe('de');
    expect(layoutForLocale('de-CH')).toBe('us');
    expect(layoutForLocale('fr')).toBe('fr');
    expect(layoutForLocale('fr-CA')).toBe('us');
    expect(layoutForLocale('es-ES')).toBe('es');
    expect(layoutForLocale('es-MX')).toBe('us');
    expect(layoutForLocale('ja')).toBe('jp');
    expect(Object.keys(TYPING_LAYOUTS)).toEqual(['us', 'gb', 'de', 'fr', 'es', 'jp']);
  });
});

// --- cross-check against xkb -------------------------------------------------

const XKB = '/usr/share/X11/xkb/symbols';
/** xkb key name → KeyboardEvent.code. */
const XKB_CODE: Record<string, string> = {
  TLDE: 'Backquote', AE01: 'Digit1', AE02: 'Digit2', AE03: 'Digit3', AE04: 'Digit4', AE05: 'Digit5', AE06: 'Digit6', AE07: 'Digit7',
  AE08: 'Digit8', AE09: 'Digit9', AE10: 'Digit0', AE11: 'Minus', AE12: 'Equal', AE13: 'IntlYen',
  AD01: 'KeyQ', AD02: 'KeyW', AD03: 'KeyE', AD04: 'KeyR', AD05: 'KeyT', AD06: 'KeyY', AD07: 'KeyU', AD08: 'KeyI', AD09: 'KeyO', AD10: 'KeyP',
  AD11: 'BracketLeft', AD12: 'BracketRight', AC01: 'KeyA', AC02: 'KeyS', AC03: 'KeyD', AC04: 'KeyF', AC05: 'KeyG', AC06: 'KeyH',
  AC07: 'KeyJ', AC08: 'KeyK', AC09: 'KeyL', AC10: 'Semicolon', AC11: 'Quote', AC12: 'Backslash', BKSL: 'Backslash',
  LSGT: 'IntlBackslash', AB01: 'KeyZ', AB02: 'KeyX', AB03: 'KeyC', AB04: 'KeyV', AB05: 'KeyB', AB06: 'KeyN', AB07: 'KeyM',
  AB08: 'Comma', AB09: 'Period', AB10: 'Slash', AB11: 'IntlRo',
};
/** Keysym names used by these layouts → character (as in the tables: "dead:" = dead key). */
const KEYSYM: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', apostrophe: "'", parenleft: '(',
  parenright: ')', asterisk: '*', plus: '+', comma: ',', minus: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<',
  equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', notsign: '¬', sterling: '£', EuroSign: '€',
  section: '§', degree: '°', twosuperior: '²', threesuperior: '³', ssharp: 'ß', udiaeresis: 'ü', Udiaeresis: 'Ü', odiaeresis: 'ö',
  Odiaeresis: 'Ö', adiaeresis: 'ä', Adiaeresis: 'Ä', mu: 'µ', eacute: 'é', egrave: 'è', ccedilla: 'ç', Ccedilla: 'Ç', agrave: 'à',
  ugrave: 'ù', currency: '¤', masculine: 'º', ordfeminine: 'ª', periodcentered: '·', exclamdown: '¡', questiondown: '¿',
  ntilde: 'ñ', Ntilde: 'Ñ', yen: '¥', dead_circumflex: 'dead:^', dead_acute: 'dead:´', dead_grave: 'dead:`', dead_diaeresis: 'dead:¨', dead_tilde: 'dead:~',
};
const XKB_LAYOUT: Record<TypingLayout, string> = { us: 'us(basic)', gb: 'gb(basic)', de: 'de(basic)', fr: 'fr(basic)', es: 'es(basic)', jp: 'jp(106)' };

/** Resolves an xkb symbols section with its includes into key name → levels (later definitions win). */
function xkbKeys(ref: string, out = new Map<string, string[]>()): Map<string, string[]> {
  const m = /^(\w+)(?:\((\w+)\))?$/.exec(ref)!;
  const text = readFileSync(join(XKB, m[1]), 'utf8');
  const sections = [...text.matchAll(/((?:\w+\s+)*)xkb_symbols\s+"(\w+)"\s*\{([\s\S]*?)\n\};/g)];
  const sec = m[2] ? sections.find((s) => s[2] === m[2]) : (sections.find((s) => /\bdefault\b/.test(s[1])) ?? sections[0]);
  if (!sec) throw new Error(`no xkb section ${ref}`);
  for (const line of sec[3].split('\n')) {
    const inc = /^\s*include\s+"([^"]+)"/.exec(line);
    if (inc) {
      for (const part of inc[1].split('+')) if (!/^(level3|kpdl|keypad|nbsp|srvr_ctrl|pc)\b/.test(part)) xkbKeys(part, out);
      continue;
    }
    const key = /key\s+<(\w+)>\s*\{[^[]*\[([^\]]*)\]/.exec(line);
    if (key) out.set(key[1], key[2].split(',').map((x) => x.trim()));
  }
  return out;
}

describe.skipIf(!existsSync(XKB))('layout tables agree with Linux xkb', () => {
  for (const layout of Object.keys(LAYOUT_SPECS) as TypingLayout[]) {
    it(layout, () => {
      const keys = new Map<string, string[]>();
      // Every xkb keymap also loads "pc", which defines the ISO "<>" key for layouts that do not.
      for (const [name, levels] of xkbKeys(XKB_LAYOUT[layout], xkbKeys('pc'))) if (XKB_CODE[name]) keys.set(XKB_CODE[name], levels);
      // xkb names the ISO "#~" key BKSL; the tables use IntlHash for it on UK.
      if (keys.has('Backslash')) keys.set('IntlHash', keys.get('Backslash')!);
      const problems: string[] = [];
      for (const [code, levels] of Object.entries(LAYOUT_SPECS[layout].keys)) {
        levels.forEach((ch, level) => {
          if (!ch) return;
          const sym = keys.get(code)?.[level];
          const got = sym === undefined ? undefined : (KEYSYM[sym] ?? (sym.length === 1 ? sym : `?${sym}`));
          if (got !== ch) problems.push(`${code} level ${level}: table "${ch}", xkb ${sym ?? 'nothing'}`);
        });
      }
      expect(problems).toEqual([]);
    });
  }
});
