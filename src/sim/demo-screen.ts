/**
 * The simulator's `demo` video: a firmware setup screen in the classic blue-and-grey text
 * style, at 800x600 in the VGA 8x16 font. ←/→ switch menus, ↑/↓ select, +/- change an
 * option, and the clock runs. Every value is invented and vendor-neutral.
 */
import { COLOR, TextScreen } from './video';

const BLUE = COLOR.vgaBlue;
const GREY = COLOR.vgaGrey;
const { white: WHITE, black: BLACK } = COLOR;

/** Columns of the frame: the outer box, and the divider before the help pane. */
const LEFT = 0, DIVIDER = 66, RIGHT = 99;
/** Rows: title, menu bar, box top, the help pane's divider, box bottom, status line. */
const TITLE = 0, MENU = 1, TOP = 2, HELP_END = 18, BOTTOM = 35, STATUS = 36;

type Entry =
  | { info: string; value?: string }
  | { pick: string; value: () => string; help: string }
  | { pick: string; options: string[]; help: string }
  | { submenu: string; help: string }
  | { heading: string }
  | Record<string, never>;

const blank: Entry = {};

interface Page { name: string; entries: Entry[] }

const KEYS = ['→←: Select Screen', '↑↓: Select Item', 'Enter: Select', '+/-: Change Option', 'F1: General Help', 'F9: Load Defaults', 'F10: Save and Exit', 'ESC: Exit'];

/** USB keyboard usages the screen reacts to. */
const KEY = { right: 0x4f, left: 0x50, down: 0x51, up: 0x52, plus: 0x2e, minus: 0x2d, padPlus: 0x57, padMinus: 0x56, space: 0x2c } as const;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number) => String(n).padStart(2, '0');

export class SetupScreen extends TextScreen {
  private page = 0;
  /** Selected entry per page (an index into its entries). */
  private selected: number[];
  /** Chosen option per entry, by page and entry index. */
  private choice = new Map<string, number>();
  private readonly pages: Page[];

  constructor(private readonly now: () => Date = () => new Date()) {
    super(BLUE, 'vga');
    this.pages = [
      {
        name: 'Main',
        entries: [
          { info: 'Firmware Version', value: 'SIM-1000 1.20' },
          { info: 'BMC Version', value: '1.36.4' },
          blank,
          { info: 'Processor Type', value: 'Example CPU, 8 cores @ 3.30GHz' },
          blank,
          { info: 'Processor Speed', value: '3300MHz' },
          { info: 'Microcode Update', value: '0x28' },
          { info: 'Cache Size', value: '16384KB' },
          blank,
          { info: 'Total Memory', value: '32768MB' },
          { info: '', value: 'Dual-Channel Memory Mode' },
          { info: 'DIMM_A1', value: '16384MB(DDR4-2666) with ECC' },
          { info: 'DIMM_B1', value: '16384MB(DDR4-2666) with ECC' },
          blank,
          { pick: 'System Date', value: () => { const d = this.now(); return `${DAYS[d.getDay()]} ${two(d.getMonth() + 1)}/${two(d.getDate())}/${d.getFullYear()}`; }, help: 'Set the date. Use Tab to switch between date elements.' },
          { pick: 'System Time', value: () => { const d = this.now(); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; }, help: 'Set the time. Use Tab to switch between time elements.' },
        ],
      },
      {
        name: 'Advanced',
        entries: [
          { submenu: 'CPU Configuration', help: 'CPU configuration parameters.' },
          { submenu: 'SATA Configuration', help: 'SATA device options.' },
          { submenu: 'Network Stack Configuration', help: 'Network stack settings for PXE boot.' },
          blank,
          { pick: 'Virtualization Technology', options: ['Enabled', 'Disabled'], help: 'Lets a hypervisor use the processor\'s virtualization features.' },
          { pick: 'Hyper-Threading', options: ['Enabled', 'Disabled'], help: 'Two threads per processor core.' },
          { pick: 'Restore on AC Power Loss', options: ['Power Off', 'Power On', 'Last State'], help: 'What the system does when power returns after an outage.' },
          { pick: 'Wake on LAN', options: ['Disabled', 'Enabled'], help: 'Power on when a network wake-up packet arrives.' },
        ],
      },
      {
        name: 'Boot',
        entries: [
          { pick: 'Setup Prompt Timeout', options: ['1', '3', '5'], help: 'Seconds to wait for the setup key at startup.' },
          { pick: 'Bootup NumLock State', options: ['On', 'Off'], help: 'Num Lock state after the system starts.' },
          { pick: 'Quiet Boot', options: ['Enabled', 'Disabled'], help: 'Shows a logo instead of startup messages.' },
          { pick: 'Boot Mode', options: ['UEFI', 'Legacy', 'Dual'], help: 'How the system finds operating systems to start.' },
          blank,
          { heading: 'Boot Option Priorities' },
          { pick: 'Boot Option #1', options: ['UEFI: Network Card', 'Hard Disk: SSD 480GB', 'USB: Flash Drive'], help: 'The first device to try starting from.' },
          { pick: 'Boot Option #2', options: ['Hard Disk: SSD 480GB', 'USB: Flash Drive', 'UEFI: Network Card'], help: 'The second device to try starting from.' },
          { pick: 'Boot Option #3', options: ['USB: Flash Drive', 'UEFI: Network Card', 'Hard Disk: SSD 480GB'], help: 'The third device to try starting from.' },
        ],
      },
      {
        name: 'Save & Exit',
        entries: [
          { submenu: 'Save Changes and Reset', help: 'Saves the changes and restarts the system.' },
          { submenu: 'Discard Changes and Exit', help: 'Leaves setup without saving.' },
          blank,
          { submenu: 'Restore Defaults', help: 'Restores the default values of every option.' },
        ],
      },
    ];
    this.selected = this.pages.map((p) => p.entries.findIndex(selectable));
    this.draw();
  }

  key(usage: number) {
    const entries = this.pages[this.page].entries;
    const move = (step: number) => {
      const picks = entries.map((e, i) => (selectable(e) ? i : -1)).filter((i) => i >= 0);
      const at = picks.indexOf(this.selected[this.page]);
      this.selected[this.page] = picks[(at + step + picks.length) % picks.length];
    };
    const change = (step: number) => {
      const e = entries[this.selected[this.page]];
      if (!('options' in e)) return;
      const k = `${this.page}:${this.selected[this.page]}`;
      this.choice.set(k, ((this.choice.get(k) ?? 0) + step + e.options.length) % e.options.length);
    };
    if (usage === KEY.right) this.page = (this.page + 1) % this.pages.length;
    else if (usage === KEY.left) this.page = (this.page + this.pages.length - 1) % this.pages.length;
    else if (usage === KEY.down) move(1);
    else if (usage === KEY.up) move(-1);
    else if (usage === KEY.plus || usage === KEY.padPlus || usage === KEY.space) change(1);
    else if (usage === KEY.minus || usage === KEY.padMinus) change(-1);
    else return;
    this.draw();
  }

  override full(): Uint8Array {
    this.draw();
    return super.full();
  }

  /** Redrawn before each frame, so the clock runs; only changed cells are sent. */
  override next(): Uint8Array | null {
    this.draw();
    return super.next();
  }

  private draw() {
    const W = this.cols;
    const center = (s: string) => s.padStart(Math.floor((W + s.length) / 2)).padEnd(W);
    this.line(TITLE, center('Setup Utility - IPMI Console BMC Simulator'), WHITE, BLUE);
    this.line(MENU, '', GREY, BLUE);
    let col = 2;
    this.pages.forEach((p, i) => {
      const tab = ` ${p.name} `;
      this.write(MENU, col, tab, i === this.page ? BLUE : GREY, i === this.page ? GREY : BLUE);
      col += tab.length + 1;
    });
    for (let r = TOP; r <= BOTTOM; r++) this.line(r, '', BLACK, GREY);
    this.line(STATUS, center('Version 1.0.0. Simulated firmware: every value is invented.'), GREY, BLUE);
    this.frame();

    const page = this.pages[this.page];
    const sel = this.selected[this.page];
    page.entries.forEach((e, i) => {
      const row = TOP + 2 + i;
      const on = i === sel;
      if ('info' in e) {
        this.write(row, 2, e.info ? `${e.info.padEnd(17)}: ${e.value ?? ''}` : `${''.padEnd(19)}${e.value ?? ''}`, BLACK, GREY);
      } else if ('heading' in e) {
        this.write(row, 2, e.heading, BLACK, GREY);
      } else if ('submenu' in e) {
        this.write(row, 2, `► ${e.submenu}`, on ? WHITE : BLUE, GREY);
      } else if ('pick' in e) {
        const value = 'options' in e ? e.options[this.choice.get(`${this.page}:${i}`) ?? 0] : e.value();
        this.write(row, 2, e.pick, on ? WHITE : BLUE, GREY);
        this.write(row, 40, `[${value}]`, on ? WHITE : BLUE, GREY);
      }
    });

    const help = page.entries[sel];
    if (help && 'help' in help) wrap(help.help, RIGHT - DIVIDER - 3).forEach((l, i) => this.write(TOP + 2 + i, DIVIDER + 2, l, BLUE, GREY));
    KEYS.forEach((k, i) => this.write(HELP_END + 1 + i, DIVIDER + 2, k, BLUE, GREY));
  }

  /** The box around the page, the divider before the help pane, and the help pane's own divider. */
  private frame() {
    const hline = (row: number, from: number, to: number) => this.write(row, from, '─'.repeat(to - from + 1), BLUE, GREY);
    hline(TOP, LEFT, RIGHT);
    hline(BOTTOM, LEFT, RIGHT);
    hline(HELP_END, DIVIDER, RIGHT);
    for (let r = TOP + 1; r < BOTTOM; r++) for (const c of [LEFT, DIVIDER, RIGHT]) this.write(r, c, '│', BLUE, GREY);
    const corner = (row: number, col: number, ch: string) => this.write(row, col, ch, BLUE, GREY);
    corner(TOP, LEFT, '┌'); corner(TOP, DIVIDER, '┬'); corner(TOP, RIGHT, '┐');
    corner(BOTTOM, LEFT, '└'); corner(BOTTOM, DIVIDER, '┴'); corner(BOTTOM, RIGHT, '┘');
    corner(HELP_END, DIVIDER, '├'); corner(HELP_END, RIGHT, '┤');
  }
}

function selectable(e: Entry): boolean {
  return 'pick' in e || 'submenu' in e;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function demoScreen(): SetupScreen {
  return new SetupScreen();
}
