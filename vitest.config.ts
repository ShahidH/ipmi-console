import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node tests for protocol/video/sim/main; tests/renderer/** opt into jsdom per file.
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Entry points and code only exercised by the e2e suite (Electron APIs, worker, CLI).
      exclude: ['src/renderer/main.tsx', 'src/renderer/decode-worker.ts', 'src/main/main.ts', 'src/main/window.ts', 'src/main/ipc.ts', 'src/main/keychain.ts', 'src/preload/**', 'src/cli/**'],
      reporter: ['text-summary', 'text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Floors a little under what CI measures. CI has no optional local data (real
      // captures, BMC jars, the C reference decoder), so a full local run measures higher.
      // Raise the floors as tests are added; never lower them.
      thresholds: { statements: 73, branches: 66, functions: 70, lines: 77 },
    },
  },
});
