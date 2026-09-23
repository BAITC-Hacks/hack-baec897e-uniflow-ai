import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { analyzeRun } from '../src/lib/runAnalysis'
import { RunAnalysis } from '../src/features/runs/RunAnalysis'
import { buildSnapshot } from '../src/mocks/fixtures'
import type { RunSnapshot } from '../src/lib/api/types'

afterEach(cleanup)

function completedRun(seed = 42): RunSnapshot {
  return structuredClone(buildSnapshot({ id: 'analysis-run', config: { seed, risk_profile: 'balanced' }, created_at: '2026-09-23T10:00:00Z', key: 'test-key' }, Date.parse('2026-09-23T10:01:00Z')))
}

function recommendation(run: RunSnapshot, id: string) {
  return analyzeRun(run).recommendations.find(item => item.id === id)
}

describe('analysis of saved run data', () => {
  it('prioritizes the most negative contribution without changing the saved campaign order', () => {
    const run = completedRun()
    run.campaigns[0].expected_incremental_net_gain = -100
    run.campaigns[2].expected_incremental_net_gain = -12000
    const before = structuredClone(run)
    const analysis = analyzeRun(run)
    expect(analysis.recommendations[0].id).toBe('negative-campaigns')
    expect(analysis.recommendations[0].action.campaignId).toBe('campaign-3')
    expect(analysis.recommendations[0].nextStep).toContain('оценить заново')
    expect(run).toEqual(before)
  })

  it('does not present a completed negative forecast as a successful business outcome', () => {
    const analysis = analyzeRun(completedRun(7))
    expect(analysis.tone).toBe('negative')
    expect(analysis.headline).toContain('отрицательный эффект предложений')
    expect(analysis.recommendations[0].id).toBe('negative-campaigns')
    expect(analysis.recommendations.some(item => item.id === 'unverified-campaigns')).toBe(true)
  })

  it('distinguishes an exact zero forecast from a missing forecast', () => {
    const zero = completedRun()
    zero.forecast!.expected_net_gain = 0
    expect(analyzeRun(zero).headline).toContain('не показывает дополнительной выгоды')
    expect(recommendation(zero, 'nonpositive-forecast')).toBeDefined()
    const missing = completedRun()
    missing.forecast = null
    missing.forecast_net_gain = 999999
    expect(analyzeRun(missing).headline).toBe('В отчёте нет общего прогноза')
    expect(analyzeRun(missing).summary).toContain('общий ожидаемый эффект пробных проверок и итоговых кампаний не сохранён')
    expect(analyzeRun(missing).summary).not.toContain('пересек')
    expect(recommendation(missing, 'no-forecast')).toBeDefined()
    expect(recommendation(missing, 'missing-interval')).toBeUndefined()
  })

  it('calls out a range that crosses zero without assigning a probability of success', () => {
    const run = completedRun()
    run.forecast!.net_gain_interval = { low: -2500, high: 12000, level: 0.9, method: 'test' }
    const analysis = analyzeRun(run)
    expect(analysis.headline).toContain('возможен отрицательный эффект')
    const risk = recommendation(run, 'uncertain-forecast')!
    expect(risk.evidence).toContain('включает ноль')
    expect(risk.nextStep).toContain('не гарантирует')
    expect(JSON.stringify(analysis)).not.toContain('90%')
  })

  it('treats a range touching zero as uncertain', () => {
    const run = completedRun()
    run.forecast!.net_gain_interval!.low = 0
    expect(recommendation(run, 'uncertain-forecast')).toBeDefined()
    expect(analyzeRun(run).headline).not.toContain('отрицательный эффект')
  })

  it('does not describe an empty final plan as ready even when a forecast includes pilot effects', () => {
    const run = completedRun()
    run.campaigns = []
    const analysis = analyzeRun(run)
    expect(analysis.tone).toBe('warning')
    expect(analysis.headline).toContain('нет предложений')
    expect(analysis.recommendations[0].id).toBe('empty-plan')
  })

  it('does not infer a confidence range when the API has none', () => {
    const run = completedRun()
    run.forecast!.net_gain_interval = null
    expect(recommendation(run, 'missing-interval')?.evidence).toContain('не сохранён')
    expect(recommendation(run, 'uncertain-forecast')).toBeUndefined()
  })

  it('warns about preliminary and fallback evidence without inventing an untested audience size', () => {
    const run = completedRun()
    run.campaigns[0].evidence = 'fallback'
    const item = recommendation(run, 'unverified-campaigns')!
    expect(item.evidence).toContain('2 из 3')
    expect(item.evidence).toContain('Резервных вариантов: 1')
    expect(item.action.campaignId).toBe('campaign-1')
    expect(item.nextStep).toContain('размер непроверенной аудитории в отчёте не указан')
    expect(item.nextStep).toContain('кампании и проверки система выбирает сама')
  })

  it('reports negative pilot observations as a reason to inspect, not an automatic rejection', () => {
    const item = recommendation(completedRun(), 'negative-pilots')!
    expect(item.evidence).toContain('1 из 2')
    expect(item.evidence).toContain('выборка 120 клиентов')
    expect(item.nextStep).toContain('не повод автоматически исключать')
  })

  it('preserves unknown remaining resources and never treats them as spare budget', () => {
    const run = completedRun()
    run.resources.budget.remaining_after_plan = null
    expect(recommendation(run, 'resources')).toBeUndefined()
    expect(recommendation(run, 'unknown-resources')?.nextStep).toContain('Не считайте отсутствующие значения нулём')
  })

  it('handles an exhausted and zero-limit budget without division or claiming that no contact is possible', () => {
    const run = completedRun()
    run.resources.budget = { limit: 0, used_by_pilots: 0, planned_final: 0, remaining_after_plan: 0 }
    const item = recommendation(run, 'resources')!
    expect(item.evidence).toContain('0 у.е.')
    expect(item.nextStep).toContain('всё равно расходует контакты')
    expect(JSON.stringify(analyzeRun(run))).not.toMatch(/NaN|Infinity/)
  })

  it('does not suggest spending all remaining money or adding campaigns with exhausted contacts', () => {
    const run = completedRun()
    expect(recommendation(run, 'resources')?.nextStep).toContain('Тратить весь бюджет необязательно')
    run.resources.contacts.remaining_after_plan = 0
    const item = recommendation(run, 'resources')!
    expect(item.title).toBe('Учтите оставшиеся ограничения')
    expect(item.nextStep).toContain('свободный денежный бюджет не заменяет контакты')
  })

  it('does not add overlapping warning counts as if they were unique customers', () => {
    const run = completedRun()
    run.warnings = [
      { code: 'INVALID_CURRENT_TARIFF', severity: 'warning', message: 'Technical description', affected_count: 95 },
      { code: 'INELIGIBLE_CUSTOMERS', severity: 'warning', message: 'Technical description', affected_count: 100 },
      { code: 'FORECAST_APPROXIMATION', severity: 'warning', message: 'Technical description', affected_count: null },
    ]
    const item = recommendation(run, 'data-warnings')!
    expect(item.evidence).toContain('100 клиентов')
    expect(item.evidence).not.toContain('195')
    expect(item.evidence).not.toContain('Technical description')
    expect(item.nextStep).toContain('одним и тем же клиентам')
  })

  it('does not call the difference between a forecast and local evaluation forecast accuracy', () => {
    const run = completedRun()
    run.local_evaluation!.net_arpu_gain = -8000
    expect(analyzeRun(run).headline).toContain('проверка показала отрицательный эффект')
    expect(recommendation(run, 'negative-local')?.nextStep).toContain('не измеряет точность прогноза')
  })

  it.each(['running', 'queued', 'failed'] as const)('withholds final recommendations for a %s snapshot, even when it contains stale forecast data', status => {
    const run = completedRun()
    run.status = status
    const analysis = analyzeRun(run)
    expect(analysis.tone).not.toBe('positive')
    expect(analysis.recommendations.map(item => item.id)).toEqual(['incomplete'])
    expect(analysis.summary).not.toContain('2 700 000')
  })

  it('limits the visible list to five priorities without hiding negative campaigns', () => {
    const run = completedRun(7)
    run.local_evaluation!.net_arpu_gain = -5000
    run.warnings.push({ code: 'DATA_WARNING', severity: 'warning', message: 'Warning', affected_count: 5 })
    const analysis = analyzeRun(run)
    expect(analysis.recommendations.length).toBe(5)
    expect(analysis.recommendations[0].id).toBe('negative-campaigns')
  })
})

it('opens the actual campaign from the recommendation and provides anchors for further investigation', async () => {
  const run = completedRun()
  run.campaigns[1].expected_incremental_net_gain = -100
  const openCampaign = vi.fn()
  render(<RunAnalysis run={run} onOpenCampaign={openCampaign} />)
  expect(screen.getByRole('heading', { name: 'Разбор результата' })).toBeInTheDocument()
  expect(screen.getByText(/вручную добавить или убрать их здесь нельзя/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Настроить новый подбор' })).toHaveAttribute('href', '/runs/new')
  await userEvent.setup().click(screen.getAllByRole('button', { name: 'Разобрать кампанию № 2' })[0])
  expect(openCampaign).toHaveBeenCalledWith('campaign-2')
  expect(screen.getByRole('link', { name: 'Посмотреть пробные проверки' })).toHaveAttribute('href', '#run-research')
})

it('keeps campaign investigation available as a link when a drawer callback is not provided', () => {
  render(<RunAnalysis run={completedRun()} />)
  expect(screen.getByRole('link', { name: 'Разобрать кампанию № 2' })).toHaveAttribute('href', '#campaign-plan')
})
