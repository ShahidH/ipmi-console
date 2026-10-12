// The main-process session controller against the simulated BMC: no Electron involved.
import { afterEach, describe, expect, it } from 'vitest';
import type { EventChannel } from '../../src/shared/api';
import { KvmController, type ControllerStore } from '../../src/main/kvm-controller';
import type { ServerEntry } from '../../src/main/store';
import { Op } from '../../src/protocol/ivtp';
import { findScenario, type Fault, type Scenario } from '../../src/sim/scenario';
import { SimBmc } from '../../src/sim/server';

const until = async (cond: () => boolean, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

let bmc: SimBmc | undefined;
let ctl: KvmController | undefined;
afterEach(async () => {
  await ctl?.disconnect();
  await bmc?.close();
  bmc = ctl = undefined;
});

/** The default simulated BMC with these faults. */
const withFaults = (faults: Fault[], more: Partial<Scenario> = {}): Scenario => ({ ...findScenario('sp-195'), name: 'test', faults, ...more });

async function setup(scenario: string | Scenario = 'sp-195', server: Partial<ServerEntry> = {}, sleep: (ms: number) => Promise<void> = async () => {}) {
  bmc = new SimBmc(typeof scenario === 'string' ? findScenario(scenario) : scenario);
  await bmc.listen();
  const servers = new Map<string, ServerEntry>([['s1', {
    id: 's1', name: 'sim', host: '127.0.0.1', webScheme: 'http', webPort: bmc.webPort, username: 'admin', profile: 'auto', family: 'auto', keyboardMode: 'auto', legacyTls: false, ...server,
  }]]);
  const touched: string[] = [];
  const store: ControllerStore = {
    getServer: (id) => servers.get(id),
    storedPassword: () => undefined,
    getPin: () => undefined,
    fingerprintCache: () => new Map(),
    touchServer: (id) => void touched.push(id),
    upsertServer: (s) => { servers.set(s.id, s); return s.id; },
  };
  const sent: Array<{ channel: EventChannel; args: unknown[] }> = [];
  ctl = new KvmController({ send: (channel, ...args) => void sent.push({ channel, args }), log: () => {}, store, sleep });
  const typed = () => bmc!.events.filter((e) => e.input?.kind === 'key' && e.input.down && e.input.char).map((e) => (e.input as { char: string }).char).join('');
  const pressed = () => bmc!.events.filter((e) => e.input?.kind === 'key' && e.input.down).map((e) => e.input as { name: string; modifiers: number });
  const mice = () => bmc!.events.filter((e) => e.input?.kind === 'mouse').map((e) => e.input as { x: number; y: number; buttons: number });
  return { ctl, servers, touched, sent, typed, pressed, mice, bmc };
}

describe('KvmController', () => {
  it('asks for a password when none is given or stored', async () => {
    const { ctl } = await setup();
    expect(await ctl.connect('s1')).toEqual({ error: 'Password required.', kind: 'password' });
    expect(await ctl.connect('nope', 'admin')).toEqual({ error: 'Unknown server.' });
  });

  it('connects, forwards video and session info, and records the connect', async () => {
    const { ctl, sent, touched } = await setup();
    expect(await ctl.connect('s1', 'admin')).toMatchObject({ ok: true, family: 'megarac-sp' });
    expect(ctl.live).toBe(true);
    expect(touched).toEqual(['s1']);
    await until(() => sent.some((m) => m.channel === 'kvm:frame'), 5000, 'a video frame');
    expect(sent.find((m) => m.channel === 'kvm:status' && (m.args[0] as { phase: string }).phase === 'connected')).toBeTruthy();
    expect(sent.some((m) => m.channel === 'kvm:info' && (m.args[0] as { keyboardMode?: string }).keyboardMode)).toBe(true);
  });

  it('reports a wrong password as an auth error', async () => {
    const { ctl } = await setup();
    expect(await ctl.connect('s1', 'wrong')).toMatchObject({ kind: 'auth' });
    expect(ctl.live).toBe(false);
  });

  it('types text as US-layout key presses and counts what it skipped', async () => {
    const { ctl, typed } = await setup();
    await ctl.connect('s1', 'admin');
    expect(await ctl.typeText('Hi there! 42/?"é')).toEqual({ typed: 15, skipped: 1, cancelled: false });
    await until(() => typed().includes('Hi there! 42/?"'), 5000, 'typed text');
  });

  it('types with the UK layout once chosen, and remembers the choice', async () => {
    const { ctl, servers, pressed, sent } = await setup();
    await ctl.connect('s1', 'admin');
    ctl.setTypingLayout('gb');
    expect(servers.get('s1')!.typingLayout).toBe('gb');
    expect(sent.at(-1)!.args[0]).toMatchObject({ typingLayout: 'gb' });
    expect(await ctl.typeText('"@#£')).toEqual({ typed: 4, skipped: 0, cancelled: false });
    await until(() => pressed().length >= 4, 5000, 'UK keys');
    expect(pressed().slice(-4).map((k) => `${k.modifiers & 0x02 ? 'Shift+' : ''}${k.name}`)).toEqual(['Shift+Digit2', 'Shift+Quote', 'IntlHash', 'Shift+Digit3']);
  });

  it('types German with QWERTZ positions and dead keys', async () => {
    const { ctl, pressed } = await setup('sp-195', { typingLayout: 'de' });
    await ctl.connect('s1', 'admin');
    expect(await ctl.typeText('zé@')).toEqual({ typed: 3, skipped: 0, cancelled: false });
    await until(() => pressed().length >= 4, 5000, 'keys');
    expect(pressed().slice(-4).map((k) => k.name)).toEqual(['KeyY', 'Equal', 'KeyE', 'KeyQ']);
    expect(pressed().at(-1)!.modifiers & 0x40).toBe(0x40); // AltGr (right Alt) for @
  });

  it('treats Windows line endings as one Enter', async () => {
    const { ctl, pressed } = await setup();
    await ctl.connect('s1', 'admin');
    expect(await ctl.typeText('a\r\nb')).toEqual({ typed: 3, skipped: 0, cancelled: false });
    await until(() => pressed().length >= 3, 5000, 'keys');
    expect(pressed().slice(-3).map((k) => k.name)).toEqual(['KeyA', 'Enter', 'KeyB']);
  });

  it('reports typing progress and can be cancelled', async () => {
    // Each pause yields to the event loop, so the run is still going when it is cancelled.
    const { ctl, sent } = await setup('sp-195', {}, () => new Promise((r) => setImmediate(r)));
    await ctl.connect('s1', 'admin');
    const run = ctl.typeText('x'.repeat(5000));
    await new Promise((r) => setTimeout(r, 30));
    ctl.cancelTyping();
    const r = await run;
    expect(r.cancelled).toBe(true);
    expect(r.typed).toBeLessThan(5000);
    expect(sent.filter((m) => m.channel === 'kvm:typing').at(-1)!.args[0]).toEqual({ done: 5000, total: 5000 });
  });

  it('releases keys held from the paste shortcut before typing', async () => {
    const { ctl, pressed } = await setup('sp-195', { keyboardMode: 'state' });
    await ctl.connect('s1', 'admin');
    ctl.key('ControlLeft', true);
    ctl.key('AltLeft', true);
    await ctl.typeText('a');
    await until(() => pressed().some((k) => k.name === 'KeyA'), 5000, 'typed key');
    expect(pressed().find((k) => k.name === 'KeyA')!.modifiers).toBe(0);
  });

  it('sends physical keys and ignores unknown codes', async () => {
    const { ctl, typed } = await setup('sp-195', { keyboardMode: 'state' });
    await ctl.connect('s1', 'admin');
    for (const code of ['KeyO', 'NotAKey', 'KeyK']) {
      ctl.key(code, true);
      ctl.key(code, false);
    }
    await until(() => typed().includes('ok'), 5000, 'keys');
  });

  it('sends chords with their modifiers', async () => {
    const { ctl, pressed } = await setup();
    await ctl.connect('s1', 'admin');
    await ctl.chord('ctrl-alt-del');
    await until(() => pressed().some((k) => k.name === 'Delete' && (k.modifiers & 0x05) === 0x05), 5000, 'Ctrl+Alt+Del');
  });

  it('maps normalised pointer positions onto the frame', async () => {
    const { ctl, mice } = await setup();
    await ctl.connect('s1', 'admin');
    ctl.setFrameSize(640, 480);
    ctl.mouse({ x: 0.5, y: 0.25, buttons: 1 });
    await until(() => mice().some((m) => m.buttons === 1), 5000, 'mouse');
    const m = mice().find((e) => e.buttons === 1)!;
    // HID absolute coordinates span 0..32767 whatever the frame size.
    expect(m.x / 32767).toBeCloseTo(0.5, 2);
    expect(m.y / 32767).toBeCloseTo(0.25, 2);
  });

  it('sends power actions', async () => {
    const { ctl, bmc } = await setup();
    await ctl.connect('s1', 'admin');
    ctl.power('reset');
    await until(() => bmc.events.some((e) => e.msg.includes('POWER CONTROL: hard reset')), 5000, 'power');
  });

  it('uses the keyboard compatibility chosen for the server', async () => {
    const { ctl, sent } = await setup('sp-195', { keyboardMode: 'state' });
    await ctl.connect('s1', 'admin');
    expect(ctl.keyboardMode).toBe('state');
    expect(sent.some((m) => m.channel === 'kvm:info' && (m.args[0] as { keyboardMode?: string; keyboardModeAuto?: boolean }).keyboardMode === 'state'
      && (m.args[0] as { keyboardModeAuto?: boolean }).keyboardModeAuto === false)).toBe(true);
  });

  it('ignores input when there is no session', async () => {
    const { ctl } = await setup();
    expect(() => { ctl.key('KeyA', true); ctl.mouse({ x: 0.5, y: 0.5 }); ctl.power('off'); }).not.toThrow();
    expect(await ctl.typeText('abc')).toEqual({ typed: 0, skipped: 0, cancelled: true });
    expect(ctl.retryNow()).toBe(false);
  });

  it('reports a drop and reconnects; retryNow skips the wait', async () => {
    const { ctl, sent } = await setup('drop');
    await ctl.connect('s1', 'admin');
    await until(() => sent.some((m) => m.channel === 'kvm:ended' && (m.args[0] as { willReconnect: boolean }).willReconnect), 8000, 'drop');
    expect(ctl.retryNow()).toBe(true);
    await until(() => sent.filter((m) => m.channel === 'kvm:status' && (m.args[0] as { phase: string }).phase === 'connected').length >= 2, 8000, 'reconnect');
  });

  it('stops forwarding events after disconnect', async () => {
    const { ctl, sent } = await setup();
    await ctl.connect('s1', 'admin');
    await ctl.disconnect();
    expect(ctl.live).toBe(false);
    const n = sent.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.slice(n).filter((m) => m.channel === 'kvm:ended')).toEqual([]);
  });
});

describe('KvmController: session edge cases', () => {
  const ended = (sent: Array<{ channel: EventChannel; args: unknown[] }>) =>
    sent.filter((m) => m.channel === 'kvm:ended').map((m) => m.args[0] as { reason: string; willReconnect: boolean });
  const infos = (sent: Array<{ channel: EventChannel; args: unknown[] }>) =>
    sent.filter((m) => m.channel === 'kvm:info').map((m) => m.args[0] as Record<string, unknown>);
  const notices = (sent: Array<{ channel: EventChannel; args: unknown[] }>) =>
    sent.filter((m) => m.channel === 'kvm:notice').map((m) => (m.args[0] as { title: string }).title);
  const openSessions = (b: SimBmc) => b.sessions.filter((x) => !(x as unknown as { closed: boolean }).closed).length;

  it('cancelling during login leaves nothing open on the BMC', async () => {
    const { ctl, bmc, sent } = await setup();
    // Cancel the moment the login has gone through (the simulator is too quick to catch otherwise).
    const push = sent.push.bind(sent);
    let cancelled: Promise<void> | undefined;
    sent.push = (...items) => {
      if (items.some((m) => m.channel === 'kvm:status' && (m.args[0] as { phase: string }).phase === 'launch')) cancelled ??= ctl.disconnect();
      return push(...items);
    };
    const pending = ctl.connect('s1', 'admin');
    await until(() => !!cancelled, 5000, 'login');
    await cancelled;
    expect(await pending).toEqual({ cancelled: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(bmc.logouts).toBe(bmc.logins);
    expect(openSessions(bmc)).toBe(0);
    expect(ctl.live).toBe(false);
  });

  it('cancelling during the KVM handshake closes the connection and logs out', async () => {
    // A slow link keeps the handshake going long enough to cancel in the middle of it.
    const { ctl, bmc, sent } = await setup(withFaults([{ do: 'latency', ms: 300 }]));
    const pending = ctl.connect('s1', 'admin');
    await until(() => sent.some((m) => m.channel === 'kvm:status' && (m.args[0] as { phase: string }).phase === 'handshake'), 5000, 'handshake');
    await ctl.disconnect();
    expect(await pending).toEqual({ cancelled: true });
    await new Promise((r) => setTimeout(r, 1500));
    expect(bmc.logouts).toBe(bmc.logins);
    expect(openSessions(bmc)).toBe(0);
    expect(ctl.live).toBe(false);
  });

  it('disconnecting sends STOP and closes gracefully, even on a slow link', async () => {
    const { ctl, bmc } = await setup(withFaults([{ do: 'latency', ms: 300 }]));
    await ctl.connect('s1', 'admin');
    await ctl.disconnect();
    expect(bmc.received.some((p) => p.type === Op.STOP_SESSION_IMMEDIATE)).toBe(true);
    expect(bmc.events.some((e) => e.msg.includes('client sent STOP_SESSION'))).toBe(true);
    expect(bmc.logouts).toBe(1);
  });

  it('does not reconnect after the BMC ends the session on purpose', async () => {
    const { ctl, sent } = await setup(withFaults([{ at: 300, do: 'stop', reason: 2 }]));
    await ctl.connect('s1', 'admin');
    await until(() => ended(sent).length > 0, 5000, 'session end');
    expect(ended(sent)[0]).toMatchObject({ willReconnect: false, reason: expect.stringMatching(/administrator/) });
  });

  it('still reconnects after a configuration change (reason 5)', async () => {
    const { ctl, sent } = await setup(withFaults([{ at: 300, do: 'stop', reason: 5 }]));
    await ctl.connect('s1', 'admin');
    await until(() => ended(sent).length > 0, 5000, 'session end');
    expect(ended(sent)[0].willReconnect).toBe(true);
  });

  it('ends the session when the console owner denies access', async () => {
    const { ctl, bmc, sent } = await setup(withFaults([
      { at: 200, do: 'share', code: 2, user: 'operator', ip: '10.1.2.3' },
      { at: 500, do: 'share', code: 4, answer: 1, user: 'operator', ip: '10.1.2.3' },
    ]));
    await ctl.connect('s1', 'admin');
    await until(() => ended(sent).length > 0, 5000, 'session end');
    expect(infos(sent).some((i) => i.access === 'waiting')).toBe(true);
    expect(ended(sent)[0]).toMatchObject({ willReconnect: false, reason: 'operator denied access to this KVM session.' });
    expect(bmc.received.some((p) => p.type === Op.STOP_SESSION_IMMEDIATE)).toBe(true);
    await until(() => bmc.logouts === 1, 3000, 'logout');
  });

  it('ends a second session from the same computer, as JViewer does', async () => {
    const { ctl, sent } = await setup(withFaults([{ at: 200, do: 'share', code: 2, user: 'admin', ip: '127.0.0.1' }]));
    await ctl.connect('s1', 'admin');
    await until(() => ended(sent).length > 0, 5000, 'session end');
    expect(ended(sent)[0]).toMatchObject({ willReconnect: false, reason: expect.stringMatching(/same computer/) });
  });

  it('view-only access blocks keyboard, mouse and power until the other session ends', async () => {
    const { ctl, sent, pressed, bmc } = await setup(withFaults([
      { at: 200, do: 'share', code: 2, user: 'operator', ip: '10.1.2.3' },
      { at: 400, do: 'share', code: 4, answer: 2, user: 'operator', ip: '10.1.2.3' },
      { at: 1200, do: 'share-ended' },
    ]));
    await ctl.connect('s1', 'admin');
    await until(() => infos(sent).some((i) => i.access === 'view-only'), 5000, 'view only');
    expect(infos(sent).find((i) => i.access === 'view-only')).toMatchObject({ sharedWith: 'operator (10.1.2.3)' });
    expect(notices(sent)).toContain('operator allowed view only.');
    expect(ctl.canControl).toBe(false);
    ctl.key('KeyQ', true);
    ctl.mouse({ x: 0.5, y: 0.5, buttons: 1 });
    expect(await ctl.power('reset')).toBe('not-allowed');
    expect(await ctl.typeText('abc')).toMatchObject({ typed: 0, cancelled: true });
    await until(() => infos(sent).at(-1)?.access === 'full', 5000, 'full access again');
    expect(notices(sent)).toContain('You now have full control of the server.');
    ctl.key('KeyW', true);
    await until(() => pressed().some((k) => k.name === 'KeyW'), 3000, 'key after full access');
    expect(pressed().some((k) => k.name === 'KeyQ')).toBe(false);
    expect(bmc.events.some((e) => e.msg.includes('POWER CONTROL'))).toBe(false);
  });

  it('a withdrawn access request closes the dialog and a late answer is not sent', async () => {
    const { ctl, sent, bmc } = await setup(withFaults([
      { at: 200, do: 'share-request', user: 'operator', ip: '10.1.2.3' },
      { at: 500, do: 'share', code: 0, user: 'operator', ip: '10.1.2.3' },
    ]));
    await ctl.connect('s1', 'admin');
    await until(() => sent.some((m) => m.channel === 'kvm:shareRequest' && m.args[0] === null), 5000, 'request withdrawn');
    ctl.answerShare(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(bmc.received.some((p) => p.type === Op.KVM_SHARING)).toBe(false);
  });

  it('reports a refused power command', async () => {
    const { ctl } = await setup(withFaults([{ do: 'refuse-power' }]));
    await ctl.connect('s1', 'admin');
    expect(await ctl.power('reset')).toBe('refused');
  });

  it('checks the power state again after a power command', async () => {
    const { ctl, bmc } = await setup();
    await ctl.connect('s1', 'admin');
    const asked = () => bmc.received.filter((p) => p.type === Op.POWER_STATUS).length;
    expect(await ctl.power('reset')).toBe('done');
    const before = asked();
    await until(() => asked() > before, 4000, 'power status re-check');
  }, 10000);

  it('checks the power state while the screen has no signal', async () => {
    const { ctl, bmc } = await setup(withFaults([{ at: 300, do: 'sleep' }]));
    await ctl.connect('s1', 'admin');
    const asked = () => bmc.received.filter((p) => p.type === Op.POWER_STATUS).length;
    const before = asked();
    await until(() => asked() > before, 4000, 'power status while blank');
  });

  it('asks for the keyboard lights when connected and when asked to sync', async () => {
    const { ctl, bmc, sent } = await setup();
    await ctl.connect('s1', 'admin');
    await until(() => infos(sent).some((i) => i.leds === 1), 3000, 'LED state');
    const n = bmc.received.filter((p) => p.type === Op.GET_KEYBD_LED).length;
    ctl.syncLeds();
    await until(() => bmc.received.filter((p) => p.type === Op.GET_KEYBD_LED).length > n, 3000, 'LED request');
  });

  it('types the right case when Caps Lock is on at the server, and leaves it on', async () => {
    const { ctl, typed, bmc } = await setup();
    await ctl.connect('s1', 'admin');
    ctl.key('CapsLock', true);
    ctl.key('CapsLock', false);
    const input = () => (bmc.sessions.at(-1) as unknown as { input: { leds: number } }).input;
    await until(() => (input().leds & 2) !== 0, 3000, 'Caps Lock on');
    expect(await ctl.typeText('Hello World')).toMatchObject({ typed: 11, cancelled: false });
    await until(() => typed().includes('Hello World'), 5000, 'typed text');
    expect(input().leds & 2).toBe(2);
  });

  it('treats the BMC\'s "other" mouse mode as relative', async () => {
    const { ctl, bmc, sent } = await setup(withFaults([], { mouseMode: 3 }));
    await ctl.connect('s1', 'admin');
    await until(() => sent.some((m) => m.channel === 'kvm:info' && (m.args[0] as { mouseMode?: number }).mouseMode === 3), 3000, 'mouse mode');
    ctl.mouse({ dx: 5, dy: -3, buttons: 0 });
    await until(() => bmc.received.some((p) => p.type === Op.HID_PKT && p.body[32] === 4), 3000, 'relative report');
    expect(bmc.received.some((p) => p.type === Op.HID_PKT && p.body[17] === 0x31 && p.body[32] === 6)).toBe(false);
  });

  it('announces a mouse mode change during the session', async () => {
    const { ctl, sent } = await setup(withFaults([{ at: 300, do: 'mouse-mode', mode: 1 }]));
    await ctl.connect('s1', 'admin');
    await until(() => notices(sent).includes('The BMC switched the mouse to relative mode.'), 3000, 'notice');
  });
});
