/**
 * Unauthenticated, read-only identification of the BMC web stack, so the right
 * adapter is used without trying credentials against the wrong API (some BMCs
 * lock accounts after failed logins). Only GET requests to public pages.
 */
import { request, type WebEndpoint } from './webauth';

export type BmcFamily = 'megarac-sp' | 'megarac-spx' | 'supermicro-aten' | 'dell-idrac' | 'hpe-ilo' | 'openbmc' | 'unknown';

export interface Detection {
  family: BmcFamily;
  scheme: 'http' | 'https';
  scores: Partial<Record<BmcFamily, number>>;
  evidence: string[];
}

export const SUPPORTED_FAMILIES: BmcFamily[] = ['megarac-sp', 'megarac-spx'];

export const FAMILY_NAMES: Record<BmcFamily, string> = {
  'megarac-sp': 'AMI MegaRAC SP (Java JViewer generation)',
  'megarac-spx': 'AMI MegaRAC SP-X (HTML5 viewer generation)',
  'supermicro-aten': 'Supermicro / ATEN iKVM',
  'dell-idrac': 'Dell iDRAC',
  'hpe-ilo': 'HPE iLO',
  openbmc: 'OpenBMC',
  unknown: 'unknown BMC',
};

async function probe(ep: WebEndpoint, path: string) {
  try {
    return await request({ ...ep, timeoutMs: 8000 }, 'GET', path, { Accept: '*/*' });
  } catch {
    return undefined;
  }
}

export async function detectFamily(ep: WebEndpoint): Promise<Detection> {
  const scores: Partial<Record<BmcFamily, number>> = {};
  const evidence: string[] = [];
  const add = (f: BmcFamily, n: number, why: string) => {
    scores[f] = (scores[f] ?? 0) + n;
    evidence.push(`${f} +${n}: ${why}`);
  };
  // All probes are independent read-only GETs: run them concurrently.
  const [root, rpc, api, jnlp] = await Promise.all([
    probe(ep, '/'), probe(ep, '/rpc/WEBSES/validate.asp'), probe(ep, '/api/session'), probe(ep, '/Java/jviewer.jnlp'),
  ]);
  if (!root) return { family: 'unknown', scheme: ep.scheme, scores, evidence: [`no response from ${ep.scheme}://${ep.host}/`] };
  const server = String(root.headers.server ?? '');
  const body = root.body;
  if (/GoAhead/i.test(server)) add('megarac-sp', 3, `Server: ${server}`);
  if (/lighttpd/i.test(server)) add('megarac-spx', 2, `Server: ${server}`);
  if (root.headers['referrer-policy'] === 'no-referrer') add('megarac-spx', 1, 'Referrer-Policy: no-referrer');
  if (/\/page\/login\.html|index_imp\.js|jviewer/i.test(body)) add('megarac-sp', 3, 'legacy MegaRAC page references');
  if (/libs\/kvm|viewer\.html|megarac|ng-app|app\.js/i.test(body)) add('megarac-spx', 1, 'SP-X style page');
  if (/cgi\/login\.cgi|ATEN|Supermicro/i.test(body)) add('supermicro-aten', 3, 'Supermicro/ATEN login page');
  if (/iDRAC|Integrated Dell Remote Access/i.test(body)) add('dell-idrac', 4, 'iDRAC page');
  if (/iLO|Integrated Lights-Out/i.test(body)) add('hpe-ilo', 4, 'iLO page');
  if (/openbmc|webui-vue/i.test(body)) add('openbmc', 3, 'OpenBMC web UI');
  // Second-stage probes for the AMI families (public endpoints, no credentials).
  if (rpc && rpc.status === 200 && /HAPI_STATUS|WEBVAR_/i.test(rpc.body)) add('megarac-sp', 5, '/rpc/WEBSES/validate.asp answers');
  if (api && (api.status === 401 || api.status === 403 || api.status === 200) && /^\s*[{[]/.test(api.body)) add('megarac-spx', 5, `/api/session answers JSON (HTTP ${api.status})`);
  if (jnlp && jnlp.status === 200 && /jnlp|session_expired/i.test(jnlp.body)) add('megarac-sp', 2, '/Java/jviewer.jnlp exists');
  let family: BmcFamily = 'unknown';
  let best = 0;
  for (const [f, n] of Object.entries(scores) as Array<[BmcFamily, number]>) {
    if (n > best) { best = n; family = f; }
  }
  return { family: best >= 3 ? family : 'unknown', scheme: ep.scheme, scores, evidence };
}
