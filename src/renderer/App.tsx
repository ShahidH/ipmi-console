/**
 * Top level: which screen is shown, the connect flow (password and certificate
 * prompts), and dialogs raised by the session (sharing requests).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectResult, ServerInfo, ServerInput, ShareRequest } from '../shared/api';
import { api } from './api';
import { CertificateDialog, PasswordDialog, ShareDialog } from './components/Dialogs';
import { Modal } from './components/Modal';
import { ServerDialog } from './components/ServerDialog';
import { ToastProvider, useToast } from './components/Toasts';
import { useKvmSession, type Target } from './hooks/useKvmSession';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { ServersScreen } from './screens/ServersScreen';

/** How often saved servers are checked for reachability. */
const REACHABILITY_MS = 30_000;

type Prompt =
  | { kind: 'password'; who: string; retry: boolean; resolve: (pw: string | null) => void }
  | { kind: 'certificate'; host: string; subject?: string; fingerprint: string; resolve: (trust: boolean) => void };

export function App() {
  return <ToastProvider><Shell /></ToastProvider>;
}

function Shell() {
  const toast = useToast();
  const [session, dispatch] = useKvmSession();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [reachable, setReachable] = useState<Record<string, boolean>>({});
  const [checkedAt, setCheckedAt] = useState<number>();
  const [editing, setEditing] = useState<ServerInfo | 'new' | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [share, setShare] = useState<ShareRequest | null>(null);
  const lastTarget = useRef<{ server?: ServerInfo; jnlp?: string } | null>(null);
  /** Counts connect attempts and disconnects: a result for an older attempt is ignored. */
  const attempt = useRef(0);
  const inSession = session.phase !== 'idle';

  const refresh = useCallback(async () => setServers(await api().listServers()), []);

  const [notices, setNotices] = useState<string[]>([]);

  useEffect(() => {
    void api().listServers().then(setServers);
    void api().notices().then(setNotices);
    const offs = [
      api().on('kvm:shareRequest', setShare),
      // A request is only answerable while its session lasts.
      api().on('kvm:ended', () => setShare(null)),
      api().on('kvm:notice', (n) => toast({ title: n.title, detail: n.detail, level: n.level })),
      api().on('app:error', (message) => toast({ title: 'Unexpected error.', detail: `${message} Details are in the log.`, level: 'err' })),
    ];
    return () => offs.forEach((off) => off());
  }, [toast]);

  // Reachability: only while the servers screen is visible.
  useEffect(() => {
    if (inSession || servers.length === 0) return;
    let alive = true;
    const check = async () => {
      const r = await api().reachability(servers.map((s) => s.id)).catch(() => null);
      if (alive && r) { setReachable(r); setCheckedAt(Date.now()); }
    };
    void check();
    const t = setInterval(check, REACHABILITY_MS);
    return () => { alive = false; clearInterval(t); };
  }, [inSession, servers]);

  const askPassword = (who: string, retry: boolean) =>
    new Promise<string | null>((resolve) => setPrompt({ kind: 'password', who, retry, resolve }));
  const askTrust = (host: string, fingerprint: string, subject?: string) =>
    new Promise<boolean>((resolve) => setPrompt({ kind: 'certificate', host, fingerprint, subject, resolve }));

  const handleFailure = (r: ConnectResult) => {
    dispatch({ type: 'failed' });
    toast({ title: 'Could not connect.', detail: r.error ?? 'Unknown error.', level: 'err' });
  };

  const connect = async (s: ServerInfo, password?: string, retry = false): Promise<void> => {
    if (!password && (!s.hasPassword || retry)) {
      const pw = await askPassword(`${s.username}@${s.host}`, retry);
      setPrompt(null);
      if (pw === null) return void (retry && dispatch({ type: 'failed' }));
      password = pw;
    }
    lastTarget.current = { server: s };
    const target: Target = { name: s.name, host: s.host, serverId: s.id };
    const mine = ++attempt.current;
    dispatch({ type: 'start', target });
    const r = await api().connect(s.id, password);
    // Cancelled, or replaced by a newer connect: the screen already moved on.
    if (r.cancelled || mine !== attempt.current) return;
    if (r.ok) return void refresh();
    if (r.kind === 'password' || r.kind === 'auth') return connect({ ...s, hasPassword: false }, undefined, true);
    if (r.kind === 'certificate' && r.fingerprint) {
      const trust = await askTrust(s.host, r.fingerprint, r.subject);
      setPrompt(null);
      if (trust) {
        await api().trustCertificate(s.host, r.fingerprint);
        return connect(s, password);
      }
      return void dispatch({ type: 'failed' });
    }
    handleFailure(r);
  };

  const connectJnlp = async (xml?: string) => {
    lastTarget.current = { jnlp: xml };
    const mine = ++attempt.current;
    dispatch({ type: 'start', target: { name: 'Launch file', host: '.jnlp' } });
    const r = xml === undefined ? await api().openJnlp() : await api().openJnlpText(xml);
    if (r.ok || mine !== attempt.current) return;
    if (r.cancelled) return void dispatch({ type: 'failed' });
    handleFailure(r);
  };

  const closeShare = useCallback(() => setShare(null), []);

  const disconnect = async () => {
    attempt.current++;
    setShare(null);
    dispatch({ type: 'close' });
    await api().disconnect();
    void refresh();
  };

  const reconnect = () => {
    const t = lastTarget.current;
    if (t?.server) void connect(servers.find((s) => s.id === t.server!.id) ?? t.server);
    else if (t?.jnlp) void connectJnlp(t.jnlp);
    else void disconnect();
  };

  const save = async (input: ServerInput, andConnect: boolean) => {
    const id = await api().saveServer(input);
    const list = await api().listServers();
    setServers(list);
    setEditing(null);
    const saved = list.find((s) => s.id === id);
    if (andConnect && saved) void connect(saved, input.password);
    else toast({ title: `Saved ${saved?.name ?? input.host}.` });
  };

  const remove = async (s: ServerInfo) => {
    await api().deleteServer(s.id);
    setEditing(null);
    await refresh();
    toast({ title: `Deleted ${s.name}.` });
  };

  return (
    <>
      {inSession ? (
        <ConsoleScreen session={session} onDisconnect={() => void disconnect()} onRetryNow={() => void api().retryNow()} onReconnect={reconnect} />
      ) : (
        <ServersScreen servers={servers} reachable={reachable} checkedAt={checkedAt}
          onConnect={(s) => void connect(s)} onAdd={() => setEditing('new')} onEdit={setEditing} onDelete={(s) => void remove(s)}
          onOpenJnlp={() => void connectJnlp()} onJnlpText={(xml) => void connectJnlp(xml)} />
      )}

      {editing && (
        <ServerDialog server={editing === 'new' ? undefined : editing} onSave={save} onClose={() => setEditing(null)}
          onDelete={editing === 'new' ? undefined : () => void remove(editing)} />
      )}
      {prompt?.kind === 'password' && <PasswordDialog who={prompt.who} retry={prompt.retry} onDone={prompt.resolve} />}
      {prompt?.kind === 'certificate' && <CertificateDialog host={prompt.host} subject={prompt.subject} fingerprint={prompt.fingerprint} onDone={prompt.resolve} />}
      {notices.length > 0 && !prompt && (
        <Modal title="Please note" onClose={() => setNotices([])}
          footer={<button type="button" className="btn primary tall" onClick={() => setNotices([])}>OK</button>}>
          {notices.map((n) => <p key={n}>{n}</p>)}
        </Modal>
      )}
      {share && <ShareDialog key={`${share.user}|${share.ip}`} request={share} onDone={(d) => { setShare(null); void api().answerShare(d); }} onExpire={closeShare} />}
    </>
  );
}
