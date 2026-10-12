// An in-memory stand-in for window.ojv (the preload bridge) for component tests.
import { vi } from 'vitest';
import type { ConnectResult, DetectResult, EventChannel, EventMap, OjvApi, PowerResult, ServerInfo, TypeClipboardResult } from '../../src/shared/api';

export function server(over: Partial<ServerInfo> = {}): ServerInfo {
  return { id: 's1', name: 'nas-01', host: '192.168.1.50', webScheme: 'http', username: 'admin', profile: 'auto', legacyTls: false, hasPassword: false, ...over };
}

export function installFakeApi(servers: ServerInfo[] = []) {
  const handlers = new Map<EventChannel, Set<(...a: unknown[]) => void>>();
  const api = {
    listServers: vi.fn(async () => servers),
    saveServer: vi.fn(async () => 'new-id'),
    deleteServer: vi.fn(async () => {}),
    detect: vi.fn(async (): Promise<DetectResult> => ({ reachable: true, family: 'megarac-sp', familyName: 'AMI MegaRAC SP (Java JViewer generation)', supported: true, scheme: 'http' })),
    reachability: vi.fn(async (ids: string[]): Promise<Record<string, boolean>> => Object.fromEntries(ids.map((id) => [id, true]))),
    connect: vi.fn(async (_id: string, _pw?: string): Promise<ConnectResult> => ({ ok: true })),
    openJnlp: vi.fn(async (): Promise<ConnectResult> => ({ cancelled: true })),
    openJnlpText: vi.fn(async (_xml: string): Promise<ConnectResult> => ({ ok: true })),
    disconnect: vi.fn(async () => {}),
    retryNow: vi.fn(async () => true),
    trustCertificate: vi.fn(async () => {}),
    key: vi.fn(),
    releaseKeys: vi.fn(),
    mouse: vi.fn(),
    frameSize: vi.fn(),
    chord: vi.fn(async () => {}),
    typeClipboard: vi.fn(async (): Promise<TypeClipboardResult> => ({ status: 'typed', typed: 0, skipped: 0, cancelled: false })),
    cancelTyping: vi.fn(async () => {}),
    copyText: vi.fn(async (_t: string) => {}),
    power: vi.fn(async (): Promise<PowerResult> => 'done'),
    refresh: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    answerShare: vi.fn(async () => {}),
    setTypingLayout: vi.fn(async () => {}),
    logs: vi.fn(async () => ''),
    notices: vi.fn(async (): Promise<string[]> => []),
    fitWindow: vi.fn(async (_w: number, _h: number) => true),
    reportError: vi.fn(),
    logPath: vi.fn(async () => ''),
    on: vi.fn((ch: EventChannel, fn: (...a: unknown[]) => void) => {
      if (!handlers.has(ch)) handlers.set(ch, new Set());
      handlers.get(ch)!.add(fn);
      return () => handlers.get(ch)!.delete(fn);
    }),
  } satisfies OjvApi;
  window.ojv = api as unknown as OjvApi;
  /** Simulates an event from the main process. */
  const emit = <K extends EventChannel>(ch: K, ...args: EventMap[K]) => handlers.get(ch)?.forEach((fn) => fn(...args));
  return { api, emit };
}

// jsdom lacks these.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
