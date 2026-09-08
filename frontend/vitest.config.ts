import { defineConfig } from 'vitest/config'

// Deliberately NOT reusing vite.config.ts: it carries the electron plugin,
// which spins build watchers for the main process — pointless (and flaky)
// under a node test runner.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
})
