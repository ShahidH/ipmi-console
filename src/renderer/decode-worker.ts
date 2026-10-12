/// <reference lib="webworker" />
// Decodes ASPEED frames off the UI thread and paints them onto an OffscreenCanvas.
import { readScreen } from '../textrec/recognize';
import { AspeedDecoder } from '../video/decoder';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let decoder = new AspeedDecoder();
let image: ImageData | null = null;
let frames = 0;
let decodeMs = 0;
let lastWarn = '';

setInterval(() => {
  postMessage({ type: 'fps', fps: frames, decodeMs: frames ? decodeMs / frames : 0 });
  frames = 0;
  decodeMs = 0;
}, 1000);

onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'readText') {
    // Text recognition on the current frame, at native resolution (see src/textrec).
    const t0 = performance.now();
    const text = image && canvas ? readScreen(decoder.rgba, canvas.width, canvas.height) : null;
    postMessage({ type: 'text', id: m.id, text, width: canvas?.width ?? 0, height: canvas?.height ?? 0, ms: performance.now() - t0 });
    return;
  }
  if (m.type === 'init') {
    canvas = m.canvas as OffscreenCanvas;
    ctx = canvas.getContext('2d', { alpha: false });
    return;
  }
  if (m.type === 'reset') {
    decoder = new AspeedDecoder();
    image = null;
    return;
  }
  if (m.type === 'blank' && canvas && ctx) {
    // Before any video the canvas is still 300x150; give the message room.
    if (canvas.width < 640) {
      canvas.width = 800;
      canvas.height = 600;
      postMessage({ type: 'size', width: 800, height: 600 });
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#8a96a3';
    ctx.font = '20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No signal from host', canvas.width / 2, canvas.height / 2 - 14);
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('The display may be asleep. Waking it automatically; or press Wake in the toolbar.', canvas.width / 2, canvas.height / 2 + 16);
    image = null;
    postMessage({ type: 'blank' });
    return;
  }
  if (m.type === 'frame' && canvas && ctx) {
    let r;
    const t0 = performance.now();
    try {
      r = decoder.decode(m.data as Uint8Array);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== lastWarn) postMessage({ type: 'warning', message: msg });
      lastWarn = msg;
      return;
    }
    if (r.warning && r.warning !== lastWarn) {
      postMessage({ type: 'warning', message: r.warning });
      lastWarn = r.warning;
    }
    if (canvas.width !== r.width || canvas.height !== r.height || !image) {
      canvas.width = r.width;
      canvas.height = r.height;
      image = new ImageData(decoder.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
      postMessage({ type: 'size', width: r.width, height: r.height });
      ctx.putImageData(image, 0, 0);
    } else if (r.dirty) {
      ctx.putImageData(image, 0, 0, r.dirty.x, r.dirty.y, r.dirty.w, r.dirty.h);
    }
    decodeMs += performance.now() - t0;
    frames++;
  }
};
