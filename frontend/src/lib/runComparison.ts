import type { CampaignView, RunSnapshot } from './api/types'

export function parseComparisonIds(raw: string | null): string[] | null {
  if (!raw) return null
  const parts = raw.split(',')
  if (parts.some(id => !/^[a-zA-Z0-9_-]{1,120}$/.test(id))) return null
  const ids = [...new Set(parts)]
  return ids.length >= 2 && ids.length <= 3 ? ids : null
}

export function comparisonDifferences(runs: RunSnapshot[]): string[] {
  if (runs.length < 2) return []
  const different = (select: (run: RunSnapshot) => unknown) => new Set(runs.map(select)).size > 1
  const differences: string[] = []
  if (different(run => run.dataset_id)) differences.push('Разные наборы данных: состав аудитории мог измениться.')
  if (different(run => run.mode)) differences.push('Разные режимы расчёта: демонстрация и локальная симуляция не сопоставимы напрямую.')
  if (different(run => run.config.seed)) differences.push('Разные номера сценария: условия учебной проверки отличаются.')
  if (different(run => run.resources.budget.limit) || different(run => run.resources.contacts.limit) || different(run => run.resources.pilots_limit) || different(run => run.resources.final_campaigns_limit)) differences.push('Разные ограничения бюджета, контактов или числа кампаний.')
  if (runs.some(run => run.status !== 'completed')) differences.push('Есть незавершённый расчёт: его значения ещё могут измениться или остаться неполными.')
  return differences
}

export function campaignSignature(campaign: CampaignView): string {
  const spec = campaign.spec
  const normalize = (value: string | null) => value ? value.split(';').map(item => item.trim()).sort().join(';') : ''
  return JSON.stringify([spec.target_tariff, spec.channel, normalize(spec.filter_current_tariff), normalize(spec.filter_arpu_segment), normalize(spec.filter_data_segment), normalize(spec.filter_call_segment)])
}
