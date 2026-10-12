// Runs the built probe CLI against the mock BMC (skipped if dist/ is not built).
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findScenario } from '../src/sim/scenario';
import { SimBmc } from '../src/sim/server';

const probe = join(__dirname, '../dist/cli/probe.js');

describe.skipIf(!existsSync(probe))('probe CLI', () => {
  it('captures, decodes and reports without leaking secrets', async () => {
    const bmc = new SimBmc(findScenario('sp-195'));
    await bmc.listen();
    try {
      const { stdout } = await promisify(execFile)('node', [probe, '--host', '127.0.0.1', '--port', String(bmc.webPort), '--record', '--user', 'admin', '--frames', '1', '--seconds', '5'], {
        env: { ...process.env, BMC_PASSWORD: 'admin' }, cwd: join(__dirname, '..'),
      });
      const dir = /wrote (\S+)\//.exec(stdout)![1];
      const abs = join(__dirname, '..', dir);
      const report = JSON.parse(readFileSync(join(abs, 'report.json'), 'utf8'));
      expect(report.connected).toBe(true);
      expect(report.stats.frames).toBe(1);
      expect(report.videoHeaders[0].sourceWidth).toBe(640);
      expect(report.recording).toMatch(/session.ivtprec.json/);
      expect(existsSync(join(abs, 'screen.png'))).toBe(true);
      const all = readFileSync(join(abs, 'report.json'), 'utf8') + readFileSync(join(abs, 'probe.log'), 'utf8') + stdout;
      expect(all).not.toMatch(/password[^\n]*admin/i);
      expect(all).not.toMatch(/cookie [A-Za-z0-9]{8,}/);
      rmSync(abs, { recursive: true });
    } finally {
      await bmc.close();
    }
  });
});
