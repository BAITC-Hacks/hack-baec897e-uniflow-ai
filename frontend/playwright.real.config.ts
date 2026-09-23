import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dbDirectory = mkdtempSync(join(tmpdir(), 'orbitduo-e2e-'))
const root = resolve('..')
const python = process.env.ORBITDUO_PYTHON || join(root, '.venv', 'Scripts', 'python.exe')

export default defineConfig({
  testDir: './tests/real',
  globalTeardown: './tests/real/teardown.ts',
  timeout: 45000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium-real', use: { ...devices['Desktop Chrome'], channel: process.env.ORBITDUO_BROWSER_CHANNEL } }],
  webServer: [
    { command: `"${python}" -m uvicorn backend.app:app --host 127.0.0.1 --port 8000`, cwd: root,
      url: 'http://127.0.0.1:8000/api/v1/health', env: { ORBITDUO_DB_PATH: join(dbDirectory, 'runs.sqlite3') },
      reuseExistingServer: false, timeout: 30000 },
    { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173',
      env: { VITE_DEMO_MODE: 'false' }, reuseExistingServer: false, timeout: 30000 },
  ],
})
