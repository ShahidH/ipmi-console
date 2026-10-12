// Read-only timing of the unauthenticated connect steps against a BMC: sequential vs
// parallel requests. Usage: bundle with esbuild, then node <bundle> <host>
import { detectFamily } from '../src/protocol/detect';
import { DEFAULT_JAR_PATHS, fetchClientJars, headSizes, request } from '../src/protocol/webauth';
const ep = { host: process.argv[2], scheme: 'http' as const };
const t = async (name: string, fn: () => Promise<unknown>) => { const t0 = performance.now(); await fn(); console.log(name.padEnd(42), (performance.now() - t0).toFixed(0), 'ms'); };
await t('detection, sequential', async () => { for (const p of ['/', '/rpc/WEBSES/validate.asp', '/api/session', '/Java/jviewer.jnlp']) await request(ep, 'GET', p, {}).catch(() => {}); });
await t('detection, parallel', () => detectFamily(ep));
await t('jar download, sequential', async () => { for (const p of DEFAULT_JAR_PATHS) await fetchClientJars(ep, undefined, [p]); });
await t('jar download, parallel (first connect)', () => fetchClientJars(ep, undefined, DEFAULT_JAR_PATHS));
await t('jar HEAD size check (repeat connects)', () => headSizes(ep, DEFAULT_JAR_PATHS));
