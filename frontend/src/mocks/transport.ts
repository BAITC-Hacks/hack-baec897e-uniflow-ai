import overviewJson from './overview.json'
import { buildSnapshot, type StoredRun } from './fixtures'
import type { Overview, RunConfig, RunSnapshot } from '../lib/api/types'

const storageKey = 'orbitduo-demo-runs-v1'
const overview = overviewJson as Overview
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
const error = (status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
  json({ error: { code, message, details, request_id: 'demo-request' } }, status)

let memoryRuns: StoredRun[] = []
let memoryOnly = false

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function isConfig(value: unknown): value is RunConfig {
  return isRecord(value) && typeof value.seed === 'number' && Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 2147483647
    && (value.risk_profile === 'balanced' || value.risk_profile === 'conservative')
}
function isStoredRun(value: unknown): value is StoredRun {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && typeof value.key === 'string' && value.key.length > 0
    && typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)) && isConfig(value.config)
}
function readRuns(): StoredRun[] {
  if (memoryOnly) return memoryRuns
  let stored: string | null
  try { stored = localStorage.getItem(storageKey) } catch { memoryOnly = true; return memoryRuns }
  try {
    const decoded: unknown = JSON.parse(stored || '[]')
    memoryRuns = Array.isArray(decoded) ? decoded.filter(isStoredRun).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) : []
  } catch { memoryRuns = [] }
  return memoryRuns
}
function saveRuns(runs: StoredRun[]) {
  memoryRuns = runs
  if (!memoryOnly) {
    try { localStorage.setItem(storageKey, JSON.stringify(runs)) } catch { memoryOnly = true }
  }
}
function snapshotFor(run: StoredRun) {
  const snapshot = buildSnapshot(run)
  if (memoryOnly) snapshot.warnings.push({ code: 'DEMO_STORAGE_UNAVAILABLE', severity: 'warning', affected_count: null,
    message: 'Браузер не разрешил сохранить историю. Демонстрационный запуск доступен в этой вкладке до обновления страницы.' })
  return snapshot
}
function emptyFixture() {
  try { return localStorage.getItem('orbitduo-demo-fixture') === 'empty' } catch { return false }
}

function csvEscape(value: string | null): string {
  const cell = value ?? ''
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}
function planCsv(snapshot: RunSnapshot) {
  const fields = ['campaign_name', 'filter_arpu_segment', 'filter_data_segment', 'filter_call_segment', 'filter_current_tariff', 'target_tariff', 'channel'] as const
  return [fields.join(','), ...snapshot.campaigns.map(({ spec }) => fields.map(key => csvEscape(spec[key])).join(','))].join('\r\n') + '\r\n'
}

export async function demoFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { init.signal?.removeEventListener('abort', onAbort); resolve() }, 180)
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    init.signal?.addEventListener('abort', onAbort, { once: true })
  })
  const route = new URL(path, 'http://demo.local')
  const pathname = route.pathname.replace(/^\/api\/v1/, '')
  if (pathname === '/health' && init.method !== 'POST') return json({ status: 'ok', api_version: '1', mode: 'demo' })
  if (pathname === '/overview' && init.method !== 'POST') {
    if (emptyFixture()) return json({ ...overview, dataset: { ...overview.dataset, customer_count: 0, baseline_revenue: 0, eligible_customer_count: 0, excluded_customer_count: 0, notices: [] }, segments: [] })
    return json(overview)
  }
  if (pathname === '/runs' && init.method === 'POST') {
    const key = new Headers(init.headers).get('Idempotency-Key')
    if (!key) return error(422, 'VALIDATION_ERROR', 'Не указан Idempotency-Key.')
    let parsed: unknown
    try { parsed = JSON.parse(String(init.body)) } catch { return error(422, 'VALIDATION_ERROR', 'Неверное тело запроса.') }
    if (!isConfig(parsed) || Object.keys(parsed).some(field => field !== 'seed' && field !== 'risk_profile'))
      return error(422, 'VALIDATION_ERROR', 'Неверные настройки запуска.')
    const config: RunConfig = { seed: parsed.seed, risk_profile: parsed.risk_profile }
    const runs = readRuns()
    const same = runs.find(run => run.key === key)
    if (same) {
      if (same.config.seed !== config.seed || same.config.risk_profile !== config.risk_profile) return error(409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован с другими настройками.')
      const snapshot = snapshotFor(same)
      return json(snapshot, snapshot.status === 'running' || snapshot.status === 'queued' ? 202 : 200)
    }
    const active = runs.find(run => !['completed', 'failed'].includes(buildSnapshot(run).status))
    if (active) return error(409, 'RUN_ALREADY_ACTIVE', 'Расчёт уже выполняется.', { active_run_id: active.id })
    const run: StoredRun = { id: crypto.randomUUID(), key, config, created_at: new Date().toISOString() }
    saveRuns([run, ...runs])
    return json(snapshotFor(run), 202)
  }
  if (pathname === '/runs' && init.method !== 'POST') {
    const limit = Number(route.searchParams.get('limit') || 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(422, 'VALIDATION_ERROR', 'Неверный limit.')
    return json({ items: readRuns().slice(0, limit).map(run => {
      const snapshot = buildSnapshot(run)
      const { id, status, phase, created_at, updated_at, completed_at, config, forecast_net_gain, local_net_gain } = snapshot
      return { id, status, phase, created_at, updated_at, completed_at, config, forecast_net_gain, local_net_gain }
    }) })
  }
  const match = pathname.match(/^\/runs\/([^/]+)(?:\/(campaigns\.csv|report\.json))?$/)
  if (match && init.method !== 'POST') {
    const run = readRuns().find(item => item.id === match[1])
    if (!run) return error(404, 'RUN_NOT_FOUND', 'Запуск не найден.')
    const snapshot = snapshotFor(run)
    if (!match[2]) return json(snapshot)
    if (snapshot.status !== 'completed') return error(409, 'RUN_NOT_READY', 'План ещё рассчитывается.')
    const isCsv = match[2] === 'campaigns.csv'
    return new Response(isCsv ? planCsv(snapshot) : JSON.stringify(snapshot, null, 2), {
      headers: {
        'Content-Type': isCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${run.id}.${isCsv ? 'csv' : 'json'}"`,
      },
    })
  }
  return error(404, 'NOT_FOUND', 'Неизвестный адрес API.')
}
