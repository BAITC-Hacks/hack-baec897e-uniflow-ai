import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/live',
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: process.env.ORBITDUO_BASE_URL || 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.ORBITDUO_BROWSER_CHANNEL } }],
})
