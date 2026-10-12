/**
 * Video pipeline, deliberately outside React: frames go from IPC straight to
 * the decoder worker, which paints an OffscreenCanvas. React only mounts the
 * canvas element and reads the stats below. A canvas can be transferred to a
 * worker once, so the engine is a long-lived singleton that survives remounts.
 */
import type { ScreenText } from '../../textrec/recognize';
import { api } from '../api';

export interface VideoStats {
  width: number;
  height: number;
  fps: number;
  decodeMs: number;
  /** True while the BMC reports no signal from the host display. */
  blank: boolean;
  /** Last decoder warning, if any. */
  warning: string;
}

const EMPTY: VideoStats = { width: 0, height: 0, fps: 0, decodeMs: 0, blank: false, warning: '' };

/** Recognised text and the frame size it was read from. */
export interface FrameText { text: ScreenText | null; width: number; height: number }

class VideoEngine {
  readonly canvas: HTMLCanvasElement;
  private worker?: Worker;
  private stats = EMPTY;
  private listeners = new Set<() => void>();
  private textRequests = new Map<number, (r: FrameText) => void>();
  private nextTextId = 1;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Remote screen');
    // jsdom (component tests) has neither workers nor OffscreenCanvas.
    if (typeof Worker === 'undefined' || !this.canvas.transferControlToOffscreen) return;
    const worker = new Worker('decode-worker.js');
    this.worker = worker;
    const offscreen = this.canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    worker.onmessage = (e) => this.onWorker(e.data);
    api().on('kvm:frame', (data) => worker.postMessage({ type: 'frame', data }, [data.buffer]));
    api().on('kvm:blank', () => worker.postMessage({ type: 'blank' }));
  }

  private onWorker(m: { type: string; width?: number; height?: number; fps?: number; decodeMs?: number; message?: string; id?: number; text?: ScreenText | null }) {
    if (m.type === 'text') {
      this.textRequests.get(m.id!)?.({ text: m.text ?? null, width: m.width ?? 0, height: m.height ?? 0 });
      this.textRequests.delete(m.id!);
    } else if (m.type === 'size') {
      api().frameSize(m.width!, m.height!);
      this.set({ width: m.width!, height: m.height!, blank: false });
    } else if (m.type === 'fps') {
      if (m.fps !== this.stats.fps || (m.fps && Math.abs(m.decodeMs! - this.stats.decodeMs) > 0.2)) this.set({ fps: m.fps!, decodeMs: m.decodeMs!, ...(m.fps ? { blank: false } : {}) });
    } else if (m.type === 'blank') {
      this.set({ blank: true });
    } else if (m.type === 'warning') {
      this.set({ warning: m.message ?? '' });
    }
  }

  private set(patch: Partial<VideoStats>) {
    this.stats = { ...this.stats, ...patch };
    for (const l of this.listeners) l();
  }

  /** CSS size of the canvas; hidden until there is video. */
  setDisplaySize(width: number, height: number) {
    const st = this.canvas.style;
    st.visibility = width > 0 && height > 0 ? '' : 'hidden';
    st.width = `${Math.round(width)}px`;
    st.height = `${Math.round(height)}px`;
  }

  /** Reads the text on the current frame (null text: no known font on screen). */
  readText(): Promise<FrameText> {
    const worker = this.worker;
    if (!worker) return Promise.resolve({ text: null, width: 0, height: 0 });
    const id = this.nextTextId++;
    return new Promise((resolve) => {
      this.textRequests.set(id, resolve);
      worker.postMessage({ type: 'readText', id });
    });
  }

  /** New session: fresh decoder state. */
  reset() {
    this.worker?.postMessage({ type: 'reset' });
    this.set({ ...EMPTY });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getStats = () => this.stats;
}

let engine: VideoEngine | undefined;
export function videoEngine(): VideoEngine {
  engine ??= new VideoEngine();
  return engine;
}
