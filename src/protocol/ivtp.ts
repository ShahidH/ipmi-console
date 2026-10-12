/**
 * IVTP — the AMI MegaRAC KVM wire protocol. Every message is an 8-byte
 * little-endian header { u16 type, u32 size, u16 status } followed by `size`
 * body bytes (one exception: BW_DETECT_RESP, see {@link IvtpReader}).
 */

const HEADER_SIZE = 8;

export const Op = {
  HID_PKT: 1,
  SET_BANDWIDTH: 2,
  SET_FPS: 3,
  PAUSE_REDIRECTION: 4,
  REFRESH_VIDEO_SCREEN: 5,
  RESUME_REDIRECTION: 6,
  SET_COMPRESSION_TYPE: 7,
  STOP_SESSION_IMMEDIATE: 8,
  BLANK_SCREEN: 9,
  GET_USB_MOUSE_MODE: 10,
  GET_FULL_SCREEN: 11,
  ENABLE_ENCRYPTION: 12,
  DISABLE_ENCRYPTION: 13,
  ENCRYPTION_STATUS: 14,
  INITIAL_ENCRYPTION_STATUS: 15,
  BW_DETECT_REQ: 16,
  BW_DETECT_RESP: 17,
  VALIDATE_VIDEO_SESSION: 18,
  VALIDATE_VIDEO_SESSION_RESPONSE: 19,
  GET_KEYBD_LED: 20,
  GET_WEB_TOKEN: 21,
  MAX_SESSION_CLOSING: 22,
  SESSION_ACCEPTED: 23,
  MEDIA_STATE: 24,
  VIDEO_FRAGMENT: 25,
  WEB_PREVIEWER_SESSION: 26,
  WEB_PREVIEWER_CAPTURE_STATUS: 27,
  SET_MOUSE_MODE: 28,
  KVM_SHARING: 32,
  KVM_SOCKET_STATUS: 33,
  POWER_STATUS: 34,
  POWER_CONTROL_REQUEST: 35,
  POWER_CONTROL_RESPONSE: 36,
  CONF_SERVICE_STATUS: 37,
  MOUSE_MEDIA_INFO: 38,
  GET_ACTIVE_CLIENTS: 39,
  GET_USER_MACRO: 40,
  SET_USER_MACRO: 41,
  IPMI_REQUEST: 48,
  IPMI_RESPONSE: 49,
  /** SP-X / newer jars (hitsc, asmb8, megarac-kvm-rs). */
  SET_NEXT_MASTER: 50,
  DISPLAY_LOCK_SET: 51,
  DISPLAY_CONTROL_STATUS: 52,
  MEDIA_LICENSE_STATUS: 53,
  KVM_DISCONNECT: 54,
  SET_KBD_LANG: 55,
  MEDIA_FREE_INSTANCE_STATUS: 56,
  /** Newer SP and SP-X firmware only (not in 2017-era firmware). */
  KEEP_ALIVE: 57,
  /** Newer firmware only. */
  CONNECTION_COMPLETE: 58,
  CONNECTION_FAILED: 59,
  /** SP-X video feedback: status = |frames received − presented|, sent every <=100 ms. */
  FPS_DIFF: 60,
  KBD_QUEUE_STATUS: 61,
  /** ASPEED SoC extensions. */
  SOC_HW_CURSOR: 4098,
  SOC_GET_VIDEO_ENGINE_CONFIGS: 4099,
  SOC_SET_VIDEO_ENGINE_CONFIGS: 4100,
} as const;

export const OP_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Op).map(([k, v]) => [v, k]));

export interface IvtpPacket {
  type: number;
  size: number;
  status: number;
  body: Buffer;
}

export function encodeHeader(type: number, size: number, status = 0): Buffer {
  const b = Buffer.alloc(HEADER_SIZE);
  b.writeUInt16LE(type & 0xffff, 0);
  b.writeUInt32LE(size >>> 0, 2);
  b.writeUInt16LE(status & 0xffff, 6);
  return b;
}

export function encodePacket(type: number, body: Buffer = Buffer.alloc(0), status = 0): Buffer {
  return Buffer.concat([encodeHeader(type, body.length, status), body]);
}

/** Upper bound for any single packet body we are prepared to buffer. */
const MAX_BODY = 16 * 1024 * 1024;

/**
 * Incremental IVTP parser. Feed it socket chunks; it yields complete packets.
 */
export class IvtpReader {
  private chunks: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer): IvtpPacket[] {
    this.chunks.push(chunk);
    this.length += chunk.length;
    const out: IvtpPacket[] = [];
    for (;;) {
      if (this.length < HEADER_SIZE) break;
      const head = this.peek(HEADER_SIZE);
      const type = head.readUInt16LE(0);
      const size = head.readUInt32LE(2);
      const status = head.readUInt16LE(6);
      // A BW_DETECT_RESP carries `status` repetitions of its `size`-byte body.
      const bodyLen = type === Op.BW_DETECT_RESP ? size * Math.max(1, status) : size;
      if (bodyLen > MAX_BODY) throw new Error(`IVTP packet type ${type} declares ${bodyLen} bytes; refusing`);
      if (this.length < HEADER_SIZE + bodyLen) break;
      this.take(HEADER_SIZE);
      out.push({ type, size, status, body: this.take(bodyLen) });
    }
    return out;
  }

  /** Bytes buffered but not yet returned as packets. */
  get pending(): number {
    return this.length;
  }

  private peek(n: number): Buffer {
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    return Buffer.concat(this.chunks).subarray(0, n);
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks)];
    const first = this.chunks[0];
    const out = first.subarray(0, n);
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.length -= n;
    return out;
  }
}

/** Largest reassembled video frame accepted. */
const MAX_FRAME_BYTES = 9_216_000;

/**
 * Reassembles VIDEO_FRAGMENT bodies: { u16 LE fragNum, data }. fragNum & 0x7fff
 * is the fragment index (0 starts a frame), bit 15 marks the last fragment.
 */
export class FrameAssembler {
  private parts: Buffer[] = [];
  private size = 0;
  private expectNext = 0;
  /** Count of fragments dropped because they arrived out of sequence. */
  dropped = 0;

  push(body: Buffer): Buffer | null {
    if (body.length < 2) return null;
    const frag = body.readUInt16LE(0);
    const index = frag & 0x7fff;
    const data = body.subarray(2);
    if (index === 0) {
      this.parts = [];
      this.size = 0;
    } else if (index !== this.expectNext) {
      // Out of sequence: drop the partial frame rather than show a torn one.
      this.dropped++;
      this.parts = [];
      this.size = 0;
      this.expectNext = 0;
      return null;
    }
    this.size += data.length;
    if (this.size > MAX_FRAME_BYTES) {
      this.parts = [];
      this.size = 0;
      throw new Error(`video frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    // Socket chunks are not reused by Node, so keeping a view is safe; the single
    // copy happens when the frame is completed.
    this.parts.push(data);
    this.expectNext = index + 1;
    if (frag & 0x8000) {
      // Own, exact-size allocation: never Node's shared Buffer pool, because the
      // frame's ArrayBuffer is handed to the renderer process as a whole.
      const frame = Buffer.allocUnsafeSlow(this.size);
      let o = 0;
      for (const part of this.parts) {
        part.copy(frame, o);
        o += part.length;
      }
      this.parts = [];
      this.size = 0;
      this.expectNext = 0;
      return frame;
    }
    return null;
  }
}

/** Writes `s` into `dst[off..off+len)` as zero-padded ASCII (truncating if needed). */
export function putFixedAscii(dst: Buffer, off: number, len: number, s: string): void {
  dst.fill(0, off, off + len);
  dst.write(s.slice(0, len), off, 'latin1');
}
