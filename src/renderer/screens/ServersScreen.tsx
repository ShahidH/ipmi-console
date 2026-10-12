// Home: saved servers with live reachability, search, and .jnlp drop-to-connect.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServerInfo } from '../../shared/api';
import { DotsIcon, DownloadIcon, MonitorIcon, PlusIcon, SearchIcon } from '../components/icons';
import { Menu } from '../components/Menu';
import { useNow } from '../hooks/useNow';

interface Props {
  servers: ServerInfo[];
  /** Reachability by server id; missing = not checked yet. */
  reachable: Record<string, boolean>;
  checkedAt?: number;
  onConnect: (s: ServerInfo) => void;
  onAdd: () => void;
  onEdit: (s: ServerInfo) => void;
  onDelete: (s: ServerInfo) => void;
  onOpenJnlp: () => void;
  onJnlpText: (xml: string) => void;
}

type Filter = 'all' | 'reachable' | 'unreachable';

const FAMILY_SHORT: Record<string, string> = { 'megarac-sp': 'MegaRAC SP', 'megarac-spx': 'MegaRAC SP-X' };

export function relativeTime(t: number | undefined, now: number): string {
  if (!t) return 'Never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(t).toLocaleDateString();
}

export function ServersScreen(p: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [dragging, setDragging] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);

  // "/" focuses search, as in most list-heavy tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && !document.querySelector('[aria-modal]')) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...p.servers]
      .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0) || a.name.localeCompare(b.name))
      .filter((s) => !q || `${s.name} ${s.host} ${s.username}`.toLowerCase().includes(q))
      .filter((s) => filter === 'all' || (filter === 'reachable' ? p.reachable[s.id] === true : p.reachable[s.id] === false));
  }, [p.servers, p.reachable, query, filter]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.jnlp$/i.test(f.name)) p.onJnlpText(await f.text());
  };

  return (
    <div className="servers" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand"><span style={{ color: 'var(--accent)', display: 'flex' }}><MonitorIcon size={22} /></span>IPMI Console</div>
        <label className="search">
          <SearchIcon />
          <span className="sr-only">Search servers</span>
          <input ref={search} type="search" placeholder="Search by name, address or user   ( / )" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="grow" />
        <button type="button" className="btn" onClick={p.onOpenJnlp}>Open .jnlp…</button>
        <button type="button" className="btn primary" onClick={p.onAdd}><PlusIcon />Add server</button>
      </header>

      <main>
        {p.servers.length === 0 ? (
          <div className="empty">
            <MonitorIcon size={36} />
            <h2>Add your first server</h2>
            <p>Enter the BMC address. IPMI Console identifies the firmware before asking for credentials.</p>
            <button type="button" className="btn primary tall" onClick={p.onAdd}><PlusIcon />Add server</button>
          </div>
        ) : (
          <>
            <div className="servers-head">
              <h1>Servers</h1>
              <span className="meta">{p.servers.length} saved{p.checkedAt ? ` · checked ${relativeTime(p.checkedAt, now).toLowerCase()}` : ''}</span>
              <div className="grow" />
              <div role="group" aria-label="Filter" className="filters">
                {(['all', 'reachable', 'unreachable'] as const).map((f) => (
                  <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {f === 'all' ? 'All' : f === 'reachable' ? 'Reachable' : 'No response'}
                  </button>
                ))}
              </div>
            </div>
            <div className="cards">
              {shown.map((s) => <ServerCard key={s.id} s={s} isReachable={p.reachable[s.id]} now={now} onConnect={p.onConnect} onEdit={p.onEdit} onDelete={p.onDelete} />)}
              {shown.length === 0 && <p style={{ color: 'var(--muted)' }}>No servers match.</p>}
            </div>
          </>
        )}
        <div className={`dropzone${dragging ? ' active' : ''}`}>
          <DownloadIcon size={18} />
          <span>Drop a <span className="mono">.jnlp</span> file from the BMC web UI anywhere in this window to connect without saving.</span>
        </div>
      </main>
    </div>
  );
}

function ServerCard({ s, isReachable: reachable, now, onConnect, onEdit, onDelete }: { s: ServerInfo; isReachable: boolean | undefined; now: number } & Pick<Props, 'onConnect' | 'onEdit' | 'onDelete'>) {
  const pill = reachable === undefined ? ['unknown', 'Checking…'] : reachable ? ['ok', 'Reachable'] : ['off', 'No response'];
  const family = FAMILY_SHORT[s.lastFamily ?? ''] ?? FAMILY_SHORT[s.family ?? ''] ?? 'Detected on connect';
  return (
    <article className="card" aria-label={s.name}>
      <div className="card-head">
        <div>
          <h2>{s.name}</h2>
          <div className="host">{s.webScheme}://{s.host}{s.webPort ? `:${s.webPort}` : ''}</div>
        </div>
        <span className={`pill ${pill[0]}`}>{pill[1]}</span>
      </div>
      <dl className="facts">
        <dt>Firmware</dt><dd>{family}</dd>
        <dt>User</dt><dd>{s.username}{s.hasPassword ? ' · password saved' : ''}</dd>
        <dt>Last used</dt><dd>{relativeTime(s.lastConnectedAt, now)}</dd>
      </dl>
      <div className="card-actions">
        <button type="button" className={`btn ${reachable === false ? 'solid' : 'primary'}`} onClick={() => onConnect(s)}>Connect</button>
        <Menu label={<DotsIcon size={18} />} ariaLabel={`More actions for ${s.name}`} buttonClass="icon-btn" align="right" width={200}>
          {(close) => <>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { close(); onEdit(s); }}>Edit</button>
            <button type="button" role="menuitem" className="menu-item danger" onClick={() => { close(); onDelete(s); }}>Delete</button>
          </>}
        </Menu>
      </div>
    </article>
  );
}
