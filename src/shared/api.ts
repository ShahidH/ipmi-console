/**
 * The IPC contract between the main process and the sandboxed renderer.
 * The preload implements `OjvApi`; the renderer consumes it as `window.ojv`.
 * Types only (plus the channel list), so both sides can import it.
 */

export interface ServerInfo {
  id: string;
  name: string;
  host: string;
  webScheme: 'http' | 'https';
  webPort?: number;
  username: string;
  profile: string;
  family?: string;
  keyboardMode?: string;
  typingLayout?: TypingLayoutChoice;
  legacyTls: boolean;
  hasPassword: boolean;
  /** Family detected on the last successful connect. */
  lastFamily?: string;
  /** Epoch ms of the last successful connect. */
  lastConnectedAt?: number;
}

export interface ServerInput {
  id?: string;
  name: string;
  host: string;
  webScheme: 'http' | 'https';
  webPort?: number;
  username: string;
  password?: string;
  savePassword?: boolean;
  profile: string;
  family: string;
  keyboardMode: string;
  typingLayout: TypingLayoutChoice;
  legacyTls: boolean;
}

export type ErrorKind = 'password' | 'certificate' | 'network' | 'auth' | 'protocol' | 'busy' | 'privilege' | 'unsupported';

export interface ConnectResult {
  ok?: boolean;
  error?: string;
  kind?: ErrorKind;
  fingerprint?: string;
  subject?: string;
  cancelled?: boolean;
  family?: string;
}

export interface DetectResult {
  reachable: boolean;
  family: string;
  familyName: string;
  supported: boolean;
  scheme: 'http' | 'https';
}

export interface KvmStatus { phase: string; detail?: string }
export interface KvmEnded { reason: string; willReconnect: boolean }
export interface KvmInfo {
  mouseMode?: number;
  encrypted?: boolean;
  /** Bit 0 Num Lock, bit 1 Caps Lock, bit 2 Scroll Lock. */
  leds?: number;
  /** 1 on, 0 off. */
  power?: number;
  users?: string[];
  keyboardMode?: string;
  keyboardModeAuto?: boolean;
  /** Host layout used by typeText. */
  typingLayout?: TypingLayoutChoice;
  /**
   * What this session may do when another user shares the console:
   * `waiting` while asking the owner for access, `view-only` if they granted only that.
   * Keyboard, mouse and power are off unless `full`.
   */
  access?: KvmAccess;
  /** The other user on this console ("name (address)"), or '' if none. */
  sharedWith?: string;
}
export type KvmAccess = 'full' | 'view-only' | 'waiting';
export interface ShareRequest { user: string; ip: string }
/** Mouse modes the BMC reports (KvmInfo.mouseMode): only absolute (2) takes positions; any other is relative. */
export const isRelativeMouse = (mode: number) => mode !== 2;
/** Something the user should know about the session, shown as a toast. */
export interface KvmNotice { title: string; detail?: string; level?: 'err' }
/** Outcome of a power command: accepted or refused by the BMC, or no answer within 10 s. */
export type PowerResult = 'done' | 'refused' | 'no-answer' | 'not-allowed';

/** Longest text Type clipboard accepts (about 30 minutes of typing). */
export const MAX_TYPE_TEXT = 65536;
/** Progress of Type clipboard, sent while it runs. */
export interface TypingProgress { done: number; total: number }
export interface TypeResult { typed: number; skipped: number; cancelled: boolean }
export type TypeClipboardResult =
  | ({ status: 'typed' } & TypeResult)
  | { status: 'empty' }
  | { status: 'too-long'; length: number }
  | { status: 'no-session' };
export interface MouseInput { x?: number; y?: number; dx?: number; dy?: number; buttons?: number; wheel?: number }

export type PowerActionName = 'on' | 'soft' | 'off' | 'reset' | 'cycle';
export type ChordName = 'ctrl-alt-del' | 'alt-tab' | 'alt-f4' | 'ctrl-esc' | 'win' | 'printscreen' | 'alt-sysrq' | 'ctrl-alt-backspace';
export type KeyboardModeChoice = 'auto' | 'autobreak' | 'state' | 'single';
/** Host keyboard layout for typing text; mirrors TypingLayout in protocol/layouts.ts. */
export type TypingLayoutChoice = 'us' | 'gb' | 'de' | 'fr' | 'es' | 'jp';
export const TYPING_LAYOUT_LABELS: Record<TypingLayoutChoice, string> = {
  us: 'English (US)', gb: 'English (UK)', de: 'German', fr: 'French', es: 'Spanish', jp: 'Japanese',
};

/**
 * Default layout for a new server from this computer's language. Regional
 * variants with a different layout (Swiss German, Canadian or Belgian French,
 * Latin American Spanish) fall back to US rather than guessing.
 */
export function layoutForLocale(locale: string): TypingLayoutChoice {
  const l = locale.toLowerCase();
  if (/^en-(gb|ie)\b/.test(l)) return 'gb';
  if (/^de(-(de|at|lu))?$/.test(l)) return 'de';
  if (/^fr(-fr)?$/.test(l)) return 'fr';
  if (/^es(-es)?$/.test(l)) return 'es';
  if (/^ja(-jp)?$/.test(l)) return 'jp';
  return 'us';
}

export interface EventMap {
  'kvm:status': [KvmStatus];
  'kvm:frame': [Uint8Array];
  'kvm:blank': [];
  'kvm:info': [KvmInfo];
  'kvm:ended': [KvmEnded];
  /** Another user asks for access; null when the request is withdrawn or has timed out. */
  'kvm:shareRequest': [ShareRequest | null];
  'kvm:notice': [KvmNotice];
  'kvm:typing': [TypingProgress];
  /** An unexpected main-process error the user should know about. */
  'app:error': [string];
  log: [string];
}
export type EventChannel = keyof EventMap;
export const EVENT_CHANNELS: readonly EventChannel[] = ['kvm:status', 'kvm:frame', 'kvm:blank', 'kvm:info', 'kvm:ended', 'kvm:shareRequest', 'kvm:notice', 'kvm:typing', 'app:error', 'log'];

export interface OjvApi {
  listServers(): Promise<ServerInfo[]>;
  saveServer(s: ServerInput): Promise<string>;
  deleteServer(id: string): Promise<void>;
  /** Unauthenticated, read-only identification of the BMC at this address. */
  detect(host: string, scheme: 'http' | 'https', port?: number): Promise<DetectResult>;
  /** TCP reachability of each server's web port, by server id. */
  reachability(ids: string[]): Promise<Record<string, boolean>>;
  connect(serverId: string, password?: string): Promise<ConnectResult>;
  openJnlp(): Promise<ConnectResult>;
  openJnlpText(xml: string): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  retryNow(): Promise<boolean>;
  trustCertificate(host: string, fingerprint: string): Promise<void>;
  key(code: string, down: boolean): void;
  releaseKeys(): void;
  mouse(m: MouseInput): void;
  frameSize(w: number, h: number): void;
  chord(name: ChordName): Promise<void>;
  /**
   * Types this computer's clipboard text (up to MAX_TYPE_TEXT) into the host as
   * key presses for the session's host layout, reporting progress on kvm:typing.
   * The clipboard is read by the main process; the window never sees it.
   */
  typeClipboard(): Promise<TypeClipboardResult>;
  /** Puts text on this computer's clipboard (text read from the server's screen). */
  copyText(text: string): Promise<void>;
  /** Stops a typeText in progress. */
  cancelTyping(): Promise<void>;
  power(action: PowerActionName): Promise<PowerResult>;
  refresh(): Promise<void>;
  wake(): Promise<void>;
  answerShare(decision: 0 | 1 | 2): Promise<void>;
  /** Sets (and remembers for the server) the host layout used by typeText. */
  setTypingLayout(layout: TypingLayoutChoice): Promise<void>;
  logs(): Promise<string>;
  /**
   * Resizes the window so its content area is width x height, if that fits on the
   * screen and the window is not maximised or full screen. Resolves to whether it did.
   */
  fitWindow(width: number, height: number): Promise<boolean>;
  /** Messages for the user from startup (settings recovered, window crashed and was reloaded). Each is returned once. */
  notices(): Promise<string[]>;
  /** Reports an unexpected renderer error to the main-process log. */
  reportError(message: string): void;
  logPath(): Promise<string>;
  on<K extends EventChannel>(channel: K, fn: (...args: EventMap[K]) => void): () => void;
}
