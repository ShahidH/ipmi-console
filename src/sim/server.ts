/**
 * Simulated BMC: web layer (legacy MegaRAC SP or SP-X) + KVM transports
 * (single-port tunnel on the web port, direct KVM port, or WebSocket /kvm).
 * The IVTP session itself is SimKvmSession.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IvtpPacket } from '../protocol/ivtp';
import { fakeJViewerJar, fakeSocJar } from './fakejar';
import { SIM_FIRMWARE, type SimFirmware } from './firmware';
import { SimKvmSession, type SimEvent, type SimStream } from './ivtp-server';
import { loadRecording } from './recording';
import type { Scenario } from './scenario';
import { demoScreen } from './demo-screen';
import { CaptureSource, TextScreen, type VideoSource } from './video';

export interface SimOptions {
  host?: string;
  /** Web port (0 = random). The single-port tunnel shares it. */
  webPort?: number;
  /** Direct KVM port for transport 'direct' (0 = random). */
  kvmPort?: number;
  user?: string;
  password?: string;
}

const token = (n: number) => randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n).padEnd(n, 'x');

export class SimBmc extends EventEmitter<{ event: [SimEvent] }> {
  readonly firmware: SimFirmware;
  webPort = 0;
  kvmPort = 0;
  /** Observability for tests. */
  readonly received: IvtpPacket[] = [];
  readonly tunnelRequests: string[] = [];
  readonly events: SimEvent[] = [];
  logins = 0;
  logouts = 0;
  validations = 0;
  sessions: SimKvmSession[] = [];

  private readonly user: string;
  private readonly password: string;
  private webSessions = new Set<string>();
  private kvmToken?: string;
  private kvmCookie?: string;
  private spxCsrf?: string;
  private web: http.Server;
  private front: net.Server;
  private direct?: net.Server;
  private wss?: WebSocketServer;
  private sockets = new Set<net.Socket>();
  private readonly jar?: Buffer;
  private readonly socJar = fakeSocJar();
  private video?: VideoSource;
  private text?: TextScreen;

  constructor(readonly scenario: Scenario, private readonly o: SimOptions = {}) {
    super();
    const fw = SIM_FIRMWARE[scenario.firmware];
    if (!fw) throw new Error(`unknown simulated firmware ${scenario.firmware}`);
    this.firmware = fw;
    this.user = o.user ?? 'admin';
    this.password = o.password ?? 'admin';
    if (fw.jar) this.jar = fakeJViewerJar(fw.jar);
    this.web = http.createServer((req, res) => this.handleWeb(req, res));
    this.front = net.createServer((s) => this.frontConnection(s));
    if (fw.family === 'megarac-spx') {
      this.wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: scenario.wsMode?.deflate ? { threshold: 0, serverNoContextTakeover: true, clientNoContextTakeover: true } : false,
        handleProtocols: (protocols) => (scenario.wsMode?.base64 ? (protocols.has('base64') ? 'base64' : false) : protocols.has('binary') ? 'binary' : false),
      });
      this.web.on('upgrade', (req, sock, head) => this.upgrade(req, sock as net.Socket, head));
    }
  }

  emitEvent(e: SimEvent) {
    this.events.push(e);
    this.emit('event', e);
  }

  async listen(): Promise<void> {
    const host = this.o.host ?? '127.0.0.1';
    await new Promise<void>((r) => this.front.listen(this.o.webPort ?? 0, host, r));
    this.webPort = (this.front.address() as net.AddressInfo).port;
    if (this.firmware.family === 'megarac-sp' && this.scenario.transport === 'direct') {
      this.direct = net.createServer((s) => {
        this.sockets.add(s);
        this.startKvm(s, 'direct port');
      });
      await new Promise<void>((r) => this.direct!.listen(this.o.kvmPort ?? 0, host, r));
      this.kvmPort = (this.direct.address() as net.AddressInfo).port;
    }
  }

  async close(): Promise<void> {
    for (const s of this.sessions) s.close('simulator shutting down');
    for (const s of this.sockets) s.destroy();
    this.wss?.close();
    await Promise.all([this.front, this.direct].filter(Boolean).map((srv) => new Promise((r) => srv!.close(r))));
  }

  private videoSource(): VideoSource {
    if (this.video) return this.video;
    const v = this.scenario.video ?? 'text';
    if (v === 'demo') {
      // Static screen; the session's own test UI (this.text) stays off.
      this.video = demoScreen();
    } else if (v === 'text' || 'replay' in v) {
      this.text = new TextScreen();
      this.video = this.text;
    } else {
      this.video = new CaptureSource(v.captures);
    }
    return this.video;
  }

  private startKvm(stream: SimStream, how: string) {
    this.emitEvent({ t: Date.now(), kind: 'session', msg: `KVM transport: ${how}` });
    const v = this.scenario.video;
    const s = new SimKvmSession(stream, {
      firmware: this.firmware,
      scenario: this.scenario,
      token: () => this.kvmToken,
      webCookie: () => this.kvmCookie,
      username: this.user,
      video: this.videoSource(),
      text: this.text,
      recording: v && typeof v === 'object' && 'replay' in v ? loadRecording(v.replay) : undefined,
      emit: (e) => {
        if (e.kind === 'session' && e.msg === 'session validated') this.validations++;
        this.emitEvent(e);
      },
      onPacket: (p) => this.received.push(p),
    });
    this.sessions.push(s);
    s.start();
  }

  // --- legacy single-port tunnel / HTTP sharing one port ------------------------

  private frontConnection(s: net.Socket) {
    this.sockets.add(s);
    s.on('error', () => {});
    s.once('data', (first) => {
      if (first.toString('latin1').startsWith('CONNECT') && this.firmware.family === 'megarac-sp') return this.tunnel(s, first);
      s.pause();
      s.unshift(first);
      this.web.emit('connection', s);
      s.resume();
    });
  }

  private tunnel(s: net.Socket, first: Buffer) {
    let text = first.toString('latin1');
    const done = () => {
      this.tunnelRequests.push(text);
      const fault = this.scenario.faults?.find((f) => f.do === 'tunnel-error') as { code: number } | undefined;
      const ok = !!this.kvmCookie && text.includes(`JVIEWER VIDEO cookie ${this.kvmCookie}`) && this.scenario.transport !== 'direct';
      if (fault || !ok) {
        s.end(`HTTP/1.0 200 OK\r\nERROR:${fault?.code ?? 4}\r\n\r\n`);
        this.emitEvent({ t: Date.now(), kind: 'fault', msg: `single-port tunnel refused (ERROR:${fault?.code ?? 4})` });
        return;
      }
      // As observed on hardware: a short reply, then the IVTP stream starts.
      s.write('HTTP/1.0 200 OK\r\n');
      this.startKvm(s, 'single-port tunnel');
    };
    if (text.includes('JVIEWER')) return done();
    s.once('data', (d) => { text += d.toString('latin1'); done(); });
  }

  // --- web layer ------------------------------------------------------------------

  private handleWeb(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => (this.firmware.family === 'megarac-spx' ? this.spxWeb(req, res, body) : this.legacyWeb(req, res, body)));
  }

  private legacyWeb(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    res.setHeader('Server', 'GoAhead-Webs');
    const url = req.url ?? '/';
    const cookie = /SessionCookie=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    const authed = !!cookie && this.webSessions.has(cookie);
    const send = (status: number, text: string, type = 'text/html') => { res.statusCode = status; res.setHeader('Content-Type', type); res.end(text); };
    if (url === '/') return send(302, '', 'text/html'), undefined;
    if (url === '/page/login.html') return send(200, '<html><script src="../lib/ns_inc.js"></script><form name="login"></form></html>');
    if (url === '/rpc/WEBSES/validate.asp') return send(200, 'WEBVAR_JSONVAR_WEB_SESSION_VALIDATE = { WEBVAR_STRUCTNAME_WEB_SESSION_VALIDATE : [ {} ], HAPI_STATUS:0 };');
    if (url === '/rpc/WEBSES/create.asp' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      const ok = f.get('WEBVAR_USERNAME') === this.user && f.get('WEBVAR_PASSWORD') === this.password;
      const full = this.webSessions.size >= (this.scenario.web?.maxSessions ?? 4);
      if (!ok || full) {
        this.emitEvent({ t: Date.now(), kind: 'session', msg: `web login refused (${ok ? 'session pool full' : 'bad credentials'})` });
        return send(200, "WEBVAR_JSONVAR_WEB_SESSION = { WEBVAR_STRUCTNAME_WEB_SESSION : [ { 'SESSION_COOKIE' : 'Failure_Login_IPMI_Then_LDAP' }, {} ], HAPI_STATUS:0 };");
      }
      this.logins++;
      const c = token(35);
      this.webSessions.add(c);
      this.emitEvent({ t: Date.now(), kind: 'session', msg: `web login as ${this.user}` });
      return send(200, `WEBVAR_JSONVAR_WEB_SESSION = { WEBVAR_STRUCTNAME_WEB_SESSION : [ { 'SESSION_COOKIE' : '${c}', 'BMC_IP_ADDR' : '${this.o.host ?? '127.0.0.1'}' }, {} ], HAPI_STATUS:0 };`);
    }
    if (url === '/rpc/WEBSES/logout.asp') {
      if (cookie && this.webSessions.delete(cookie)) {
        this.logouts++;
        this.emitEvent({ t: Date.now(), kind: 'session', msg: 'web logout' });
      }
      return send(200, 'ok');
    }
    if (url.startsWith('/Java/release/') && this.jar) {
      const data = url.endsWith('/JViewer.jar') ? this.jar : url.endsWith('/JViewer-SOC.jar') ? this.socJar : undefined;
      if (!data) return send(404, '');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/java');
      res.setHeader('Content-Length', data.length);
      return req.method === 'HEAD' ? res.end() : res.end(data);
    }
    if (url.startsWith('/Java/jviewer.jnlp')) {
      if (!authed || this.scenario.web?.jnlpExpired) return send(200, '<html><script>parent.location="/index.html?session_expired"</script></html>');
      this.kvmToken = token(16);
      this.kvmCookie = cookie;
      const single = this.scenario.transport !== 'direct';
      const fw = this.firmware;
      const args: string[] = ['-apptype', 'JViewer', '-hostname', this.o.host ?? '127.0.0.1', '-kvmtoken', this.kvmToken, '-kvmsecure', '0',
        '-kvmport', String(single ? this.webPort : this.kvmPort), '-vmsecure', '0', '-cdstate', '1', '-fdstate', '1', '-hdstate', '1',
        '-cdnum', '1', '-fdnum', '1', '-hdnum', '1', '-userpriv', '4', '-lang', 'EN', '-websecureport', '443',
        '-singleportenabled', single ? '1' : '0', '-webcookie', cookie!];
      if (fw.oemFeatures !== undefined) args.push('-oemfeatures', String(fw.oemFeatures));
      res.setHeader('Content-Type', 'application/x-java-jnlp-file');
      return send(200, `<?xml version="1.0" encoding="UTF-8"?>\n<jnlp spec="1.0+" codebase="http://${this.o.host ?? '127.0.0.1'}:${this.webPort}/Java">\n` +
        '<resources><j2se version="1.5+"/><jar href="release/JViewer.jar"/></resources>\n<resources><j2se version="1.5+"/><jar href="release/JViewer-SOC.jar"/></resources>\n' +
        `<application-desc>\n${args.map((a) => `<argument>${a}</argument>`).join('\n')}\n</application-desc>\n</jnlp>\n`, 'application/x-java-jnlp-file');
    }
    send(404, 'not found');
  }

  private spxWeb(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    res.setHeader('Server', 'lighttpd');
    const url = req.url ?? '/';
    const json = (status: number, v: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
    const qs = /QSESSIONID=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    const authed = !!qs && this.webSessions.has(qs) && req.headers['x-csrftoken'] === this.spxCsrf;
    if (url === '/') { res.setHeader('Referrer-Policy', 'no-referrer'); return void res.end('<html><head><script src="app.js"></script></head></html>'); }
    if (url === '/api/session' && req.method === 'GET') return json(401, { error: 'unauthorised' });
    if (url === '/api/session' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      if (f.get('username') !== this.user || f.get('password') !== this.password) return json(401, { error: 'invalid credentials' });
      if (this.webSessions.size >= (this.scenario.web?.maxSessions ?? 4)) return json(503, { error: 'session pool full' });
      this.logins++;
      const id = token(24);
      this.spxCsrf = token(12);
      this.webSessions.add(id);
      res.setHeader('Set-Cookie', [`QSESSIONID=${id}; path=/; HttpOnly`]);
      this.emitEvent({ t: Date.now(), kind: 'session', msg: `web login as ${this.user}` });
      return json(200, { ok: 0, privilege: 4, extendedpriv: 259, CSRFToken: this.spxCsrf });
    }
    if (url === '/api/session' && req.method === 'DELETE') {
      if (qs && this.webSessions.delete(qs)) this.logouts++;
      return json(200, {});
    }
    if (!authed) return json(401, { error: 'no session' });
    if (url === '/api/settings/media/h5viewercfg') {
      this.kvmToken = token(16);
      this.kvmCookie = qs;
      return json(200, { token: this.kvmToken, session: token(20), client_ip: '127.0.0.1', ...(this.firmware.validateSize >= 438 ? { server_ip: this.o.host ?? '127.0.0.1' } : {}) });
    }
    if (url === '/api/configuration/project') return json(200, [{ feature: 'KVM' }, ...(this.firmware.oemFeatures ? [{ feature: 'KVM_SESSION_RECONNECT' }] : [])]);
    json(404, {});
  }

  private upgrade(req: http.IncomingMessage, sock: net.Socket, head: Buffer) {
    const qs = /QSESSIONID=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    if (req.url !== '/kvm' || !qs || !this.webSessions.has(qs)) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    this.wss!.handleUpgrade(req, sock, head, (ws: WebSocket) => {
      const base64 = ws.protocol === 'base64';
      const listeners: Array<(d: Buffer) => void> = [];
      ws.on('message', (data, isBinary) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        const bytes = isBinary ? buf : Buffer.from(buf.toString('latin1'), 'base64');
        for (const l of listeners) l(bytes);
      });
      const stream = {
        write: (b: Buffer) => (base64 ? ws.send(b.toString('base64')) : ws.send(b, { binary: true })),
        destroy: () => ws.terminate(),
        on: (ev: string, fn: (d: Buffer) => void) => (ev === 'data' ? listeners.push(fn) : ws.on('close', fn as () => void)),
      } as unknown as SimStream;
      this.startKvm(stream, `WebSocket (${ws.protocol}${ws.extensions ? `, ${ws.extensions}` : ''})`);
    });
  }
}
