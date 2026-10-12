/**
 * Scenario engine: a scenario picks a firmware variant, transport, video
 * source and a list of timed faults. The protocol emulator (ivtp-server.ts,
 * server.ts) stays generic; everything test-specific lives here.
 */

export type Fault =
  /** Close the KVM connection `at` ms after validation. */
  | { at: number; do: 'drop' }
  /** Close the connection halfway through sending a video frame. */
  | { at: number; do: 'drop-mid-frame' }
  /** BMC-initiated STOP_SESSION_IMMEDIATE with a reason code. */
  | { at: number; do: 'stop'; reason: number }
  /** Another user asks for access (KVM_SHARING request). */
  | { at: number; do: 'share-request'; user: string; ip: string }
  /** Any other KVM_SHARING message: code (0 withdrawn, 2 waiting, 3 timed out, 4 answer) and answer. */
  | { at: number; do: 'share'; code: number; answer?: number; user: string; ip: string }
  /** The other session sharing the console has ended (KVM_SOCKET_STATUS). */
  | { at: number; do: 'share-ended' }
  /** The BMC changes the mouse mode (1 relative, 2 absolute, 3 other). */
  | { at: number; do: 'mouse-mode'; mode: number }
  /** Refuse power commands (POWER_CONTROL_RESPONSE with a non-zero status). */
  | { do: 'refuse-power' }
  /** Flip bytes in the next video frame. */
  | { at: number; do: 'corrupt-frame' }
  /** Host display goes to sleep (BLANK_SCREEN until keyboard/mouse input). */
  | { at: number; do: 'sleep' }
  /** Answer the VALIDATE with this result code (0 invalid, 2 no privilege, 3 bad info, 8 unregistered). */
  | { do: 'reject-validate'; result: number }
  /** Send MAX_SESSION_CLOSING instead of validating. */
  | { do: 'max-sessions' }
  /** Delay every packet the BMC sends by `ms`. */
  | { do: 'latency'; ms: number }
  /** Single-port tunnel answers ERROR:<code> (1..7). */
  | { do: 'tunnel-error'; code: number };

export interface Scenario {
  name: string;
  description: string;
  firmware: string;
  /** Legacy family only: single-port tunnel through the web port, or a direct KVM port. */
  transport?: 'single-port' | 'direct';
  /** SP-X only: WebSocket message framing. */
  wsMode?: { base64?: boolean; deflate?: boolean };
  /** Send INITIAL_ENCRYPTION_STATUS so keyboard/mouse are Blowfish-encrypted. */
  encryption?: boolean;
  /** 'text' (default): synthetic console echoing input; 'demo': a firmware setup screen driven by the arrow keys; or a capture directory; or a recording file. */
  video?: 'text' | 'demo' | { captures: string } | { replay: string };
  fps?: number;
  mouseMode?: 1 | 2 | 3;
  /** Display asleep at connect (BLANK_SCREEN until input arrives). */
  displayAsleep?: boolean;
  /** Web-layer behaviour. */
  web?: { maxSessions?: number; jnlpExpired?: boolean };
  faults?: Fault[];
  /** Expected client outcome, used by the automated scenario tests. */
  expect: { connects: boolean; error?: string; reconnects?: boolean };
}

export const SCENARIOS: Scenario[] = [
  { name: 'sp-195', description: 'Reference board: MegaRAC SP JViewer 2017, single-port tunnel', firmware: 'sp-195', transport: 'single-port', expect: { connects: true } },
  { name: 'demo', description: 'A firmware setup screen you can navigate with the arrow keys, for demos and screenshots (MegaRAC SP, single-port tunnel)', firmware: 'sp-195', transport: 'single-port', video: 'demo', expect: { connects: true } },
  { name: 'sp-195-direct', description: 'MegaRAC SP 195 on a direct KVM port (7578-style)', firmware: 'sp-195', transport: 'direct', expect: { connects: true } },
  { name: 'sp-324', description: 'MegaRAC SP 324-byte validate (ASUS ASMB8 / ASRock Rack AST2400)', firmware: 'sp-324', transport: 'direct', expect: { connects: true } },
  { name: 'sp-373', description: 'MegaRAC SP 373-byte validate + keep-alive (Lenovo RD450X)', firmware: 'sp-373', transport: 'direct', expect: { connects: true } },
  { name: 'spx-438', description: 'MegaRAC SP-X HTML5 viewer over WebSocket', firmware: 'spx-438', expect: { connects: true } },
  { name: 'spx-438-deflate-b64', description: 'SP-X with permessage-deflate and base64 text frames', firmware: 'spx-438', wsMode: { base64: true, deflate: true }, expect: { connects: true } },
  { name: 'spx-373', description: 'SP-X 373-byte variant (OVH style)', firmware: 'spx-373', expect: { connects: true } },
  { name: 'encrypted', description: 'Keyboard/mouse Blowfish encryption negotiated by the BMC', firmware: 'sp-195', transport: 'single-port', encryption: true, expect: { connects: true } },
  { name: 'asleep', description: 'Host display asleep at connect; wakes on keyboard/mouse input', firmware: 'sp-195', transport: 'single-port', displayAsleep: true, expect: { connects: true } },
  { name: 'relative-mouse', description: 'BMC in relative mouse mode', firmware: 'sp-195', transport: 'single-port', mouseMode: 1, expect: { connects: true } },
  { name: 'drop', description: 'Network drop 3 s after connecting (client should reconnect)', firmware: 'sp-195', transport: 'single-port', faults: [{ at: 3000, do: 'drop' }], expect: { connects: true, reconnects: true } },
  { name: 'drop-mid-frame', description: 'Connection lost in the middle of a video frame', firmware: 'sp-195', transport: 'single-port', faults: [{ at: 2000, do: 'drop-mid-frame' }], expect: { connects: true, reconnects: true } },
  { name: 'corrupt-frame', description: 'One corrupted video frame (decoder must survive)', firmware: 'sp-195', transport: 'single-port', faults: [{ at: 1500, do: 'corrupt-frame' }], expect: { connects: true } },
  { name: 'slow-link', description: '300 ms latency on every BMC packet', firmware: 'sp-195', transport: 'single-port', faults: [{ do: 'latency', ms: 300 }], expect: { connects: true } },
  { name: 'kvm-in-use', description: 'Another user requests KVM access 4 s after connecting', firmware: 'sp-195', transport: 'single-port', faults: [{ at: 4000, do: 'share-request', user: 'operator', ip: '10.1.2.3' }], expect: { connects: true } },
  { name: 'bmc-stop', description: 'BMC stops the session (configuration change, reason 5)', firmware: 'sp-195', transport: 'single-port', faults: [{ at: 3000, do: 'stop', reason: 5 }], expect: { connects: true } },
  { name: 'max-sessions', description: 'BMC refuses: maximum KVM sessions reached', firmware: 'sp-195', transport: 'single-port', faults: [{ do: 'max-sessions' }], expect: { connects: false, error: 'Maximum number of KVM sessions' } },
  { name: 'token-rejected', description: 'BMC rejects the session token (validate result 0)', firmware: 'sp-195', transport: 'single-port', faults: [{ do: 'reject-validate', result: 0 }], expect: { connects: false, error: 'rejected the KVM session token' } },
  { name: 'no-kvm-privilege', description: 'Validate result 2: KVM disabled for this user', firmware: 'sp-324', transport: 'direct', faults: [{ do: 'reject-validate', result: 2 }], expect: { connects: false, error: 'KVM is disabled' } },
  { name: 'tunnel-no-slot', description: 'Single-port tunnel: no free web-session slot (ERROR:3)', firmware: 'sp-195', transport: 'single-port', faults: [{ do: 'tunnel-error', code: 3 }], expect: { connects: false, error: 'No free slot' } },
  { name: 'web-sessions-full', description: 'Web login refused: session pool exhausted', firmware: 'sp-195', transport: 'single-port', web: { maxSessions: 0 }, expect: { connects: false, error: 'login failed' } },
  { name: 'jnlp-expired', description: 'JNLP request answered with session_expired', firmware: 'sp-195', transport: 'single-port', web: { jnlpExpired: true }, expect: { connects: false, error: 'session' } },
  { name: 'wrong-profile', description: 'Firmware expects 324-byte validate but the jar says 195 (silent close)', firmware: 'sp-324-mislabelled', transport: 'direct', expect: { connects: false, error: 'handshake' } },
];

export function findScenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario "${name}". Known: ${SCENARIOS.map((x) => x.name).join(', ')}`);
  return s;
}
