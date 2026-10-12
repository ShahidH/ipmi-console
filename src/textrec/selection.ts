/**
 * Selections over recognised screen text, the way terminals select: a stream
 * from one cell to another (row-major), or a rectangle (block, e.g. one column
 * of a table). Pure functions over the recognised lines.
 */

export interface Cell { r: number; c: number }

/** Per-row column ranges covered by a selection, inclusive. */
export function spans(a: Cell, b: Cell, block: boolean, cols: number): Array<{ r: number; c0: number; c1: number }> {
  const [s, e] = a.r < b.r || (a.r === b.r && a.c <= b.c) ? [a, b] : [b, a];
  const out: Array<{ r: number; c0: number; c1: number }> = [];
  for (let r = s.r; r <= e.r; r++) {
    if (block) out.push({ r, c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) });
    else out.push({ r, c0: r === s.r ? s.c : 0, c1: r === e.r ? e.c : cols - 1 });
  }
  return out;
}

/** The selected text: trailing spaces trimmed per line, blank lines at either end dropped. */
export function selectionText(lines: string[], a: Cell, b: Cell, block: boolean): string {
  const cols = lines.reduce((n, l) => Math.max(n, l.length), 0);
  const rows = spans(a, b, block, cols).map(({ r, c0, c1 }) => (lines[r] ?? '').slice(c0, c1 + 1).trimEnd());
  while (rows.length && !rows[0]) rows.shift();
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.join('\n');
}

/** The run of non-space characters around a cell (double-click): words, IP addresses, paths. */
export function wordAt(lines: string[], at: Cell): [Cell, Cell] | null {
  const line = lines[at.r] ?? '';
  if (!line[at.c] || line[at.c] === ' ') return null;
  let c0 = at.c;
  let c1 = at.c;
  while (c0 > 0 && line[c0 - 1] !== ' ') c0--;
  while (c1 < line.length - 1 && line[c1 + 1] !== ' ') c1++;
  return [{ r: at.r, c: c0 }, { r: at.r, c: c1 }];
}

/** The whole row (triple-click). */
export function lineAt(lines: string[], at: Cell): [Cell, Cell] {
  return [{ r: at.r, c: 0 }, { r: at.r, c: Math.max(0, (lines[at.r] ?? '').length - 1) }];
}
