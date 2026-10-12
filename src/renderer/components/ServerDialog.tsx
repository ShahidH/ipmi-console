/**
 * Add / edit a server. The address comes first: the BMC is identified with
 * unauthenticated, read-only requests before any credentials are entered.
 */
import { useEffect, useState } from 'react';
import { layoutForLocale, TYPING_LAYOUT_LABELS, type DetectResult, type ServerInfo, type ServerInput, type TypingLayoutChoice } from '../../shared/api';
import { api } from '../api';
import { AlertIcon, CheckIcon } from './icons';
import { Modal } from './Modal';

interface Props {
  server?: ServerInfo;
  onSave: (input: ServerInput, connect: boolean) => Promise<void>;
  onDelete?: () => void;
  onClose: () => void;
}

type Detect = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: DetectResult } | { state: 'error'; message: string };
/** A finished check, tagged with the address it was for. */
type Checked = { key: string; detect: Detect };

/** Accepts "10.0.0.5", "bmc.lan:8443" or a pasted "https://10.0.0.5/". */
export function parseAddress(raw: string): { host: string; scheme?: 'http' | 'https'; port?: number } {
  let s = raw.trim();
  let scheme: 'http' | 'https' | undefined;
  const m = /^(https?):\/\//i.exec(s);
  if (m) {
    scheme = m[1].toLowerCase() as 'http' | 'https';
    s = s.slice(m[0].length);
  }
  s = s.replace(/[/?#].*$/, '');
  const pm = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(s);
  if (pm) return { host: pm[1].replace(/^\[|\]$/g, ''), scheme, port: Number(pm[2]) };
  return { host: s, scheme };
}

/** New servers default to the layout of this computer's language. */
function defaultTypingLayout(): TypingLayoutChoice {
  return layoutForLocale(navigator.language);
}

export function ServerDialog({ server, onSave, onDelete, onClose }: Props) {
  const [address, setAddress] = useState(server ? server.host : '');
  const [scheme, setScheme] = useState<'http' | 'https'>(server?.webScheme ?? 'http');
  const [port, setPort] = useState(server?.webPort ? String(server.webPort) : '');
  const [username, setUsername] = useState(server?.username ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(server?.hasPassword ?? false);
  const [name, setName] = useState(server?.name && server.name !== server.host ? server.name : '');
  const [family, setFamily] = useState(server?.family ?? 'auto');
  const [keyboardMode, setKeyboardMode] = useState(server?.keyboardMode ?? 'auto');
  // Handshake profile: always detected from the BMC's own client files; kept as saved.
  const profile = server?.profile ?? 'auto';
  const [typingLayout, setTypingLayout] = useState<TypingLayoutChoice>(server?.typingLayout ?? defaultTypingLayout());
  const [legacyTls, setLegacyTls] = useState(server?.legacyTls ?? false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = parseAddress(address);
  const effScheme = parsed.scheme ?? scheme;
  const effPort = parsed.port ?? (port ? Number(port) : undefined);

  // Identify the BMC shortly after the address stops changing. A result only
  // counts for the address it was made for; anything else shows as checking.
  const host = parsed.host;
  const checkable = !!host && /^[\w.:\-[\]]+$/.test(host);
  const key = `${effScheme}://${host}:${effPort ?? ''}`;
  const detect: Detect = !checkable ? { state: 'idle' } : checked?.key === key ? checked.detect : { state: 'checking' };
  useEffect(() => {
    if (!checkable) return;
    let current = true;
    const t = setTimeout(async () => {
      let d: Detect;
      try {
        d = { state: 'done', result: await api().detect(host, effScheme, effPort) };
      } catch (e) {
        d = { state: 'error', message: (e as Error).message };
      }
      if (current) setChecked({ key, detect: d });
    }, 600);
    return () => { current = false; clearTimeout(t); };
  }, [checkable, host, effScheme, effPort, key]);

  const submit = async (connect: boolean) => {
    setError('');
    if (!parsed.host) return setError('Enter the BMC address.');
    if (!username) return setError('Enter the username.');
    setBusy(true);
    try {
      await onSave({
        id: server?.id, name: name.trim(), host: parsed.host, webScheme: effScheme, webPort: effPort, username,
        password: password || undefined, savePassword: remember, profile, family, keyboardMode, typingLayout, legacyTls,
      }, connect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={server ? `Edit ${server.name}` : 'Add server'} onClose={onClose} wide
      footer={<>
        {onDelete && <button type="button" className="btn tall danger-outline left" onClick={onDelete}>Delete</button>}
        <button type="button" className="btn tall" disabled={busy} onClick={() => submit(false)}>{server ? 'Save' : 'Save only'}</button>
        <button type="button" className="btn primary tall" disabled={busy} onClick={() => submit(true)}>Save and connect</button>
      </>}>
      <form className="field" onSubmit={(e) => { e.preventDefault(); void submit(true); }}>
        <label htmlFor="srv-host">BMC address</label>
        <input id="srv-host" className="input mono" autoFocus value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.50" spellCheck={false} />
        <span className="hint">IP or hostname. Paste a full URL and the scheme and port are taken from it.</span>
      </form>

      <DetectCard detect={detect} />

      <div className="grid-2">
        <div className="field">
          <label htmlFor="srv-user">Username</label>
          <input id="srv-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="srv-pass">Password</label>
          <input id="srv-pass" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={server?.hasPassword ? 'Saved (leave blank to keep)' : 'Asked on connect if empty'} />
        </div>
      </div>

      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember password<small>Saved in Windows Credential Manager, the macOS Keychain or your Linux keyring.</small></span>
      </label>

      <div className="field">
        <label htmlFor="srv-name">Name <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
        <input id="srv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={parsed.host || 'nas-01'} />
      </div>

      <details className="advanced">
        <summary>Advanced: web port, firmware family, keyboard compatibility, legacy TLS</summary>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="srv-scheme">Web scheme</label>
            <select id="srv-scheme" className="select" value={effScheme} disabled={!!parsed.scheme} onChange={(e) => setScheme(e.target.value as 'http' | 'https')}>
              <option value="http">http</option><option value="https">https</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="srv-port">Web port</label>
            <input id="srv-port" className="input" type="number" min={1} max={65535} placeholder="auto" disabled={parsed.port !== undefined}
              value={parsed.port ?? port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="srv-family">BMC family</label>
          <select id="srv-family" className="select" value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="auto">Automatic (detect)</option>
            <option value="megarac-sp">AMI MegaRAC SP (Java JViewer era)</option>
            <option value="megarac-spx">AMI MegaRAC SP-X (HTML5 viewer)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="srv-kbd">Keyboard compatibility</label>
          <select id="srv-kbd" className="select" value={keyboardMode} onChange={(e) => setKeyboardMode(e.target.value)}>
            <option value="auto">Automatic (recommended)</option>
            <option value="autobreak">Key presses, as JViewer sends them</option>
            <option value="state">Standard USB keyboard</option>
            {keyboardMode === 'single' && <option value="single">Single key (older setting)</option>}
          </select>
          <span className="hint">Change only if keys repeat or don't register on this server. Applies from the next connection.</span>
        </div>
        <div className="field">
          <label htmlFor="srv-layout">Server keyboard layout (for Type clipboard)</label>
          <select id="srv-layout" className="select" value={typingLayout} onChange={(e) => setTypingLayout(e.target.value as TypingLayoutChoice)}>
            {(Object.keys(TYPING_LAYOUT_LABELS) as TypingLayoutChoice[]).map((id) => <option key={id} value={id}>{TYPING_LAYOUT_LABELS[id]}</option>)}
          </select>
          <span className="hint">Match the keyboard layout set in the server's operating system (BIOS setup screens always use US). Typing on your keyboard works with any layout.</span>
        </div>
        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={legacyTls} onChange={(e) => setLegacyTls(e.target.checked)} />
          <span>Allow legacy TLS 1.0/1.1 for this host</span>
        </label>
      </details>

      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
    </Modal>
  );
}

function DetectCard({ detect }: { detect: Detect }) {
  if (detect.state === 'idle') return null;
  if (detect.state === 'checking') {
    return <div className="detect" role="status"><div className="title"><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />Checking the address…</div></div>;
  }
  if (detect.state === 'error') {
    return <div className="detect err" role="status"><div className="title"><AlertIcon />Could not check this address</div><span>{detect.message}</span></div>;
  }
  const r = detect.result;
  if (!r.reachable) {
    return (
      <div className="detect err" role="status">
        <div className="title"><AlertIcon />No answer from {r.scheme}://</div>
        <span>Check the address, or set the web scheme and port under Advanced. Over https, a certificate that is not trusted yet also stops this check; you can still save and trust it when you connect.</span>
      </div>
    );
  }
  if (!r.supported) {
    return (
      <div className="detect warn" role="status">
        <div className="title"><AlertIcon />{r.family === 'unknown' ? 'A web server answered, but it does not look like an AMI MegaRAC BMC' : `This looks like ${r.familyName}`}</div>
        <span>IPMI Console supports AMI MegaRAC SP and SP-X. You can still save it and choose the family under Advanced.</span>
      </div>
    );
  }
  return (
    <div className="detect ok" role="status">
      <div className="title"><CheckIcon size={18} />Found {r.familyName}</div>
      <span>Identified without logging in, over {r.scheme}.</span>
    </div>
  );
}
