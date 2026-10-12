// Small decision dialogs used while connecting or during a session.
import { useEffect, useState } from 'react';
import type { ShareRequest } from '../../shared/api';
import { Modal } from './Modal';

export function PasswordDialog({ who, retry, onDone }: { who: string; retry?: boolean; onDone: (password: string | null) => void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title="Password" onClose={() => onDone(null)}
      footer={<>
        <button type="button" className="btn tall" onClick={() => onDone(null)}>Cancel</button>
        <button type="submit" form="pw-form" className="btn primary tall" disabled={!pw}>Connect</button>
      </>}>
      <form id="pw-form" className="field" onSubmit={(e) => { e.preventDefault(); if (pw) onDone(pw); }}>
        <label htmlFor="pw-input">{retry ? `The BMC rejected the password for ${who}. Try again.` : `Password for ${who}`}</label>
        <input id="pw-input" className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
      </form>
    </Modal>
  );
}

export function CertificateDialog({ host, subject, fingerprint, onDone }: { host: string; subject?: string; fingerprint: string; onDone: (trust: boolean) => void }) {
  return (
    <Modal title="Check the BMC certificate" onClose={() => onDone(false)}
      footer={<>
        <button type="button" className="btn tall" autoFocus onClick={() => onDone(false)}>Cancel</button>
        <button type="button" className="btn primary tall" onClick={() => onDone(true)}>Trust for {host}</button>
      </>}>
      <p>{host} presented a certificate that is not trusted. BMCs usually use self-signed certificates. Continue only if this fingerprint matches the one shown in the BMC web UI.</p>
      {subject && <p className="fingerprint">{subject}</p>}
      <p className="fingerprint">SHA-256 {fingerprint}</p>
    </Modal>
  );
}

/** How long the BMC waits for an answer; after that it gives the other user full access. */
export const SHARE_ANSWER_SECONDS = 30;

export function ShareDialog({ request, onDone, onExpire }: { request: ShareRequest; onDone: (decision: 0 | 1 | 2) => void; onExpire: () => void }) {
  const [left, setLeft] = useState(SHARE_ANSWER_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => n - 1), 1000);
    return () => clearInterval(t);
  }, [request]);
  // Unanswered: close without sending an answer; the BMC applies its own timeout rule.
  useEffect(() => {
    if (left <= 0) onExpire();
  }, [left, onExpire]);
  return (
    <Modal title="KVM access request" onClose={() => onDone(1)}
      footer={<>
        <button type="button" className="btn tall left" onClick={() => onDone(1)}>Deny</button>
        <button type="button" className="btn tall" onClick={() => onDone(2)}>Allow view only</button>
        <button type="button" className="btn primary tall" onClick={() => onDone(0)}>Allow full access</button>
      </>}>
      <p>{request.user || 'Another user'} ({request.ip || 'unknown address'}) is asking to use this KVM session.</p>
      <p style={{ color: 'var(--muted)' }}>If you don't answer within {Math.max(0, left)} seconds, they get full access.</p>
    </Modal>
  );
}
