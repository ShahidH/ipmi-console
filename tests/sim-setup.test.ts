// The simulator's firmware setup screen (demo video): rendered through the real codec,
// readable by text recognition, and driven by the keyboard.
import { describe, expect, it } from 'vitest';
import { SetupScreen } from '../src/sim/demo-screen';
import { readScreen } from '../src/textrec/recognize';
import { AspeedDecoder } from '../src/video/decoder';

const RIGHT = 0x4f, DOWN = 0x51, PLUS = 0x2e;

function setup() {
  const screen = new SetupScreen(() => new Date(2026, 9, 10, 22, 51, 7));
  const dec = new AspeedDecoder();
  const f = dec.decode(screen.full());
  const read = () => {
    const next = screen.next();
    if (next) dec.decode(next);
    return readScreen(dec.rgba, f.width, f.height)!.lines.map((l) => l.trimEnd());
  };
  return { screen, f, read };
}

describe('simulator setup screen', () => {
  it('is an 800x600 VGA text screen that text recognition reads exactly', () => {
    const { f, read } = setup();
    expect([f.width, f.height]).toEqual([800, 600]);
    const lines = read();
    expect(lines.join('\n')).toContain('Processor Speed  : 3300MHz');
    expect(lines.join('\n')).toContain('[Sat 10/10/2026]');
    expect(lines.join('\n')).toContain('[22:51:07]');
    expect(lines.join('\n')).not.toContain('�');
  });

  it('switches menus with the arrow keys and changes options with +', () => {
    const { screen, read } = setup();
    screen.key(RIGHT);
    expect(read().join('\n')).toContain('► CPU Configuration');
    // Down past the three submenus to the first option, then change it.
    for (let i = 0; i < 3; i++) screen.key(DOWN);
    expect(read().join('\n')).toMatch(/Virtualization Technology\s+\[Enabled\]/);
    screen.key(PLUS);
    expect(read().join('\n')).toMatch(/Virtualization Technology\s+\[Disabled\]/);
  });

  it('only sends what changed, such as the running clock', () => {
    let now = new Date(2026, 9, 10, 22, 51, 7);
    const screen = new SetupScreen(() => now);
    const full = screen.full();
    expect(screen.next()).toBeNull();
    now = new Date(2026, 9, 10, 22, 51, 8);
    const tick = screen.next()!;
    expect(tick.length).toBeLessThan(full.length / 20);
  });
});
