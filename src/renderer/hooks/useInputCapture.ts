/**
 * Keyboard and mouse control of the remote screen, with no capture step:
 * while connected, the mouse goes to the server whenever the pointer is over
 * the screen, and the keyboard whenever the screen has focus (it takes focus
 * on connect and when the pointer moves onto it). Ctrl+Alt+Shift pauses input
 * until the screen is clicked. Keys are sent by physical position
 * (KeyboardEvent.code), so the server's own layout applies.
 *
 * Relative-mouse BMCs are the exception: their pointer must be locked to the
 * window, which Chromium only allows from a click.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isRelativeMouse } from '../../shared/api';
import { api } from '../api';

interface Options {
  /** Input is only forwarded while the session is live (and allowed to control the server). */
  enabled: boolean;
  /** 2 absolute; any other mode is relative (pointer lock). */
  mouseMode: number;
  onToggleFullscreen: () => void;
  /** Ctrl+Alt+V: type the local clipboard into the host. */
  onPaste: () => void;
  /** Ctrl+Alt+C: select text on the screen to copy. */
  onSelectText: () => void;
}

/**
 * - `active`: keyboard and mouse go to the server
 * - `pointer`: the mouse goes to the server; the keyboard is on the app (e.g. a toolbar button has focus)
 * - `lock`: relative mouse; a click on the screen locks the pointer
 * - `paused`: nothing goes to the server until the screen is clicked
 * - `off`: not connected
 */
export type ControlState = 'active' | 'pointer' | 'lock' | 'paused' | 'off';

/** DOM buttons (1 left, 2 right, 4 middle) map 1:1 onto USB HID buttons. */
const usbButtons = (b: number) => b & 7;

/** Wheel travel (in pixels) that makes one scroll step on the server: about one mouse-wheel notch. */
const WHEEL_STEP_PX = 50;
const wheelPixels = (e: WheelEvent) => e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);

/**
 * Modifier keys and the event flag that says whether they are really held.
 * A key-up can go missing (Windows with both Shift keys, focus changes); every key
 * event is checked against these so a modifier cannot stay stuck on the server.
 * AltRight is AltGr on many layouts, which some systems report without altKey.
 */
const MODIFIER_HELD: Record<string, (e: KeyboardEvent) => boolean> = {
  ShiftLeft: (e) => e.shiftKey, ShiftRight: (e) => e.shiftKey,
  ControlLeft: (e) => e.ctrlKey, ControlRight: (e) => e.ctrlKey,
  AltLeft: (e) => e.altKey, AltRight: (e) => e.altKey || e.getModifierState('AltGraph'),
};
const isMac = /Mac/.test(navigator.platform);
const META = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);

/** Taking focus would interrupt something the user is doing in the app. */
const appBusy = () =>
  !document.hasFocus() || !!document.querySelector('[aria-modal="true"], [role="menu"]') ||
  /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');

export function useInputCapture(canvas: HTMLCanvasElement, o: Options) {
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [locked, setLocked] = useState(false);
  const opts = useRef(o);
  useLayoutEffect(() => {
    opts.current = o;
  });
  const state = useRef({ paused: false, down: new Set<string>(), buttons: 0, wheel: { px: 0, t: 0 }, lastCtrlDown: { t: -1, pending: false } });

  /** Lets go of anything held on the server (keys and mouse buttons held while focus moves away). */
  const releaseHeld = useCallback(() => {
    const st = state.current;
    if (st.down.size) api().releaseKeys();
    st.down.clear();
    if (st.buttons) api().mouse({ buttons: 0 });
    st.buttons = 0;
  }, []);

  const pause = useCallback(() => {
    state.current.paused = true;
    setPaused(true);
    releaseHeld();
    api().releaseKeys();
    if (document.pointerLockElement) document.exitPointerLock();
  }, [releaseHeld]);

  /**
   * Gives the screen the keyboard. The state follows activeElement rather than waiting
   * for the focus event, which does not fire while another window has the OS focus
   * (keys still go to the screen as soon as this window is active again).
   */
  const takeFocus = useCallback(() => {
    canvas.focus({ preventScroll: true });
    setFocused(document.activeElement === canvas);
  }, [canvas]);

  const resume = useCallback(() => {
    state.current.paused = false;
    setPaused(false);
    takeFocus();
  }, [takeFocus]);

  // A session that ends drops any pause, so the next one starts in control.
  const [wasEnabled, setWasEnabled] = useState(o.enabled);
  if (o.enabled !== wasEnabled) {
    setWasEnabled(o.enabled);
    if (!o.enabled) setPaused(false);
  }

  useEffect(() => {
    const st = state.current;
    const forwarding = () => opts.current.enabled && !st.paused;
    const mouseLive = () => forwarding() && (!isRelativeMouse(opts.current.mouseMode) || document.pointerLockElement === canvas);
    const sendMouse = (e: MouseEvent, wheel = 0) => {
      const buttons = usbButtons(e.buttons);
      st.buttons = buttons;
      if (isRelativeMouse(opts.current.mouseMode)) {
        api().mouse({ dx: e.movementX, dy: e.movementY, buttons, wheel });
        return;
      }
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      api().mouse({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, buttons, wheel });
    };

    const onEnter = () => {
      if (forwarding() && document.activeElement !== canvas && !appBusy()) takeFocus();
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      if (!opts.current.enabled) return;
      takeFocus();
      // A click resumes a pause; it is not passed on, so it cannot click something by accident.
      if (st.paused) return resume();
      if (isRelativeMouse(opts.current.mouseMode) && document.pointerLockElement !== canvas) {
        void canvas.requestPointerLock?.();
        return;
      }
      sendMouse(e);
    };
    const onUp = (e: MouseEvent) => { if (mouseLive()) sendMouse(e); };
    // A drag that ends outside the screen still releases the button on the server
    // (at the nearest edge), or the server would keep it held.
    const onWindowUp = (e: MouseEvent) => {
      if (e.target === canvas || !st.buttons) return;
      if (mouseLive()) sendMouse(e);
      else releaseHeld();
    };
    const onMove = (e: MouseEvent) => { if (mouseLive()) sendMouse(e); };
    // Touchpads and smooth scrolling send many small wheel events: they are added up
    // so that one notch's worth of travel scrolls the server by one step.
    // Sideways scrolling has no vertical part and is not sent.
    const onWheel = (e: WheelEvent) => {
      if (!mouseLive()) return;
      e.preventDefault();
      const px = wheelPixels(e);
      if (px === 0) return;
      const w = st.wheel;
      if (e.timeStamp - w.t > 300 || Math.sign(px) !== Math.sign(w.px)) w.px = 0;
      w.t = e.timeStamp;
      w.px += px;
      if (Math.abs(w.px) < WHEEL_STEP_PX) return;
      sendMouse(e, w.px < 0 ? 1 : -1);
      w.px = 0;
    };
    const onContext = (e: Event) => e.preventDefault();

    // Real-keyboard quirks:
    //  - Windows reports AltGr as a synthetic ControlLeft immediately followed by
    //    AltRight (same timestamp); the fake Ctrl is withdrawn so the host only sees AltGr.
    //  - Windows delivers PrintScreen as key-up only; it is sent as a full press.
    //  - A modifier whose key-up was lost is released (see MODIFIER_HELD).
    //  - macOS sends no key-up for keys released while Cmd is held: they are released with Cmd.
    const releaseStaleModifiers = (e: KeyboardEvent) => {
      for (const code of st.down) {
        const held = MODIFIER_HELD[code];
        if (held && code !== e.code && !held(e)) {
          st.down.delete(code);
          api().key(code, false);
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!forwarding()) return;
      e.preventDefault();
      e.stopPropagation();
      releaseStaleModifiers(e);
      if (e.ctrlKey && e.altKey && e.shiftKey && /^(Shift|Control|Alt)/.test(e.code)) return pause();
      if (e.code === 'F11' && e.ctrlKey) return opts.current.onToggleFullscreen();
      // Not forwarded: the main process releases the Ctrl+Alt already sent before typing.
      if (e.code === 'KeyV' && e.ctrlKey && e.altKey && !e.shiftKey) return opts.current.onPaste();
      if (e.code === 'KeyC' && e.ctrlKey && e.altKey && !e.shiftKey) return opts.current.onSelectText();
      if (e.code === 'AltRight' && st.lastCtrlDown.pending && Math.abs(e.timeStamp - st.lastCtrlDown.t) < 10) {
        api().key('ControlLeft', false);
        st.down.delete('ControlLeft');
      }
      if (e.code === 'ControlLeft' && !e.repeat) st.lastCtrlDown = { t: e.timeStamp, pending: true };
      else st.lastCtrlDown.pending = false;
      st.down.add(e.code);
      api().key(e.code, true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!forwarding()) return;
      e.preventDefault();
      releaseStaleModifiers(e);
      if (e.code === 'PrintScreen' && !st.down.has('PrintScreen')) {
        api().key('PrintScreen', true);
        api().key('PrintScreen', false);
        return;
      }
      if (!st.down.has(e.code)) return; // e.g. the fake AltGr Ctrl, or a key pressed before focus arrived
      st.down.delete(e.code);
      api().key(e.code, false);
      if (isMac && META.has(e.code)) {
        for (const code of st.down) {
          if (MODIFIER_HELD[code] || META.has(code)) continue;
          st.down.delete(code);
          api().key(code, false);
        }
      }
    };
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      setFocused(false);
      releaseHeld();
    };
    const onPointerLock = () => setLocked(document.pointerLockElement === canvas);

    canvas.addEventListener('mouseenter', onEnter);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mouseup', onUp);
    window.addEventListener('mouseup', onWindowUp);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('focus', onFocus);
    canvas.addEventListener('blur', onBlur);
    window.addEventListener('blur', releaseHeld);
    document.addEventListener('pointerlockchange', onPointerLock);
    return () => {
      canvas.removeEventListener('mouseenter', onEnter);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mouseup', onUp);
      window.removeEventListener('mouseup', onWindowUp);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('focus', onFocus);
      canvas.removeEventListener('blur', onBlur);
      window.removeEventListener('blur', releaseHeld);
      document.removeEventListener('pointerlockchange', onPointerLock);
      releaseHeld();
    };
  }, [canvas, pause, resume, releaseHeld, takeFocus]);

  // The BMC switched to absolute mode while the pointer was locked: give the pointer back,
  // or it would stay frozen on the server until Esc.
  const relative = isRelativeMouse(o.mouseMode);
  useEffect(() => {
    if (!relative && document.pointerLockElement === canvas) document.exitPointerLock();
  }, [relative, canvas]);

  // On connect, take the keyboard straight away (after the listeners above, so the focus is seen).
  useEffect(() => {
    if (!o.enabled) {
      state.current.paused = false;
      releaseHeld();
      return;
    }
    if (!appBusy()) canvas.focus({ preventScroll: true });
  }, [o.enabled, canvas, releaseHeld]);

  let control: ControlState = 'off';
  if (o.enabled) {
    if (paused) control = 'paused';
    else if (relative && !locked) control = 'lock';
    else control = focused ? 'active' : 'pointer';
  }
  return { control, pause, resume };
}
