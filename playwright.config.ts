import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  // Cap the worker pool at four: the default uses every core, in every session
  // sharing this machine. Each worker launches its own Electron instance.
  workers: 4,
  use: { trace: 'retain-on-failure' },
  reporter: [['list']],
});
