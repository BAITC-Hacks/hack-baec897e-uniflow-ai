import { demoFetch } from '../../mocks/transport'
import type { ApiErrorBody, Mode, Overview, RunConfig, RunSnapshot, RunSummary } from './types'

export const demoMode = import.meta.env.VITE_DEMO_MODE === 'true'
const base = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0, public details: Record<string, unknown> = {}, public requestId = '') { super(message) }
}

async function transport(path: string, init: RequestInit = {}) {
  const url = `${base}${path}`
  try {
    return demoMode ? await demoFetch(url, init) : await fetch(url, init)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError('NETWORK_ERROR', 'Нет соединения с API. Проверьте, запущен ли backend, и попробуйте снова.')
  }
}

async function expectJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('Content-Type') || ''
  if (!contentType.includes('application/json')) throw new ApiError('INVALID_RESPONSE', 'Сервер вернул ответ в неожиданном формате.', response.status)
  let body: unknown
  try { body = await response.json() } catch { throw new ApiError('INVALID_RESPONSE', 'Не удалось прочитать ответ сервера.', response.status) }
  if (!response.ok) {
    const error = (body as Partial<ApiErrorBody>)?.error
    throw new ApiError(error?.code || 'HTTP_ERROR', error?.message || 'Запрос не выполнен.', response.status, error?.details || {}, error?.request_id || '')
  }
  return body as T
}

async function get<T>(path: string, signal?: AbortSignal) { return expectJson<T>(await transport(path, { signal })) }

export const api = {
  health: (signal?: AbortSignal) => get<{ status: 'ok'; api_version: '1'; mode: Mode }>('/health', signal),
  overview: (signal?: AbortSignal) => get<Overview>('/overview', signal),
  runs: (limit = 20, signal?: AbortSignal) => get<{ items: RunSummary[] }>(`/runs?limit=${limit}`, signal),
  run: (id: string, signal?: AbortSignal) => get<RunSnapshot>(`/runs/${encodeURIComponent(id)}`, signal),
  createRun: async (config: RunConfig, key: string, signal?: AbortSignal) => expectJson<RunSnapshot>(await transport('/runs', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(config),
  })),
  download: async (id: string, kind: 'csv' | 'json') => {
    const filename = kind === 'csv' ? 'campaigns.csv' : 'report.json'
    const response = await transport(`/runs/${encodeURIComponent(id)}/${filename}`)
    if (!response.ok) { await expectJson<never>(response); return }
    const contentType = response.headers.get('Content-Type') || ''
    if (!contentType.includes(kind === 'csv' ? 'text/csv' : 'application/json')) throw new ApiError('INVALID_EXPORT', 'Сервер вернул неверный тип файла.', response.status)
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `orbitduo-${id}-${filename}`
    document.body.append(link)
    try { link.click() } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000) }
  },
}
