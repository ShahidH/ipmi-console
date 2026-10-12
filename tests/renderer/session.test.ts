import { describe, expect, it } from 'vitest';
import { initialSession, parseReconnect, sessionReducer, type SessionAction, type SessionState } from '../../src/renderer/hooks/useKvmSession';

const run = (actions: SessionAction[], from: SessionState = initialSession) => actions.reduce(sessionReducer, from);
const target = { name: 'nas-01', host: '192.168.1.50' };

describe('session state machine', () => {
  it('walks through connecting steps to connected', () => {
    const s = run([
      { type: 'start', target },
      { type: 'status', status: { phase: 'launch' }, now: 1 },
      { type: 'status', status: { phase: 'handshake' }, now: 2 },
    ]);
    expect(s.phase).toBe('connecting');
    expect(s.step).toBe('Authenticating KVM session…');
    const c = sessionReducer(s, { type: 'status', status: { phase: 'connected' }, now: 5 });
    expect(c).toMatchObject({ phase: 'connected', connectedAt: 5 });
  });

  it('tracks a drop, the back-off schedule, and the recovery', () => {
    const s = run([
      { type: 'start', target },
      { type: 'status', status: { phase: 'connected' }, now: 1 },
      { type: 'ended', ended: { reason: 'connection reset', willReconnect: true }, now: 100 },
      { type: 'status', status: { phase: 'reconnecting', detail: 'attempt 2/8 in 2s' }, now: 101 },
    ]);
    expect(s).toMatchObject({ phase: 'reconnecting', reason: 'connection reset', lostAt: 100, reconnect: { attempt: 2, max: 8, delaySec: 2, scheduledAt: 101 } });
    const back = sessionReducer(s, { type: 'status', status: { phase: 'connected' }, now: 3000 });
    expect(back).toMatchObject({ phase: 'connected', reconnect: undefined, lostAt: undefined, reason: undefined });
  });

  it('ends for good when the client gives up', () => {
    const s = run([
      { type: 'start', target },
      { type: 'status', status: { phase: 'connected' }, now: 1 },
      { type: 'ended', ended: { reason: 'BMC stopped the session', willReconnect: false }, now: 9 },
    ]);
    expect(s).toMatchObject({ phase: 'ended', reason: 'BMC stopped the session' });
  });

  it('ignores late events after the user disconnected', () => {
    const s = run([{ type: 'start', target }, { type: 'close' }, { type: 'ended', ended: { reason: 'closed', willReconnect: false }, now: 1 }]);
    expect(s.phase).toBe('idle');
  });

  it('merges session info and keeps warnings separate from the phase', () => {
    const s = run([
      { type: 'start', target },
      { type: 'info', info: { mouseMode: 2 } },
      { type: 'info', info: { leds: 1 } },
      { type: 'status', status: { phase: 'warning', detail: 'decoder warning' }, now: 1 },
    ]);
    expect(s.info).toEqual({ mouseMode: 2, leds: 1 });
    expect(s).toMatchObject({ phase: 'connecting', warning: 'decoder warning' });
  });

  it('parses the reconnect detail', () => {
    expect(parseReconnect('attempt 3/8 in 4s', 7)).toEqual({ attempt: 3, max: 8, delaySec: 4, scheduledAt: 7 });
    expect(parseReconnect('something else', 7)).toBeUndefined();
  });
});
