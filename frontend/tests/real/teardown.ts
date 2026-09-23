import { execFileSync } from 'node:child_process'

export default async function teardown() {
  if (process.platform !== 'win32') return
  // A Windows venv launcher can leave its child Python process behind after
  // Playwright stops the webServer wrapper. This suite owns port 8000.
  const sockets = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
  const match = sockets.match(/^\s*TCP\s+127\.0\.0\.1:8000\s+\S+\s+LISTENING\s+(\d+)/m)
  if (match) execFileSync('taskkill', ['/PID', match[1], '/T', '/F'])
}
