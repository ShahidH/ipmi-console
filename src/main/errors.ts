/** Turns protocol and network errors into messages and kinds the UI can act on. */
import type { ConnectResult } from '../shared/api';
import { ConnectCancelled } from '../protocol/client';
import { CertificateTrustError } from '../protocol/tls';
import { BmcHttpError } from '../protocol/webauth';

export function friendlyError(e: unknown): ConnectResult {
  if (e instanceof ConnectCancelled) return { cancelled: true };
  if (e instanceof CertificateTrustError) return { error: e.message, kind: 'certificate', fingerprint: e.fingerprint, subject: e.subject };
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof CertificateTrustError) return friendlyError(cause);
  if (e instanceof BmcHttpError) return { error: e.message, kind: e.kind };
  const msg = (e as Error)?.message ?? String(e);
  if (/did not complete the KVM handshake/.test(msg)) {
    // Login worked but the BMC never accepted the video session: almost always every KVM slot is taken.
    return {
      error: 'The BMC accepted the login but not the KVM session. Another KVM session is probably still open on it, for example from a viewer that was closed without disconnecting. End it in the BMC web interface, or wait a few minutes for the BMC to time it out.',
      kind: 'busy',
    };
  }
  if (/ECONNREFUSED/.test(msg)) return { error: 'Connection refused: is the address right and the BMC web/KVM service enabled?', kind: 'network' };
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed out/.test(msg)) return { error: `Cannot reach the BMC (${msg}).`, kind: 'network' };
  if (/certificate|self.signed|unable to verify/i.test(msg)) return { error: `TLS certificate problem: ${msg}`, kind: 'certificate' };
  return { error: msg };
}
