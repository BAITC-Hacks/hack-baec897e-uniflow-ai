import { ApiError, demoMode } from './client'
import type { ApiErrorBody } from './types'

export interface WhatIfTotals {
  gross_gain: number
  net_gain: number
  communication_cost: number
  total_contacts: number
  unique_customers: number
  remaining_budget: number
  remaining_contacts: number
}

export interface WhatIfResult {
  run_id: string
  label: 'local_simulation'
  excluded_campaign_ids: string[]
  retained_campaign_ids: string[]
  original: WhatIfTotals
  alternative: WhatIfTotals
  net_gain_difference: number
  campaigns: Array<{ id: string; audience_count: number; communication_cost: number }>
  valid_final_plan: boolean
  explanation: string
}

export async function calculateWhatIf(runId: string, excludedCampaignIds: string[], signal?: AbortSignal): Promise<WhatIfResult> {
  if (demoMode) throw new ApiError('WHAT_IF_DEMO_UNAVAILABLE', 'Для проверки нужен завершённый подбор в подключённой учебной среде.')
  const base = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')
  let response: Response
  try {
    response = await fetch(`${base}/runs/${encodeURIComponent(runId)}/what-if`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded_campaign_ids: excludedCampaignIds }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ApiError('NETWORK_ERROR', 'Не удалось подключиться к серверу. Проверьте соединение и повторите проверку.')
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new ApiError('INVALID_RESPONSE', 'Сервер не вернул результат проверки. Попробуйте ещё раз.', response.status)
  let body: unknown
  try { body = await response.json() } catch { throw new ApiError('INVALID_RESPONSE', 'Не удалось прочитать результат проверки.', response.status) }
  if (!response.ok) {
    const error = (body as Partial<ApiErrorBody>)?.error
    throw new ApiError(error?.code || 'HTTP_ERROR', error?.message || 'Не удалось проверить вариант.', response.status, error?.details || {}, error?.request_id || '')
  }
  return body as WhatIfResult
}
