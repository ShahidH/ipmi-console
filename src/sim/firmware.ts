/**
 * Simulated firmware variants: what the BMC side expects and sends. Mirrors the
 * client profiles in src/protocol/profiles.ts, but written from the server's
 * point of view so the two can catch each other's mistakes.
 */

export type Family = 'megarac-sp' | 'megarac-spx';

export interface SimFirmware {
  id: string;
  family: Family;
  description: string;
  /** VALIDATE_VIDEO_SESSION body size the BMC expects. */
  validateSize: number;
  /** Header size field the vendor client writes (body + 8 on the older jars). */
  validateHeaderSize: number;
  /** Status the vendor client puts in the VALIDATE header (SP-X uses 1). */
  validateStatus: number;
  /** Expects GET_WEB_TOKEN (21) with the web cookie before VALIDATE. */
  expectsWebToken: boolean;
  /** Video starts only after RESUME (6) follows a successful validate. */
  resumeAfterValidate: boolean;
  /** Client must send KEEP_ALIVE (57) periodically (rd450x firmware). */
  expectsClientKeepAlive: boolean;
  /** BMC sends KEEP_ALIVE and expects an echo (SP-X). */
  sendsKeepAlive: boolean;
  /** SP-X: MEDIA_LICENSE_STATUS (53) after validate. */
  sendsMediaLicense: boolean;
  /** JNLP carries -oemfeatures with the reconnect bit (requires CONNECTION_COMPLETE first). */
  oemFeatures?: number;
  /** Constants embedded in the synthetic JViewer.jar (legacy family). */
  jar?: { videoPacketSize: number; headerPlus8: boolean; keepAlive: boolean; softReset: number };
  /** Keyboard report style the vendor client uses (for the input log). */
  keyboard: 'autobreak' | 'state';
  softPowerCode: number;
}

export const SIM_FIRMWARE: Record<string, SimFirmware> = {
  'sp-195': {
    id: 'sp-195', family: 'megarac-sp',
    description: 'MegaRAC SP, JViewer 2017 (AST2300 board) — the hardware-verified case',
    validateSize: 195, validateHeaderSize: 203, validateStatus: 0, expectsWebToken: true, resumeAfterValidate: false,
    expectsClientKeepAlive: false, sendsKeepAlive: false, sendsMediaLicense: false,
    jar: { videoPacketSize: 195, headerPlus8: true, keepAlive: false, softReset: 4 }, keyboard: 'autobreak', softPowerCode: 4,
  },
  'sp-324': {
    id: 'sp-324', family: 'megarac-sp',
    description: 'MegaRAC SP, 324-byte validate (ASUS ASMB8-iKVM fw 1.14, ASRock Rack AST2400/2500) — third-party report',
    validateSize: 324, validateHeaderSize: 332, validateStatus: 0, expectsWebToken: true, resumeAfterValidate: false,
    expectsClientKeepAlive: false, sendsKeepAlive: false, sendsMediaLicense: false,
    jar: { videoPacketSize: 324, headerPlus8: true, keepAlive: false, softReset: 4 }, keyboard: 'autobreak', softPowerCode: 4,
  },
  'sp-373': {
    id: 'sp-373', family: 'megarac-sp',
    description: 'MegaRAC SP, 373-byte validate + keep-alive (Lenovo RD450X fw 2.36) — third-party report',
    validateSize: 373, validateHeaderSize: 373, validateStatus: 0, expectsWebToken: false, resumeAfterValidate: true,
    expectsClientKeepAlive: true, sendsKeepAlive: false, sendsMediaLicense: false, oemFeatures: 32,
    jar: { videoPacketSize: 373, headerPlus8: false, keepAlive: true, softReset: 5 }, keyboard: 'state', softPowerCode: 5,
  },
  'spx-438': {
    id: 'spx-438', family: 'megarac-spx',
    description: 'MegaRAC SP-X HTML5 viewer, 438-byte validate (Tyan S8030 6.02, ASRock Rack/ASUS AST2500) — third-party report',
    validateSize: 438, validateHeaderSize: 438, validateStatus: 1, expectsWebToken: false, resumeAfterValidate: false,
    expectsClientKeepAlive: false, sendsKeepAlive: true, sendsMediaLicense: true, keyboard: 'state', softPowerCode: 5,
  },
  'spx-373': {
    id: 'spx-373', family: 'megarac-spx',
    description: 'MegaRAC SP-X HTML5 viewer, 373-byte validate (OVH / ASRock Rack OEM) — third-party report',
    validateSize: 373, validateHeaderSize: 373, validateStatus: 1, expectsWebToken: false, resumeAfterValidate: false,
    expectsClientKeepAlive: false, sendsKeepAlive: true, sendsMediaLicense: true, keyboard: 'state', softPowerCode: 5,
  },
  'sp-324-mislabelled': {
    id: 'sp-324-mislabelled', family: 'megarac-sp',
    description: 'Negative test: firmware expects a 324-byte validate but its jar advertises 195',
    validateSize: 324, validateHeaderSize: 332, validateStatus: 0, expectsWebToken: true, resumeAfterValidate: false,
    expectsClientKeepAlive: false, sendsKeepAlive: false, sendsMediaLicense: false,
    jar: { videoPacketSize: 195, headerPlus8: true, keepAlive: false, softReset: 4 }, keyboard: 'autobreak', softPowerCode: 4,
  },
};
