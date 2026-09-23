import { describe, expect, it } from 'vitest'
import type { DecisionEvent, Notice, Phase, PilotRecord } from '../src/lib/api/types'
import {
  explainCampaignReason, explainCampaignWarning, explainEvent, explainExclusionReason,
  explainNotice, explainPhaseMessage, explainPilotDecision, explainPilotSelection,
} from '../src/lib/explanations'
import { channel, tariff } from '../src/lib/format'

const selection = 'Diverse initial coverage; compared sample sizes 40/100/200 and available unsaturated channels; heuristic value 898828.35 CU.'
const decision = 'Posterior mean changed 0.01828 → -0.02662; portfolio recomputed with actual resource balances.'
const pilot: PilotRecord = {
  id: 'pilot-1', sequence: 1, requested_customers: 200, actual_customers: 190,
  cost: 4180, observed_lift_ratio: -0.067, observed_lift_total: -10000,
  selection_reason: selection, decision_after: decision, completed_at: '2026-09-23T12:00:00Z',
  campaign: { campaign_name: 'pilot_1', filter_arpu_segment: 'HIGH', filter_current_tariff: 'tariff_8',
    filter_data_segment: null, filter_call_segment: null, target_tariff: 'tariff_9', channel: 'digital_ads' },
}

function event(title: string, message: string, phase: Phase = 'pilots'): DecisionEvent {
  return { id: 'event-1', sequence: 1, created_at: '2026-09-23T12:00:00Z', phase, title, message }
}

describe('human-readable labels', () => {
  it('renders source codes as Russian labels without changing data', () => {
    expect(tariff('tariff_8')).toBe('Тариф 8')
    expect(tariff(null)).toBe('Тариф не указан')
    expect(tariff('future_tariff_code')).toBe('Другой тариф')
    expect(channel('digital_ads')).toBe('Интернет-реклама')
    expect(channel('push')).toBe('Уведомление в приложении')
    expect(channel('sms')).toBe('СМС')
    expect(channel('call')).toBe('Звонок')
  })
})

describe('real agent pilot explanations', () => {
  it('explains the reason for exploring varied groups without presenting heuristic value as income', () => {
    const result = explainPilotSelection(pilot)
    expect(result.recognized).toBe(true)
    expect(result.text).toContain('разные группы абонентов')
    expect(result.text).toContain('40, 100, 200')
    expect(result.text).not.toContain('оценка полезности')
    expect(result.text).not.toContain('898828')
    expect(result.raw).toBe(selection)
  })

  it('supports later adaptive checks and legacy sample sizes', () => {
    const result = explainPilotSelection({ ...pilot, selection_reason: selection.replace('Diverse initial coverage', 'Decision-relevant uncertainty').replace('40/100/200', '80/140/200') })
    expect(result.recognized).toBe(true)
    expect(result.text).toContain('зависит выбор итоговых предложений')
    expect(result.text).toContain('80, 140, 200')
  })

  it('converts model ratios to percentages and distinguishes them from the observation', () => {
    const result = explainPilotDecision(pilot)
    expect(result.text).toContain('с 1,83% до -2,66%')
    expect(result.text).toContain('не наблюдаемый результат')
    expect(result.text).not.toContain('-6,7%')
    expect(result.raw).toBe(decision)
    expect(pilot.decision_after).toBe(decision)
  })

  it('keeps a zero estimate meaningful', () => {
    expect(explainPilotDecision({ ...pilot, decision_after: decision.replace('0.01828', '0.00000') }).text).toContain('с 0%')
  })

  it('keeps unknown and malformed technical messages out of primary text', () => {
    for (const raw of ['The next generation strategy changed', 'Posterior mean changed NaN → Infinity; portfolio recomputed with actual resource balances.', 'Новая engine_reason with internal_code']) {
      const result = explainPilotDecision({ ...pilot, decision_after: raw })
      expect(result.recognized).toBe(false)
      expect(result.text).not.toMatch(/[a-z_]/i)
      expect(result.raw).toBe(raw)
    }
  })
})

describe('real decision journal and current phase', () => {
  it.each([
    ['Public profile audit', 'Validating customer identifiers, public segment labels and baseline values.', 'идентификаторы абонентов'],
    ['Candidates constructed', '63 homogeneous groups and 1260 source/target hypotheses; no same-tariff offers.', '63'],
    ['Initial feasible plan', '1 executable final campaigns; risk penalty 0.55 standard deviations.', 'выбранную осторожность'],
    ['Pilot selected', `tariff_8/HIGH → tariff_9, digital_ads, requested 200. ${selection}`, 'Тариф 8 → Тариф 9'],
    ['Pilot observed', `pilot-1: actual n=190, observed lift=-0.06700; ${decision}`, 'Наблюдаемый прирост выручки: -6,7%'],
    ['Portfolio updated', '2 final campaigns; forecast net including pilots 256741.59 CU.', '256 742 у.е.'],
    ['Exploration stopped', 'Best estimated value of additional information is below its communication, contact and harm costs.', 'сохраняются для итогового плана'],
    ['Final plan validated', '2 campaigns, 16 successful pilots, runtime 13.752s. Official evaluation runs separately.', '13,75 с'],
  ])('translates %s and retains the exact source', (title, raw, expected) => {
    const result = explainEvent(event(title, raw))
    expect(result.recognized).toBe(true)
    expect(result.text).toContain(expected)
    expect(result.title).not.toMatch(/[a-z_]/i)
    expect(result.text).not.toMatch(/[a-z_]/i)
    expect(result.raw).toBe(`${title}\n${raw}`)
    expect(explainPhaseMessage('pilots', raw).text).toBe(result.text)
  })

  it('translates backend phase codes and mixed Russian operational text', () => {
    const queued = explainEvent(event('queued', 'Задание сохранено.', 'queued'))
    expect(queued.title).toBe('Расчёт ожидает своей очереди')
    expect(queued.text).toBe('Задание сохранено.')
    const evaluation = explainEvent(event('evaluation', 'План зафиксирован; независимая оценка локальным harness.', 'evaluation'))
    expect(evaluation.title).toBe('Проверяем результат в симуляции')
    expect(evaluation.text).not.toContain('harness')
  })

  it('does not invent a translation for an unrecognized event', () => {
    const result = explainEvent(event('New internal event', 'Agent changed a hidden parameter', 'planning'))
    expect(result.recognized).toBe(false)
    expect(result.title).toBe('Составляем план предложений')
    expect(result.text).toContain('нет понятной расшифровки')
    expect(result.text).not.toContain('hidden')
    expect(result.raw).toContain('hidden parameter')
  })

  it('preserves understandable Russian demo titles', () => {
    const result = explainEvent(event('Первый пилот завершён', 'Наблюдение для группы с высокой выручкой обновило оценку предложения.'))
    expect(result.title).toBe('Первый пилот завершён')
    expect(result.recognized).toBe(true)
  })
})

describe('campaign reasons and warnings', () => {
  it('explains the mean and standard deviation as different quantities', () => {
    const result = explainCampaignReason('Posterior lift 0.03817, standard deviation 0.01250.')
    expect(result.text).toContain('3,82%')
    expect(result.text).toContain('1,25 процентного пункта')
    expect(result.text).toContain('стандартное отклонение')
    expect(result.text).not.toContain('доверительный интервал')
  })

  it('explains incremental contribution without presenting it as total run gain', () => {
    const result = explainCampaignReason('Executable ID-ordered audience: 5000; marginal expected net: -1000.00 CU.')
    expect(result.recognized).toBe(true)
    expect(result.text).toContain('5 000')
    expect(result.text).toContain('вклад этого предложения')
    expect(result.text).toContain('-1 000 у.е.')
    expect(explainCampaignReason('Selection accounts for previous campaigns, estimated pilot overlap, contacts and budget.').text).toContain('повторное обращение')
  })

  it('highlights missing evidence and the required fallback honestly', () => {
    expect(explainCampaignWarning('Historical prior only; no direct pilot evidence.').text).toContain('нет прямого подтверждения')
    expect(explainCampaignWarning('Required nonempty fallback: minimum estimated damage under the selected risk penalty; gain is not guaranteed.').text).toContain('Положительный эффект не гарантирован')
  })

  it('normalizes mixed-language Russian fixtures and preserves unknown raw warnings', () => {
    expect(explainCampaignReason('Нулевой денежный расход push при расходе контактов.').text).toContain('Уведомление в приложении')
    expect(explainCampaignWarning('Unknown warning from future backend').recognized).toBe(false)
    expect(explainCampaignWarning('Unknown warning from future backend').text).not.toContain('Unknown')
  })
})

describe('data and run notices', () => {
  it.each([
    'SYNTHETIC_DATA', 'INVALID_CURRENT_TARIFF', 'INVALID_ARPU_SEGMENT', 'MISSING_DATA_SEGMENT',
    'MISSING_CALL_SEGMENT', 'INELIGIBLE_CUSTOMERS', 'OPTIONAL_SEGMENTS_MISSING', 'HISTORY_UNAVAILABLE',
    'FORECAST_APPROXIMATION', 'TIME_RESERVE', 'PILOT_FAILED', 'OBSERVER_FAILED', 'REQUIRED_FALLBACK', 'NEGATIVE_FORECAST',
  ])('explains %s using its stable code', code => {
    const notice: Notice = { code, severity: 'warning', message: 'Original technical source message', affected_count: 12 }
    const result = explainNotice(notice)
    expect(result.recognized).toBe(true)
    expect(result.title).not.toMatch(/[a-z_]/i)
    expect(result.text).not.toMatch(/[a-z_]/i)
    expect(result.raw).toBe(notice.message)
    expect(notice.affected_count).toBe(12)
  })

  it('uses a neutral fallback for unknown notices instead of exposing English', () => {
    const result = explainNotice({ code: 'NEW_NOTICE', severity: 'info', message: 'New backend note', affected_count: null })
    expect(result.recognized).toBe(false)
    expect(result.text).not.toContain('New backend')
    expect(result.raw).toBe('New backend note')
  })

  it('explains the actual exclusion reason without source field names', () => {
    const raw = 'Неизвестный/пропущенный current_tariff или недопустимый/пропущенный arpu_segment; исходные строки сохранены.'
    const result = explainExclusionReason(raw)
    expect(result.text).toContain('текущий тариф и группу абонента по выручке')
    expect(result.text).not.toContain('current_tariff')
    expect(result.raw).toBe(raw)
  })
})
