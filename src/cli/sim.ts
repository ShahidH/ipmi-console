/**
 * Simulated AMI MegaRAC BMC for development and testing without hardware.
 *
 *   npm run sim -- --list
 *   npm run sim -- --scenario sp-195 [--port 8080] [--user admin --password admin]
 *   npm run sim -- --scenario sp-195 --captures captures/<host>-<time>/frames
 *   npm run sim -- --scenario sp-195 --replay captures/session.ivtprec.json
 *
 * Then add a server in the app: address 127.0.0.1, web port = the printed port.
 */
import { findScenario, SCENARIOS, type Scenario } from '../sim/scenario';
import { SimBmc } from '../sim/server';
import { SIM_FIRMWARE } from '../sim/firmware';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' };

async function main() {
  if (flag('list') || flag('help')) {
    console.log(`${C.bold}Scenarios${C.reset}`);
    for (const s of SCENARIOS) console.log(`  ${s.name.padEnd(22)} ${s.description}${s.expect.connects ? '' : `  ${C.dim}(expected to fail)${C.reset}`}`);
    console.log(`\n${C.bold}Firmware variants${C.reset}`);
    for (const f of Object.values(SIM_FIRMWARE)) console.log(`  ${f.id.padEnd(22)} ${f.description}`);
    console.log(`\nOptions: --scenario NAME --port N --kvm-port N --user U --password P --captures DIR --replay FILE --fps N`);
    return;
  }
  const base = findScenario(arg('scenario', 'sp-195')!);
  const sc: Scenario = { ...base };
  if (arg('captures')) sc.video = { captures: arg('captures')! };
  if (arg('replay')) sc.video = { replay: arg('replay')! };
  if (arg('fps')) sc.fps = Number(arg('fps'));
  const bmc = new SimBmc(sc, {
    webPort: Number(arg('port', '8080')),
    kvmPort: Number(arg('kvm-port', '7578')),
    user: arg('user', 'admin'),
    password: arg('password', 'admin'),
  });
  await bmc.listen();
  console.log(`${C.bold}IPMI Console BMC simulator${C.reset}  scenario ${C.cyan}${sc.name}${C.reset}: ${sc.description}`);
  console.log(`  firmware  ${bmc.firmware.description}`);
  console.log(`  web       http://127.0.0.1:${bmc.webPort}   (user ${arg('user', 'admin')} / password ${arg('password', 'admin')})`);
  if (bmc.kvmPort) console.log(`  kvm port  ${bmc.kvmPort} (direct)`);
  console.log(`\n  In the app: Add server → address 127.0.0.1, Web: http, Port: ${bmc.webPort}. Ctrl+C to stop.\n`);
  bmc.on('event', (e) => {
    const time = new Date(e.t).toISOString().slice(11, 23);
    const col = e.kind === 'fault' ? C.red : e.kind === 'warn' ? C.yellow : e.kind === 'input' ? C.green : e.kind === 'session' ? C.cyan : C.dim;
    if (e.kind === 'rx' && !flag('verbose')) return;
    console.log(`${C.dim}${time}${C.reset} ${col}${e.kind.padEnd(7)}${C.reset} ${e.msg}`);
  });
  process.on('SIGINT', async () => {
    await bmc.close();
    process.exit(0);
  });
}

void main();
