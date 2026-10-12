import { defineConfig } from '@playwright/test';

// End-to-end UI tests: the built Electron app against the simulated BMC (src/sim).
// Run with `npm run test:e2e` (builds first).
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  // One retry on CI, so a timing blip on a shared runner doesn't block a release; retried passes are reported as flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/e2e-report' }]],
  outputDir: 'test-results/e2e',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
