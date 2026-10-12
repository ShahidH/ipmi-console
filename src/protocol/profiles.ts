/**
 * Firmware profiles capture the parts of the IVTP session that differ between
 * MegaRAC generations. Framing, video and HID packet layout are shared.
 *
 * Two families exist:
 *  - legacy MegaRAC SP ("JViewer" era): /rpc/*.asp web API, JNLP launch,
 *    raw TCP/TLS or single-port tunnel;
 *  - MegaRAC SP-X ("H5Viewer"): REST /api/session, WebSocket wss://host/kvm.
 *
 * Every validate body observed so far is a prefix of the same field sequence
 * (type, token, client IP, username, MAC, server IP), so a body size maps
 * directly to a layout.
 */
import { encodeHeader, encodePacket, Op, putFixedAscii } from './ivtp';
import type { JViewerFingerprint } from './jarprobe';
import type { LaunchConfig } from './jnlp';
import type { KeyboardMode } from './keymap';

export interface HandshakeContext {
  launch: LaunchConfig;
  username: string;
  localIp: string;
  localMac: string;
  /** SP-X h5viewercfg fields. */
  serverIp?: string;
  spxSession?: string;
  /** Firmware advertises KVM session reconnect (JNLP oemfeatures & 32 / SP-X KVM_SESSION_RECONNECT). */
  reconnectFeature?: boolean;
}

export type ProfileStatus = 'hardware-verified' | 'observed' | 'third-party-report' | 'experimental';
export type Family = 'legacy-sp' | 'spx';

export interface FirmwareProfile {
  id: string;
  name: string;
  family: Family;
  status: ProfileStatus;
  evidence: string;
  keyboardMode: KeyboardMode;
  /** Power-control status value meaning "soft reset/ACPI shutdown" for this firmware. */
  softPowerCode: number;
  /** Packets to send when the BMC announces SESSION_ACCEPTED (type 23). */
  onSessionAccepted(ctx: HandshakeContext): Buffer[];
  /** Packets to send after a positive VALIDATE_VIDEO_SESSION_RESPONSE. */
  onValidated(ctx: HandshakeContext): Buffer[];
  /** Optional reactions to other server packets (e.g. SP-X MEDIA_LICENSE_STATUS). */
  onPacket?(type: number, status: number, ctx: HandshakeContext): Buffer[];
  /** Client-originated keep-alive, if the firmware expects one. */
  keepAlive?: { intervalMs: number; packet: () => Buffer };
  /** SP-X expects periodic FPS_DIFF (60) video feedback. */
  videoFeedbackMs?: number;
}

function buildValidateBody(size: number, ctx: HandshakeContext): Buffer {
  if (size < 130) throw new Error(`validate body ${size} too small`);
  const b = Buffer.alloc(size);
  b[0] = 0; // WEB_SESSION_TOKEN
  putFixedAscii(b, 1, 129, ctx.launch.kvmToken);
  const put = (off: number, len: number, s: string) => {
    if (off + len <= size) putFixedAscii(b, off, len, s);
  };
  put(130, 65, ctx.localIp);
  put(195, 129, ctx.username);
  put(324, 49, ctx.localMac || '00-00-00-00-00-00');
  put(373, 65, ctx.serverIp ?? ctx.launch.host);
  return b;
}

/** Validate body sizes whose layout is known (field boundaries). */
const KNOWN_VALIDATE_SIZES = [195, 324, 373, 438];

export interface JViewerProfileOptions {
  size: number;
  /** The header size field is body+8 (195/324 firmware). */
  headerPlus8: boolean;
  /** Send RESUME right after VALIDATE (2017-era firmware) instead of after the response. */
  resumeImmediately: boolean;
  /** Send GET_WEB_TOKEN (21) with the web cookie before validating. */
  sendWebToken: boolean;
  keepAlive: boolean;
  softPowerCode: number;
  keyboardMode: KeyboardMode;
}

/** Builds a legacy (JNLP-launched) MegaRAC SP profile. */
function jviewerProfile(id: string, name: string, status: ProfileStatus, evidence: string, o: JViewerProfileOptions): FirmwareProfile {
  return {
    id, name, status, evidence, family: 'legacy-sp', keyboardMode: o.keyboardMode, softPowerCode: o.softPowerCode,
    onSessionAccepted(ctx) {
      const out: Buffer[] = [];
      // rd450x: bodyless CONNECTION_COMPLETE when the firmware advertises reconnect.
      if (ctx.reconnectFeature) out.push(encodeHeader(Op.CONNECTION_COMPLETE, 0));
      if (o.sendWebToken) out.push(encodePacket(Op.GET_WEB_TOKEN, Buffer.from(ctx.launch.webCookie, 'latin1')));
      const body = buildValidateBody(o.size, ctx);
      out.push(Buffer.concat([encodeHeader(Op.VALIDATE_VIDEO_SESSION, o.headerPlus8 ? o.size + 8 : o.size), body]));
      if (o.resumeImmediately) out.push(encodeHeader(Op.RESUME_REDIRECTION, 0));
      return out;
    },
    onValidated() {
      const out = o.resumeImmediately ? [] : [encodeHeader(Op.RESUME_REDIRECTION, 0)];
      // After validation: request power status, then user macros.
      out.push(encodeHeader(Op.POWER_STATUS, 0), encodeHeader(Op.GET_USER_MACRO, 0));
      return out;
    },
    keepAlive: o.keepAlive ? { intervalMs: 5000, packet: () => encodeHeader(Op.KEEP_ALIVE, 0) } : undefined,
  };
}

/** 2017-era MegaRAC SP firmware (AST2300 board). */
const JVIEWER_195 = jviewerProfile(
  'megarac-jviewer-195', 'MegaRAC SP, JViewer 195-byte validate (2017-era firmware)', 'observed',
  'observed: AST2300 board, MegaRAC SP firmware (JViewer 2017)',
  { size: 195, headerPlus8: true, resumeImmediately: true, sendWebToken: true, keepAlive: false, softPowerCode: 4, keyboardMode: 'autobreak' },
);

/** ASUS ASMB8-iKVM fw 1.14 (AST2400), ASRock Rack AST2400/2500 SP. */
const JVIEWER_324 = jviewerProfile(
  'megarac-jviewer-324', 'MegaRAC SP, JViewer 324-byte validate (e.g. ASUS ASMB8-iKVM, ASRock Rack X99/C2xx)', 'third-party-report',
  'reported: ansible-collection-asmb8-ikvm (header size 332), kvm-switcher',
  { size: 324, headerPlus8: true, resumeImmediately: true, sendWebToken: true, keepAlive: false, softPowerCode: 4, keyboardMode: 'autobreak' },
);

/** Lenovo ThinkServer RD450X fw 2.36 (rd450x-console). */
const JVIEWER_373 = jviewerProfile(
  'megarac-ivtp-373', 'MegaRAC SP, 373-byte validate + keep-alive (e.g. Lenovo RD450X fw 2.36)', 'third-party-report',
  'reported: rd450x-console (Lenovo RD450X fw 2.36)',
  { size: 373, headerPlus8: false, resumeImmediately: false, sendWebToken: false, keepAlive: true, softPowerCode: 5, keyboardMode: 'state' },
);

/** MegaRAC SP-X H5Viewer (AST2500: Tyan S8030 6.02, ASRock Rack, ASUS). */
function spxProfile(id: string, name: string, size: number, evidence: string): FirmwareProfile {
  let sentFullScreen = false;
  return {
    id, name, family: 'spx', status: 'third-party-report', evidence, keyboardMode: 'state', softPowerCode: 5, videoFeedbackMs: 100,
    onSessionAccepted(ctx) {
      const out: Buffer[] = [];
      if (ctx.reconnectFeature) out.push(encodeHeader(Op.CONNECTION_COMPLETE, 0, 1));
      out.push(encodePacket(Op.VALIDATE_VIDEO_SESSION, buildValidateBody(size, ctx), 1));
      out.push(encodeHeader(Op.RESUME_REDIRECTION, 0));
      sentFullScreen = false;
      return out;
    },
    onValidated() {
      return [encodeHeader(Op.SET_MOUSE_MODE, 0, 2), encodeHeader(Op.GET_FULL_SCREEN, 0, 1), encodeHeader(Op.POWER_STATUS, 0)];
    },
    onPacket(type, _status, ctx) {
      if (type === Op.MEDIA_LICENSE_STATUS) {
        const out = [encodePacket(Op.DISPLAY_LOCK_SET, Buffer.from([2])), encodeHeader(Op.GET_USER_MACRO, 0)];
        if (ctx.spxSession) {
          const s = Buffer.alloc(35);
          putFixedAscii(s, 0, 35, ctx.spxSession);
          out.push(encodePacket(Op.GET_WEB_TOKEN, s));
        }
        return out;
      }
      if (type === Op.GET_ACTIVE_CLIENTS && !sentFullScreen) {
        sentFullScreen = true;
        return [encodeHeader(Op.GET_FULL_SCREEN, 0, 1)];
      }
      return [];
    },
  };
}

const SPX_438 = spxProfile('megarac-spx-438', 'MegaRAC SP-X HTML5 (438-byte validate; ASRock Rack/ASUS/Tyan AST2500)', 438,
  'reported: megarac-kvm-rs (Tyan S8030 fw 6.02), hitsc (ASRock Rack/ASUS)');
const SPX_373 = spxProfile('megarac-spx-373', 'MegaRAC SP-X HTML5 (373-byte validate; OVH/ASRock Rack OEM)', 373,
  'reported: ovh-ikvm-mcp');

const PROFILES: FirmwareProfile[] = [JVIEWER_195, JVIEWER_324, JVIEWER_373, SPX_438, SPX_373];

/** Aliases kept for existing call sites/tests. */
export const JVIEWER_LEGACY = JVIEWER_195;
export const RD450X_373 = JVIEWER_373;

export interface ProfileChoice {
  profile: FirmwareProfile;
  /** How the choice was made, for diagnostics. */
  basis: string;
  /** Set when the evidence does not match any known profile. */
  warning?: string;
}

/**
 * Chooses a legacy-family profile. Rules, strongest first:
 *  1. explicit user choice;
 *  2. the client jar the BMC itself serves (VIDEO_PACKET_SIZE, header-size
 *     constant, presence of KEEP_ALIVE/CONNECTION_COMPLETE);
 *  3. JNLP heuristics (-oemfeatures only appears on newer firmware);
 *  4. default: the 195-byte profile.
 */
export function selectProfile(launch: LaunchConfig, override?: string, fp?: JViewerFingerprint): ProfileChoice {
  if (override && override !== 'auto') {
    const p = PROFILES.find((x) => x.id === override);
    if (!p) throw new Error(`unknown firmware profile ${override}`);
    return { profile: p, basis: 'user override' };
  }
  if (fp?.validatePacketSize !== undefined) {
    const size = fp.validatePacketSize;
    const plus8 = fp.validateHeaderPlus8 ?? size < 373;
    const known = [JVIEWER_195, JVIEWER_324, JVIEWER_373].find((p) => p.id.endsWith(`-${size}`));
    if (known && (known === JVIEWER_373 ? !plus8 : plus8) && (known !== JVIEWER_195 || !fp.hasKeepAlive)) {
      return { profile: known, basis: `BMC JViewer.jar: VIDEO_PACKET_SIZE=${size}, header ${plus8 ? 'body+8' : 'body'}` };
    }
    if (KNOWN_VALIDATE_SIZES.includes(size)) {
      // Known layout, unfamiliar combination: build a profile from the jar's constants.
      const p = jviewerProfile(`megarac-jviewer-${size}-fp`, `MegaRAC SP, ${size}-byte validate (from BMC jar)`, 'experimental', 'BMC JViewer.jar fingerprint', {
        size, headerPlus8: plus8, resumeImmediately: !fp.hasKeepAlive, sendWebToken: true, keepAlive: fp.hasKeepAlive,
        softPowerCode: fp.softResetCode ?? 4, keyboardMode: 'autobreak',
      });
      return {
        profile: p, basis: `BMC JViewer.jar: VIDEO_PACKET_SIZE=${size} (derived profile)`,
        warning: `Untested JViewer variant (validate ${size} bytes, header ${plus8 ? 'body+8' : 'body'}, keep-alive ${fp.hasKeepAlive}); using a profile built from the parameters in the BMC's own client files. Please report results.`,
      };
    }
    const guess = fp.hasKeepAlive || fp.hasConnectionComplete ? JVIEWER_373 : JVIEWER_195;
    return { profile: guess, basis: `BMC JViewer.jar: VIDEO_PACKET_SIZE=${size}`, warning: `Unrecognised JViewer build (validate packet ${size} bytes). Trying the closest profile; please report this firmware.` };
  }
  if (launch.oemFeatures !== undefined) return { profile: JVIEWER_373, basis: 'JNLP has -oemfeatures' };
  return { profile: JVIEWER_195, basis: 'default (no jar fingerprint available)' };
}

/** Chooses an SP-X profile from h5viewercfg (server_ip present → 438-byte body). */
export function selectSpxProfile(override: string | undefined, hasServerIp: boolean): ProfileChoice {
  if (override && override !== 'auto') {
    const p = PROFILES.find((x) => x.id === override && x.family === 'spx');
    if (p) return { profile: p, basis: 'user override' };
  }
  return hasServerIp ? { profile: SPX_438, basis: 'h5viewercfg has server_ip' } : { profile: SPX_373, basis: 'h5viewercfg without server_ip' };
}
