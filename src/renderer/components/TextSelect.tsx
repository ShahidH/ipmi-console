// Select mode: an overlay on the remote screen that selects recognised text the way a
// terminal does (drag, double-click a word, triple-click a line, Alt+drag a block) and
// copies on release.
import { useEffect, useRef, useState } from 'react';
import { lineAt, selectionText, spans, wordAt, type Cell } from '../../textrec/selection';
import type { ScreenText } from '../../textrec/recognize';

interface Props {
  canvas: HTMLCanvasElement;
  text: ScreenText;
  /** Size of the frame the text was read from (the canvas may be scaled). */
  frame: { width: number; height: number };
  onCopy: (text: string) => void;
  onCancel: () => void;
}

export function TextSelect({ canvas, text, frame, onCopy, onCancel }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ a: Cell; b: Cell; block: boolean } | null>(null);
  const drag = useRef<{ a: Cell; block: boolean } | null>(null);
  const { grid, lines } = text;

  useEffect(() => box.current?.focus(), []);
  // Escape cancels wherever the keyboard is, e.g. after a click on the toolbar; captured first so it
  // never reaches the server.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const cellAt = (clientX: number, clientY: number): Cell => {
    const r = box.current!.getBoundingClientRect();
    const sx = r.width / frame.width;
    const sy = r.height / frame.height;
    const c = Math.floor(((clientX - r.left) / sx - grid.ox) / grid.cw);
    const row = Math.floor(((clientY - r.top) / sy - grid.oy) / grid.ch);
    return { r: Math.min(grid.rows - 1, Math.max(0, row)), c: Math.min(grid.cols - 1, Math.max(0, c)) };
  };

  const copy = (a: Cell, b: Cell, block: boolean) => {
    const t = selectionText(lines, a, b, block);
    if (t) onCopy(t);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (e.button !== 0) return;
    const at = cellAt(e.clientX, e.clientY);
    if (e.detail === 2 || e.detail === 3) {
      const range = e.detail === 2 ? wordAt(lines, at) : lineAt(lines, at);
      if (range) {
        setSel({ a: range[0], b: range[1], block: false });
        copy(range[0], range[1], false);
      }
      return;
    }
    drag.current = { a: at, block: e.altKey };
    setSel({ a: at, b: at, block: e.altKey });
    const move = (ev: MouseEvent) => {
      if (drag.current) setSel({ a: drag.current.a, b: cellAt(ev.clientX, ev.clientY), block: drag.current.block });
    };
    const up = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const b = cellAt(ev.clientX, ev.clientY);
      // A click without a drag selects nothing: it is the start of a double-click, or a miss.
      if (b.r !== d.a.r || b.c !== d.a.c) copy(d.a, b, d.block);
      else setSel(null);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const sx = canvas.offsetWidth / frame.width;
  const sy = canvas.offsetHeight / frame.height;
  return (
    <div ref={box} className="text-select" tabIndex={0} role="application" aria-label="Select text on the server's screen. Escape cancels."
      style={{ left: canvas.offsetLeft, top: canvas.offsetTop, width: canvas.offsetWidth, height: canvas.offsetHeight }}
      onMouseDown={onMouseDown}>
      {sel && spans(sel.a, sel.b, sel.block, grid.cols).map(({ r, c0, c1 }) => (
        <div key={r} className="hl" style={{
          left: (grid.ox + c0 * grid.cw) * sx, top: (grid.oy + r * grid.ch) * sy,
          width: (c1 - c0 + 1) * grid.cw * sx, height: grid.ch * sy,
        }} />
      ))}
    </div>
  );
}
