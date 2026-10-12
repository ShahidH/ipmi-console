/**
 * KVM session state, driven by main-process events. A pure reducer, so the
 * state machine is unit-testable without React or IPC.
 */
import { useEffect, useReducer } from 'react';
import type { KvmEnded, KvmInfo, KvmStatus } from '../../shared/api';
import { api } from '../api';
import { videoEngine } from '../video/engine';

export type Phase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

export interface Target { name: string; host: string; serverId?: string }

export interface Reconnect { attempt: number; max: number; delaySec: number; scheduledAt: number }

export interface SessionState {
  phase: Phase;
  target: Target | null;
  /** Human label of the current connection step. */
  step: string;
  info: KvmInfo;
  connectedAt?: number;
  reconnect?: Reconnect;
  /** Why the session was lost or ended. */
  reason?: string;
  /** Latest protocol warning (shown in the status bar). */
  warning?: string;
  /** When the last video frame was live (for the "last frame" note while reconnecting). */
  lostAt?: number;
}

export type SessionAction =
  | { type: 'start'; target: Target }
  | { type: 'status'; status: KvmStatus; now: number }
  | { type: 'ended'; ended: KvmEnded; now: number }
  | { type: 'info'; info: KvmInfo }
  | { type: 'failed' }
  | { type: 'close' };

const STEP_LABELS: Record<string, string> = {
  login: 'Logging in…', launch: 'Requesting KVM session…', detect: 'Detecting firmware…', connecting: 'Connecting…',
  handshake: 'Authenticating KVM session…', connected: 'Connected', reconnecting: 'Reconnecting…',
};

export const initialSession: SessionState = { phase: 'idle', target: null, step: '', info: {} };

/** Parses the client's "attempt 3/8 in 4s" detail. */
export function parseReconnect(detail: string | undefined, now: number): Reconnect | undefined {
  const m = /attempt (\d+)\/(\d+) in (\d+)s/.exec(detail ?? '');
  return m ? { attempt: Number(m[1]), max: Number(m[2]), delaySec: Number(m[3]), scheduledAt: now } : undefined;
}

export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case 'start':
      return { ...initialSession, phase: 'connecting', target: a.target, step: STEP_LABELS.login };
    case 'status': {
      if (s.phase === 'idle') return s;
      const { phase, detail } = a.status;
      if (phase === 'warning') return { ...s, warning: detail };
      if (phase === 'closed') return s;
      if (phase === 'connected') return { ...s, phase: 'connected', step: STEP_LABELS.connected, connectedAt: a.now, reconnect: undefined, reason: undefined, lostAt: undefined };
      if (phase === 'reconnecting') return { ...s, phase: 'reconnecting', step: STEP_LABELS.reconnecting, reconnect: parseReconnect(detail, a.now) ?? s.reconnect, lostAt: s.lostAt ?? a.now };
      return { ...s, step: STEP_LABELS[phase] ?? phase };
    }
    case 'ended':
      if (s.phase === 'idle') return s;
      if (a.ended.willReconnect) return { ...s, phase: 'reconnecting', reason: a.ended.reason, lostAt: s.lostAt ?? a.now };
      return { ...s, phase: 'ended', reason: a.ended.reason, reconnect: undefined, lostAt: s.lostAt ?? a.now };
    case 'info':
      return { ...s, info: { ...s.info, ...a.info } };
    case 'failed':
    case 'close':
      return initialSession;
  }
}

export function useKvmSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialSession);
  useEffect(() => {
    const offs = [
      api().on('kvm:status', (status) => {
        if (status.phase === 'connected') videoEngine().reset();
        dispatch({ type: 'status', status, now: Date.now() });
      }),
      api().on('kvm:ended', (ended) => dispatch({ type: 'ended', ended, now: Date.now() })),
      api().on('kvm:info', (info) => dispatch({ type: 'info', info })),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  return [state, dispatch] as const;
}
