/**
 * Keyboard/mouse reports. Each is an IVTP HID_PKT (type 1) whose body is a
 * 32-byte AMI "IUSB" header, a 1-byte report length, then the USB HID report.
 *
 * Packet offsets (absolute, little-endian):
 *
 *   [0:8]   IVTP header (type 1, size = body length, status 0 | 0xFF if encrypted)
 *   [8:16]  "IUSB    "
 *   [16] 1 major  [17] 0 minor  [18] 32 header length  [19] checksum
 *   [20:24] data length incl. length byte (9 kbd, 7 abs mouse, 5 rel mouse)
 *   [24] 0  [25] device (0x30 kbd, 0x31 mouse)  [26] protocol (0x10 kbd, 0x20 mouse)
 *   [27] 0x80 direction  [28] 2 devnum  [29] ifnum (0 kbd, 1 mouse)  [30:32] 0
 *   [32:36] sequence number  [36:40] 0
 *   [40]    report length (8, 6, 4)
 *   [41:..] report, or its Blowfish-ECB encryption zero-padded to 8 bytes
 *   checksum = -(sum(bytes[8:40]) mod 256)
 */
import { encodeHeader, Op } from './ivtp';

export interface ReportCipher {
  /** Encrypts a zero-padded multiple of 8 bytes. */
  encrypt(block: Buffer): Buffer;
}

const KEYBOARD = { dataLen: 9, device: 0x30, proto: 0x10, ifnum: 0, reportLen: 8 };
const MOUSE_ABS = { dataLen: 7, device: 0x31, proto: 0x20, ifnum: 1, reportLen: 6 };
const MOUSE_REL = { dataLen: 5, device: 0x31, proto: 0x20, ifnum: 1, reportLen: 4 };
type Dev = typeof KEYBOARD;

export class HidPacketizer {
  /** Keyboard and mouse use separate sequence counters. */
  private kbdSeq = 0;
  private mouseSeq = 0;

  constructor(public cipher: ReportCipher | null = null) {}

  keyboard(report: Uint8Array): Buffer {
    if (report.length !== 8) throw new Error('keyboard report must be 8 bytes');
    return this.build(KEYBOARD, Buffer.from(report), this.kbdSeq++);
  }

  /** x, y in 0..32767; wheel is a signed step (+1 up, -1 down). */
  mouseAbsolute(buttons: number, x: number, y: number, wheel = 0): Buffer {
    const r = Buffer.alloc(6);
    r[0] = buttons & 0xff;
    r.writeInt16LE(clamp(x, 0, 32767), 1);
    r.writeInt16LE(clamp(y, 0, 32767), 3);
    r.writeInt8(clamp(wheel, -127, 127), 5);
    return this.build(MOUSE_ABS, r, this.mouseSeq++);
  }

  /** Relative movement, dx/dy in -127..127. */
  mouseRelative(buttons: number, dx: number, dy: number, wheel = 0): Buffer {
    const r = Buffer.alloc(4);
    r[0] = buttons & 0xff;
    r.writeInt8(clamp(dx, -127, 127), 1);
    r.writeInt8(clamp(dy, -127, 127), 2);
    r.writeInt8(clamp(wheel, -127, 127), 3);
    return this.build(MOUSE_REL, r, this.mouseSeq++);
  }

  private build(dev: Dev, report: Buffer, seq: number): Buffer {
    let payload = report;
    let status = 0;
    if (this.cipher) {
      const padded = Buffer.alloc(Math.ceil(report.length / 8) * 8);
      report.copy(padded);
      payload = this.cipher.encrypt(padded);
      status = 0xff;
    }
    const bodyLen = 33 + payload.length;
    const pkt = Buffer.alloc(8 + bodyLen);
    encodeHeader(Op.HID_PKT, bodyLen, status).copy(pkt, 0);
    pkt.write('IUSB    ', 8, 'latin1');
    pkt[16] = 1;
    pkt[17] = 0;
    pkt[18] = 32;
    pkt.writeUInt32LE(dev.dataLen, 20);
    pkt[25] = dev.device;
    pkt[26] = dev.proto;
    pkt[27] = 0x80;
    pkt[28] = 2;
    pkt[29] = dev.ifnum;
    pkt.writeUInt32LE(seq >>> 0, 32);
    pkt[40] = dev.reportLen;
    payload.copy(pkt, 41);
    let sum = 0;
    for (let i = 8; i < 40; i++) sum = (sum + pkt[i]) & 0xff;
    pkt[19] = -sum & 0xff;
    return pkt;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  v = Math.round(v);
  return v < lo ? lo : v > hi ? hi : v;
}

/** Converts a pixel position to the BMC's 0..32767 absolute scale. */
export function toAbsolute(px: number, extent: number): number {
  if (extent === 832) extent = 800; // 832-wide modes are scaled as 800 wide
  return Math.trunc((px * 32767) / extent + 0.5);
}

