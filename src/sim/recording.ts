/**
 * Record-and-replay of the BMC → client IVTP stream. The probe records a real
 * session (`--record`); the simulator replays it and tests feed it through the
 * client stack. Only server→client packets are stored, because client packets
 * carry the session token and web cookie. User records (session list, KVM
 * sharing) are blanked; video and control packets are kept verbatim.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Op, type IvtpPacket } from '../protocol/ivtp';

export interface RecordedPacket {
  /** Milliseconds since the start of the recording. */
  t: number;
  type: number;
  status: number;
  /** Declared size (may differ from body length for BW_DETECT_RESP). */
  size: number;
  body: string; // base64
}

export interface Recording {
  format: 'ojv-ivtp-recording';
  version: 1;
  created: string;
  note?: string;
  packets: RecordedPacket[];
}

/** Packet types whose bodies contain user names / IP addresses. */
const USER_DATA = new Set<number>([Op.SESSION_ACCEPTED, Op.GET_ACTIVE_CLIENTS, Op.KVM_SHARING]);

export class Recorder {
  private readonly t0 = Date.now();
  readonly packets: RecordedPacket[] = [];

  add(p: IvtpPacket) {
    const body = USER_DATA.has(p.type) ? Buffer.alloc(p.body.length) : p.body;
    this.packets.push({ t: Date.now() - this.t0, type: p.type, status: p.status, size: p.size, body: body.toString('base64') });
  }

  save(file: string, note?: string) {
    const rec: Recording = { format: 'ojv-ivtp-recording', version: 1, created: new Date().toISOString(), note, packets: this.packets };
    writeFileSync(file, JSON.stringify(rec));
  }
}

export function loadRecording(file: string): Recording {
  const r = JSON.parse(readFileSync(file, 'utf8')) as Recording;
  if (r.format !== 'ojv-ivtp-recording' || r.version !== 1) throw new Error(`${file} is not an ojv IVTP recording`);
  return r;
}

export function packetBytes(p: RecordedPacket): Buffer {
  const body = Buffer.from(p.body, 'base64');
  const h = Buffer.alloc(8);
  h.writeUInt16LE(p.type, 0);
  h.writeUInt32LE(p.size, 2);
  h.writeUInt16LE(p.status, 6);
  return Buffer.concat([h, body]);
}
