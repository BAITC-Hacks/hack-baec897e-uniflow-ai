import overviewJson from './overview.json'
import { buildSnapshot, type StoredRun } from './fixtures'
import type { Overview, RunConfig, RunSnapshot } from '../lib/api/types'

const storageKey = 'orbitduo-demo-runs-v1'
const overview = overviewJson as Overview
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
const error = (status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
  json({ error: { code, message, details, request_id: 'demo-request' } }, status)

function readRuns(): StoredRun[] {
  try { return JSON.parse(localStorage.getItem(storageKey) || '[]') as StoredRun[] } catch { return [] }
}
function saveRuns(runs: StoredRun[]) { localStorage.setItem(storageKey, JSON.stringify(runs)) }

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
    if (localStorage.getItem('orbitduo-demo-fixture') === 'empty') return json({ ...overview, dataset: { ...overview.dataset, customer_count: 0, baseline_revenue: 0, eligible_customer_count: 0, excluded_customer_count: 0, notices: [] }, segments: [] })
    return json(overview)
  }
  if (pathname === '/runs' && init.method === 'POST') {
    const key = new Headers(init.headers).get('Idempotency-Key')
    if (!key) return error(422, 'VALIDATION_ERROR', 'Не указан Idempotency-Key.')
    let config: RunConfig
    try { config = JSON.parse(String(init.body)) as RunConfig } catch { return error(422, 'VALIDATION_ERROR', 'Неверное тело запроса.') }
    if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 2147483647 || !['balanced', 'conservative'].includes(config.risk_profile))
      return error(422, 'VALIDATION_ERROR', 'Неверные настройки запуска.')
    const runs = readRuns()
    const same = runs.find(run => run.key === key)
    if (same) {
      if (JSON.stringify(same.config) !== JSON.stringify(config)) return error(409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован с другими настройками.')
      const snapshot = buildSnapshot(same)
      return json(snapshot, snapshot.status === 'running' || snapshot.status === 'queued' ? 202 : 200)
    }
    const active = runs.find(run => !['completed', 'failed'].includes(buildSnapshot(run).status))
    if (active) return error(409, 'RUN_ALREADY_ACTIVE', 'Расчёт уже выполняется.', { active_run_id: active.id })
    const run: StoredRun = { id: crypto.randomUUID(), key, config, created_at: new Date().toISOString() }
    saveRuns([run, ...runs])
    return json(buildSnapshot(run), 202)
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
    const snapshot = buildSnapshot(run)
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
