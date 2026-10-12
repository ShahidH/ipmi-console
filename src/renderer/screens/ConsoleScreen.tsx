// The live console: toolbar, remote screen, status bar, and the connection overlays.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MAX_TYPE_TEXT, TYPING_LAYOUT_LABELS, type ChordName, type PowerActionName, type TypingLayoutChoice, type TypingProgress } from '../../shared/api';
import { api } from '../api';
import {
  BackIcon, ChevronIcon, ClipboardIcon, FitIcon, FullscreenIcon, TextSelectIcon, KeyboardIcon, LockIcon, PowerIcon, ResetIcon, RetryIcon, SlidersIcon,
} from '../components/icons';
import { Menu } from '../components/Menu';
import { useToast } from '../components/Toasts';
import type { SessionState } from '../hooks/useKvmSession';
import { useInputCapture, type ControlState } from '../hooks/useInputCapture';
import { useNow } from '../hooks/useNow';
import { videoEngine, type FrameText } from '../video/engine';
import { SHARE_ANSWER_SECONDS } from '../components/Dialogs';
import { TextSelect } from '../components/TextSelect';
import { UNKNOWN } from '../../textrec/recognize';
import { selectionText } from '../../textrec/selection';

interface Props {
  session: SessionState;
  onDisconnect: () => void;
  onRetryNow: () => void;
  onReconnect: () => void;
}

const KEYS: Array<{ id: ChordName; label: string; hint?: string }> = [
  { id: 'ctrl-alt-del', label: 'Ctrl + Alt + Del' },
  { id: 'alt-tab', label: 'Alt + Tab' },
  { id: 'alt-f4', label: 'Alt + F4' },
  { id: 'win', label: 'Windows key' },
  { id: 'ctrl-esc', label: 'Ctrl + Esc' },
  { id: 'printscreen', label: 'Print Screen' },
  { id: 'alt-sysrq', label: 'Alt + SysRq', hint: 'Linux' },
  { id: 'ctrl-alt-backspace', label: 'Ctrl + Alt + Backspace', hint: 'X11' },
];

export const POWER: Record<PowerActionName, { label: string; desc: string; done: string; interrupts: boolean }> = {
  on: { label: 'Power on', desc: 'Turns the server on', done: 'Power on', interrupts: false },
  soft: { label: 'Soft shutdown', desc: 'Asks the OS to shut down (ACPI)', done: 'Soft shutdown', interrupts: false },
  off: { label: 'Power off', desc: 'Cuts power at once', done: 'Power off', interrupts: true },
  reset: { label: 'Hard reset', desc: 'Restarts at once, no OS shutdown', done: 'Hard reset', interrupts: true },
  cycle: { label: 'Power cycle', desc: 'Off, then on again', done: 'Power cycle', interrupts: true },
};

/** Narrowest window that still shows the dock and status bar on one line. */
const MIN_WINDOW_WIDTH = 760;

export const TYPING_LAYOUTS = (Object.keys(TYPING_LAYOUT_LABELS) as TypingLayoutChoice[]).map((id) => ({ id, label: TYPING_LAYOUT_LABELS[id] }));
const KBD_LABEL: Record<string, string> = { autobreak: 'JViewer key-press', state: 'standard USB', single: 'JViewer single key' };

function duration(ms: number): string {
  const m = Math.floor(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function ConsoleScreen({ session, onDisconnect, onRetryNow, onReconnect }: Props) {
  const engine = videoEngine();
  const video = useSyncExternalStore(engine.subscribe, engine.getStats);
  const toast = useToast();
  const root = useRef<HTMLDivElement>(null);
  /** Actual size by default; Fit when the screen is bigger than the monitor allows. */
  const [fit, setFit] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [barOpen, setBarOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const now = useNow(1000);
  const live = session.phase === 'connected';
  const name = session.target?.name ?? 'Server';
  const mouseMode = session.info.mouseMode ?? 2;
  const access = session.info.access ?? 'full';
  /** Keyboard, mouse and power go to the server (not while view-only or waiting for access). */
  const canControl = live && access === 'full';

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await root.current?.requestFullscreen();
      // Captures OS shortcuts (Alt+Tab, Win) while full screen, where supported.
      await (navigator as unknown as { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.()?.catch(() => {});
    }
  };
  const { control, pause, resume } = useInputCapture(engine.canvas, { enabled: canControl, mouseMode, onToggleFullscreen: () => void toggleFullscreen(), onPaste: () => void typeClipboard(), onSelectText: () => void toggleSelect() });
  const [typing, setTyping] = useState<TypingProgress | null>(null);
  useEffect(() => api().on('kvm:typing', (p) => setTyping(p.done < p.total ? p : null)), []);

  // When the server's resolution is known (or changes), size the window to show it at
  // actual size: dock + screen + status bar. If that does not fit the monitor, fit instead.
  const sizedFor = useRef('');
  useEffect(() => {
    if (!live || !video.width || !video.height || document.fullscreenElement) return;
    const key = `${video.width}x${video.height}`;
    if (sizedFor.current === key) return;
    sizedFor.current = key;
    const el = root.current;
    const vp = el?.querySelector<HTMLElement>('.viewport');
    const pad = vp ? getComputedStyle(vp) : null;
    const padX = pad ? parseFloat(pad.paddingLeft) + parseFloat(pad.paddingRight) : 0;
    const padY = pad ? parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom) : 0;
    const chrome = (el?.querySelector<HTMLElement>('.dock-strip')?.offsetHeight ?? 52) + (el?.querySelector<HTMLElement>('.statusbar')?.offsetHeight ?? 30);
    const width = Math.max(video.width + padX, MIN_WINDOW_WIDTH);
    void api().fitWindow(width, video.height + padY + chrome).then((ok) => { if (!ok) setFit(true); });
  }, [live, video.width, video.height]);

  useEffect(() => {
    const onFs = () => {
      setFullscreen(!!document.fullscreenElement);
      setBarOpen(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const focusScreen = () => engine.canvas.focus();

  // Select mode: read the text on the current frame, then let the user pick some to copy.
  const [selecting, setSelecting] = useState<FrameText | null>(null);
  const endSelect = () => {
    setSelecting(null);
    resume();
  };
  const toggleSelect = async () => {
    if (selecting) return endSelect();
    if (!live) return;
    pause();
    const frame = await engine.readText();
    if (!frame.text) {
      toast({ title: 'No readable text on this screen.', detail: 'Copying works on text screens: consoles, BIOS setup and boot messages.' });
      return resume();
    }
    setSelecting(frame);
  };
  const copyText = async (text: string) => {
    await api().copyText(text);
    const lines = text.split('\n');
    const unreadable = [...text].filter((ch) => ch === UNKNOWN).length;
    toast({
      title: lines.length === 1 ? `Copied: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` : `Copied ${lines.length} lines.`,
      detail: unreadable ? `${unreadable} character${unreadable === 1 ? '' : 's'} couldn't be read and show as ${UNKNOWN}.` : undefined,
    });
    endSelect();
  };
  const sendChord = async (id: ChordName) => { await api().chord(id); focusScreen(); };
  const typeClipboard = async () => {
    const layout = TYPING_LAYOUT_LABELS[session.info.typingLayout ?? 'us'];
    try {
      const r = await api().typeClipboard();
      if (r.status === 'empty') toast({ title: 'The clipboard has no text to type.' });
      else if (r.status === 'too-long') toast({ title: 'The clipboard is too long to type.', detail: `It has ${r.length.toLocaleString()} characters; the limit is ${MAX_TYPE_TEXT.toLocaleString()}. Copy a smaller part.`, level: 'err' });
      else if (r.status === 'typed') {
        const skipped = r.skipped ? `${r.skipped} can't be typed reliably on the ${layout} layout and were skipped.` : undefined;
        toast({ title: r.cancelled ? `Stopped after ${r.typed} characters.` : `Typed ${r.typed} characters.`, detail: skipped });
      }
    } catch (e) {
      toast({ title: 'Could not type the clipboard.', detail: (e as Error).message, level: 'err' });
    }
    focusScreen();
  };
  /** A power command waiting for the BMC's answer: the menu is disabled meanwhile. */
  const [powerBusy, setPowerBusy] = useState(false);
  const power = async (a: PowerActionName) => {
    setPowerBusy(true);
    try {
      const r = await api().power(a);
      const at = `At ${new Date().toLocaleTimeString()}.`;
      if (r === 'done') toast({ title: `${POWER[a].done} sent to ${name}.`, detail: at });
      else if (r === 'refused') toast({ title: `The BMC refused ${POWER[a].label.toLowerCase()}.`, detail: 'This account may not be allowed to control power, or the BMC is busy. Nothing was changed.', level: 'err' });
      else if (r === 'no-answer') toast({ title: `${POWER[a].done} sent to ${name}.`, detail: `${at} The BMC did not confirm it; check the server's state before trying again.` });
      else toast({ title: 'Power control is not available.', detail: 'This session has view-only access.', level: 'err' });
    } finally {
      setPowerBusy(false);
    }
  };

  const kbd = session.info.keyboardMode ? `${KBD_LABEL[session.info.keyboardMode] ?? session.info.keyboardMode}${session.info.keyboardModeAuto ? ' (auto)' : ''}` : '';
  const leds = session.info.leds ?? 0;
  const powerState = session.info.power;

  return (
    <div ref={root} className={`console${fullscreen ? ' fs' : ''}${barOpen ? ' bar-open' : ''}`}
      onMouseMove={(e) => { if (fullscreen && e.clientY < 6) setBarOpen(true); }}>
      <header className="dock-strip">
        <div role="toolbar" aria-label="Console" className="dock">
          <button type="button" className="dock-btn dock-back" title="Disconnect and go back to your servers" onClick={onDisconnect}><BackIcon size={16} />Servers</button>
          <span className="dock-chip" title={session.target?.host}>
            <span className={`dot ${session.phase === 'connected' ? 'ok' : session.phase === 'ended' ? 'err' : 'warn'}`} aria-hidden="true" />
            <strong>{name}</strong>
            <span className="host">{session.target?.host}</span>
          </span>
          <span className="dock-sep" aria-hidden="true" />
          <Menu label={<><KeyboardIcon size={17} /><ChevronIcon size={10} /></>} ariaLabel="Keys" title="Send a key combination" buttonClass="dock-btn" width={280}>
            {(close) => KEYS.map((k) => (
              <button key={k.id} type="button" role="menuitem" className="menu-item" disabled={!canControl} onClick={() => { close(); void sendChord(k.id); }}>
                <span>{k.label}</span>{k.hint && <span className="hint">{k.hint}</span>}
              </button>
            ))}
          </Menu>
          <button type="button" className="dock-btn icon" disabled={!canControl} aria-label="Type clipboard" title="Type the clipboard into the server (Ctrl+Alt+V)" onClick={() => void typeClipboard()}><ClipboardIcon size={17} /></button>
          <button type="button" className="dock-btn icon" disabled={!live} aria-pressed={!!selecting} aria-label="Select text" title="Select text on the screen to copy (Ctrl+Alt+C)" onClick={() => void toggleSelect()}><TextSelectIcon size={17} /></button>
          <button type="button" className="dock-btn icon" aria-pressed={fit} aria-label="Fit to window" title={fit ? 'Fit to window (on). Click for actual size' : 'Actual size. Click to fit to window'} onClick={() => setFit((v) => !v)}><FitIcon size={17} /></button>
          <button type="button" className="dock-btn icon" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen (Ctrl+F11)' : 'Full screen (Ctrl+F11)'} onClick={() => void toggleFullscreen()}><FullscreenIcon size={17} /></button>
          <span className="dock-sep" aria-hidden="true" />
          <Menu label={<><PowerIcon />Power<ChevronIcon size={11} /></>} buttonClass="dock-btn dock-power" width={320}>
            {(close) => <>
              <div className="menu-state">
                <span className="dot" style={{ color: powerState === 1 ? 'var(--ok)' : powerState === 0 ? 'var(--muted)' : 'var(--faint)' }} />
                {powerState === 1 ? 'Server is on' : powerState === 0 ? 'Server is off' : 'Power state unknown'}
              </div>
              {(['on', 'soft'] as const).map((a) => (
                <button key={a} type="button" role="menuitem" className="menu-item two-line" disabled={!canControl || powerBusy || (a === 'on' && powerState === 1)} onClick={() => { close(); void power(a); }}>
                  <span>{POWER[a].label}</span><span className="desc">{a === 'on' && powerState === 1 ? 'Already on' : POWER[a].desc}</span>
                </button>
              ))}
              <div className="menu-sep" />
              <div className="menu-label danger">Interrupts the OS</div>
              {(['off', 'reset', 'cycle'] as const).map((a) => (
                <button key={a} type="button" role="menuitem" className="menu-item two-line danger" disabled={!canControl || powerBusy} onClick={() => { close(); void power(a); }}>
                  <span>{POWER[a].label}</span><span className="desc">{POWER[a].desc}</span>
                </button>
              ))}
            </>}
          </Menu>
          <Menu label={<SlidersIcon size={17} />} ariaLabel="Session settings and logs" title="Session settings and logs" buttonClass="dock-btn icon" align="right" width={280}>
            {(close) => <>
              <div className="menu-label">Server layout for Type clipboard</div>
              {TYPING_LAYOUTS.map((l) => (
                <button key={l.id} type="button" role="menuitemradio" className="menu-item" disabled={!live}
                  aria-checked={(session.info.typingLayout ?? 'us') === l.id}
                  onClick={() => { close(); void api().setTypingLayout(l.id).then(focusScreen); }}>{l.label}</button>
              ))}
              <div className="menu-sep" />
              <button type="button" role="menuitem" className="menu-item" disabled={!canControl} onClick={() => { close(); void api().wake().then(focusScreen); }}>Wake display</button>
              <button type="button" role="menuitem" className="menu-item" disabled={!live} onClick={() => { close(); void api().refresh(); }}>Refresh video</button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => { close(); setLogsOpen((v) => !v); }}>{logsOpen ? 'Hide log' : 'Show log'}</button>
            </>}
          </Menu>
        </div>
      </header>

      {fullscreen && (
        <button type="button" className={`fs-tab${control === 'active' ? ' captured' : ''}`} aria-expanded={barOpen} onClick={() => setBarOpen((v) => !v)}>
          {control === 'active' && <span className="dot" style={{ color: 'var(--capture)' }} />}
          {name}{control === 'active' ? ' · Ctrl+Alt+Shift to pause' : control === 'paused' ? ' · input paused' : ''}
          <ChevronIcon size={12} />
        </button>
      )}

      <Viewport fit={fit} controlling={control === 'active' || control === 'pointer'} stale={session.phase === 'reconnecting' || session.phase === 'ended'}>
        {session.phase === 'connecting' && (
          <div className="vp-overlay">
            <section className="panel" role="status" aria-live="polite">
              <div className="panel-head"><span className="spinner" /><div><h2>{session.step}</h2><span>{session.target?.host}</span></div></div>
              <div className="row"><button type="button" className="btn tall" onClick={onDisconnect}>Cancel</button></div>
            </section>
          </div>
        )}
        {live && access === 'waiting' && (
          <div className="vp-overlay">
            <section className="panel" role="status" aria-live="polite">
              <div className="panel-head"><span className="spinner" /><div><h2>Asking for access…</h2><span>{session.info.sharedWith || 'Another user'} is using this console.</span></div></div>
              <p>They have {SHARE_ANSWER_SECONDS} seconds to answer. If they don't, you get full access.</p>
              <div className="row"><button type="button" className="btn tall" onClick={onDisconnect}>Cancel</button></div>
            </section>
          </div>
        )}
        {selecting?.text && (
          <TextSelect canvas={engine.canvas} text={selecting.text} frame={selecting} onCopy={(t) => void copyText(t)} onCancel={endSelect} />
        )}
        {session.phase === 'reconnecting' && <ReconnectPanel session={session} now={now} onRetryNow={onRetryNow} onShowLog={() => setLogsOpen(true)} />}
        {session.phase === 'ended' && (
          <div className="vp-overlay">
            <section className="panel" role="alert">
              <div className="panel-head"><span style={{ color: 'var(--danger)', display: 'flex' }}><ResetIcon size={28} /></span><div><h2>Session ended</h2><span>{session.reason}</span></div></div>
              <div className="row">
                <button type="button" className="btn primary tall" onClick={onReconnect}>Reconnect</button>
                <button type="button" className="btn tall" onClick={onDisconnect}>Back to servers</button>
                <button type="button" className="btn tall" onClick={() => setLogsOpen(true)}>Show log</button>
              </div>
            </section>
          </div>
        )}
      </Viewport>

      {fullscreen && !barOpen && (
        <div className="fs-corner">
          {leds & 1 ? <span style={{ color: '#8FE3B7' }}>NUM</span> : null}
          {live && video.fps > 0 && <span>{video.fps} fps</span>}
        </div>
      )}

      {typing && (
        <div className="typing-panel" role="status" aria-live="polite">
          <span>Typing clipboard… {typing.done.toLocaleString()} of {typing.total.toLocaleString()} characters</span>
          <div className="progress" aria-hidden="true"><div style={{ width: `${Math.round((typing.done / typing.total) * 100)}%`, background: 'var(--accent)' }} /></div>
          <button type="button" className="btn sm" onClick={() => void api().cancelTyping()}>Cancel</button>
        </div>
      )}

      {logsOpen && <LogDrawer />}

      <footer className="statusbar">
        {selecting?.text ? (
          <span className="select-bar" role="status">
            <TextSelectIcon size={14} />
            <strong>Selecting text</strong>
            <span>drag to copy · double-click a word · Esc cancels</span>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void copyText(selectionText(selecting.text!.lines, { r: 0, c: 0 }, { r: selecting.text!.grid.rows - 1, c: selecting.text!.grid.cols - 1 }, false))}>Copy all</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={endSelect}>Cancel</button>
          </span>
        ) : live && access !== 'full' ? (
          <span className="control-pill paused" role="status" title={access === 'waiting' ? 'Waiting for the other user to answer' : 'The other user allowed you to watch only'}>
            <KeyboardIcon size={14} />
            <strong>{access === 'waiting' ? 'Waiting for access' : 'View only'}</strong>
            <span>{access === 'waiting' ? 'input is off' : 'keyboard, mouse and power are off'}</span>
          </span>
        ) : (
          <ControlPill control={control} onPause={pause} onResume={resume} />
        )}
        {live && session.info.sharedWith && <span className="shared" title={`${session.info.sharedWith} also uses this console`}>Shared with {session.info.sharedWith}</span>}
        <StateLabel session={session} now={now} />
        <span className="grow" />
        {(session.warning || video.warning) && <span className="msg warn" title={session.warning || video.warning}>{session.warning || video.warning}</span>}
        {video.width > 0 && (
          <span title={[
            live && video.fps ? `Decoding ${video.decodeMs.toFixed(1)} ms per frame` : 'The BMC only sends frames when the screen changes',
            session.info.mouseMode !== undefined ? `Mouse: ${mouseMode === 1 ? 'relative' : mouseMode === 2 ? 'absolute' : `mode ${mouseMode}`}` : '',
            kbd ? `Keyboard: ${kbd}` : '',
          ].filter(Boolean).join('\n')}>
            {video.blank ? 'No signal' : `${video.width} × ${video.height}`}{live ? ` · ${video.fps ? `${video.fps} fps` : 'idle'}` : ''}
          </span>
        )}
        {live && (
          <span className="leds" aria-label="Keyboard lights">
            <span className={leds & 1 ? 'on' : ''}>NUM</span><span className={leds & 2 ? 'on' : ''}>CAPS</span><span className={leds & 4 ? 'on' : ''}>SCROLL</span>
          </span>
        )}
        {session.info.encrypted && <span className="enc" title="Keyboard and mouse are encrypted"><LockIcon size={13} /></span>}
      </footer>
    </div>
  );
}

const CONTROL: Record<Exclude<ControlState, 'off'>, { tone: string; label: string; hint: string; action: string }> = {
  active: { tone: 'active', label: 'Controlling server', hint: 'Ctrl+Alt+Shift pauses', action: 'Pause input to the server' },
  pointer: { tone: 'pointer', label: 'Mouse only', hint: 'point at the screen to type', action: 'Pause input to the server' },
  lock: { tone: 'pointer', label: 'Click the screen', hint: 'to use the mouse', action: 'Give the keyboard to the server' },
  paused: { tone: 'paused', label: 'Paused', hint: 'click the screen to resume', action: 'Resume input to the server' },
};

/** Where keyboard and mouse go, always visible in the status bar; click it to pause or resume. */
function ControlPill({ control, onPause, onResume }: { control: ControlState; onPause: () => void; onResume: () => void }) {
  if (control === 'off') return null;
  const c = CONTROL[control];
  return (
    <button type="button" className={`control-pill ${c.tone}`} title={c.action} aria-label={`${c.label}, ${c.hint}. ${c.action}.`}
      onMouseDown={(e) => e.preventDefault()} onClick={control === 'active' || control === 'pointer' ? onPause : onResume}>
      <KeyboardIcon size={14} />
      <strong>{c.label}</strong>
      <span>{c.hint}</span>
    </button>
  );
}

function StateLabel({ session, now }: { session: SessionState; now: number }) {
  if (session.phase === 'connected') return <span className="state ok"><span className="dot" />Connected · {duration(now - (session.connectedAt ?? now))}</span>;
  if (session.phase === 'reconnecting') return <span className="state warn"><span className="dot" />Reconnecting</span>;
  if (session.phase === 'ended') return <span className="state err"><span className="dot" />Disconnected</span>;
  return <span className="state">{session.step}</span>;
}

/** Hosts the engine's canvas and sizes it: Fit scales to the window keeping aspect; 1:1 shows real pixels. */
function Viewport({ fit, controlling, stale, children }: { fit: boolean; controlling: boolean; stale: boolean; children: React.ReactNode }) {
  const engine = videoEngine();
  const video = useSyncExternalStore(engine.subscribe, engine.getStats);
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = box.current!;
    host.current!.appendChild(engine.canvas);
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el);
      setAvail({ w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) });
    });
    ro.observe(el);
    return () => { ro.disconnect(); engine.canvas.remove(); };
  }, [engine]);

  useLayoutEffect(() => {
    const scale = fit && avail.w > 0 && avail.h > 0 && video.width > 0 ? Math.min(avail.w / video.width, avail.h / video.height) : 1;
    engine.setDisplaySize(video.width * scale, video.height * scale);
  }, [engine, fit, avail, video.width, video.height]);

  return (
    <div ref={box} className={`viewport${fit ? ' fit' : ''}${controlling ? ' controlling' : ''}${stale ? ' stale' : ''}`}>
      <div ref={host} className="canvas-host" />
      {children}
    </div>
  );
}

function ReconnectPanel({ session, now, onRetryNow, onShowLog }: { session: SessionState; now: number; onRetryNow: () => void; onShowLog: () => void }) {
  const r = session.reconnect;
  const left = r ? Math.max(0, Math.ceil((r.scheduledAt + r.delaySec * 1000 - now) / 1000)) : 0;
  const lostFor = session.lostAt ? Math.max(0, Math.round((now - session.lostAt) / 1000)) : 0;
  return (
    <div className="vp-overlay">
      <section className="panel" role="status" aria-live="polite">
        <div className="panel-head">
          <span style={{ color: 'var(--warn)', display: 'flex' }}><RetryIcon size={28} /></span>
          <div>
            <h2>{r && left > 0 ? `Connection lost. Trying again in ${left} s` : 'Connection lost. Reconnecting…'}</h2>
            <span>{r ? `Attempt ${r.attempt} of ${r.max} · logs in fresh each time` : session.step}</span>
          </div>
        </div>
        {r && <div className="progress" aria-hidden="true"><div style={{ width: `${Math.round((r.attempt / r.max) * 100)}%` }} /></div>}
        <p>{session.reason ? `${session.reason}. ` : ''}Lost {lostFor} s ago. The last frame stays dimmed so you keep your place. Keyboard and mouse are paused until the screen is live again.</p>
        <div className="row">
          <button type="button" className="btn primary tall" onClick={onRetryNow}>Retry now</button>
          <button type="button" className="btn tall" onClick={onShowLog}>Show log</button>
        </div>
      </section>
    </div>
  );
}

function LogDrawer() {
  const [text, setText] = useState('');
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let alive = true;
    void api().logs().then((t) => { if (alive) setText(t + '\n'); });
    const off = api().on('log', (line) => setText((t) => (t + line + '\n').slice(-200_000)));
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [text]);
  return <pre ref={pre} className="logs" aria-label="Session log">{text}</pre>;
}
