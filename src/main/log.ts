/**
 * Session log: a ring buffer for the in-app log view, a daily file on disk,
 * and a live feed to the renderer. Callers must never pass secrets (tokens,
 * cookies, passwords); the protocol layer already redacts them.
 */
import { appendFileSync } from 'node:fs';
import type { Logger } from '../protocol/client';

export class LogBook {
  private readonly lines: string[] = [];
  /** Daily log file; empty = memory only. */
  file = '';
  /** Live listener (the renderer's log view). */
  onLine?: (line: string) => void;

  constructor(private readonly max = 2000, private readonly debug = !!process.env.OJV_DEBUG) {}

  log: Logger = (level, msg) => {
    if (level === 'debug' && !this.debug) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.shift();
    try {
      if (this.file) appendFileSync(this.file, line + '\n');
    } catch { /* a full or read-only disk must not break the session */ }
    this.onLine?.(line);
  };

  text(): string {
    return this.lines.join('\n');
  }
}
