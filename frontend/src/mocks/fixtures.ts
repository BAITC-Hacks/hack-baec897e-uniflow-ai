import type { CampaignSpec, CampaignView, DecisionEvent, Forecast, LocalEvaluation, PilotRecord, Resources, RunConfig, RunSnapshot } from '../lib/api/types'

const iso = (start: string, seconds: number) => new Date(new Date(start).getTime() + seconds * 1000).toISOString()
const spec = (name: string, from: string, segment: string, target: string, channel: CampaignSpec['channel']): CampaignSpec => ({
  campaign_name: name, filter_arpu_segment: segment, filter_data_segment: null, filter_call_segment: null,
  filter_current_tariff: from, target_tariff: target, channel,
})

const pilotOne = (start: string): PilotRecord => ({
  id: 'pilot-1', sequence: 1, campaign: spec('pilot_high', 'tariff_11', 'HIGH', 'tariff_8', 'sms'),
  requested_customers: 150, actual_customers: 150, cost: 600, observed_lift_ratio: 0.118, observed_lift_total: 89600,
  selection_reason: 'Крупная группа с высокой ожидаемой выручкой.',
  decision_after: 'Предложение оставлено среди кандидатов; наблюдение шумное.', completed_at: iso(start, 6),
})
const pilotTwo = (start: string): PilotRecord => ({
  id: 'pilot-2', sequence: 2, campaign: spec('pilot_mid', 'tariff_6', 'MID', 'tariff_9', 'digital_ads'),
  requested_customers: 120, actual_customers: 120, cost: 2640, observed_lift_ratio: -0.026, observed_lift_total: -6400,
  selection_reason: 'Проверка другого ценового сегмента и канала.',
  decision_after: 'Оценка по этой группе снижена; один пилот не даёт окончательного вывода.', completed_at: iso(start, 9),
})

const campaigns: CampaignView[] = [
  { id: 'campaign-1', execution_order: 1, spec: spec('high_push', 'tariff_11', 'HIGH', 'tariff_8', 'push'), audience_count: 4000, communication_cost: 0,
    expected_incremental_net_gain: 1350000, expected_lift_ratio: 0.08, evidence: 'pilot_supported', supporting_pilot_ids: ['pilot-1'],
    reasons: ['Пилот поддержал направление предложения.', 'Нулевой денежный расход push при расходе контактов.'], warnings: ['Охват пилота пересекается с финальной аудиторией приблизительно.'] },
  { id: 'campaign-2', execution_order: 2, spec: spec('mid_sms', 'tariff_4', 'MID', 'tariff_9', 'sms'), audience_count: 3000, communication_cost: 12000,
    expected_incremental_net_gain: 850000, expected_lift_ratio: 0.105, evidence: 'prior_only', supporting_pilot_ids: [],
    reasons: ['По публичной истории это перспективный тариф для сегмента.', 'В портфеле сохраняется место для аудитории со средней выручкой.'], warnings: ['Для этой точной группы нет отдельного пилота.'] },
  { id: 'campaign-3', execution_order: 3, spec: spec('high_digital', 'tariff_6', 'HIGH', 'tariff_9', 'digital_ads'), audience_count: 2000, communication_cost: 44000,
    expected_incremental_net_gain: 476000, expected_lift_ratio: 0.092, evidence: 'pilot_supported', supporting_pilot_ids: ['pilot-2'],
    reasons: ['Пилот уточнил оценку канала.', 'Вклад оценён после уже выбранных кампаний.'], warnings: ['Отрицательное наблюдение пилота шумное.'] },
]

const negativeCampaign: CampaignView = {
  id: 'campaign-fallback', execution_order: 1, spec: spec('fallback_push', 'tariff_3', 'LOW', 'tariff_5', 'push'), audience_count: 500,
  communication_cost: 0, expected_incremental_net_gain: -6760, expected_lift_ratio: -0.012, evidence: 'fallback', supporting_pilot_ids: [],
  reasons: ['Конкурсный контракт требует непустой финальный план.', 'Этот вариант имеет наименьший ожидаемый ущерб среди допустимых.'],
  warnings: ['Уверенно выгодных вариантов не найдено.'],
}

const events = (start: string, count: number, negative: boolean): DecisionEvent[] => ([
  { id: 'event-1', sequence: 1, created_at: iso(start, 2), phase: 'audit', title: 'Аудитория изучена', message: 'Проверены доступные сегменты и конкурсные лимиты.' },
  { id: 'event-2', sequence: 2, created_at: iso(start, 4), phase: 'candidates', title: 'Гипотезы подготовлены', message: 'Сформированы допустимые сочетания аудитории, тарифа и канала.' },
  { id: 'event-3', sequence: 3, created_at: iso(start, 6), phase: 'pilots', title: 'Первый пилот завершён', message: 'Наблюдение для группы с высокой выручкой обновило оценку предложения.' },
  { id: 'event-4', sequence: 4, created_at: iso(start, 9), phase: 'pilots', title: 'Второй пилот завершён', message: 'Слабое наблюдение по другой группе снизило её приоритет.' },
  { id: 'event-5', sequence: 5, created_at: iso(start, 11), phase: 'planning', title: 'Портфель собран', message: negative ? 'Среди вариантов не нашлось уверенно положительной оценки.' : 'План учитывает общие контакты, бюджет и пересечения.' },
  { id: 'event-6', sequence: 6, created_at: iso(start, 14), phase: 'completed', title: 'Локальная проверка завершена', message: 'Сохранены план и результат синтетического оценщика.' },
] satisfies DecisionEvent[]).slice(0, count)

const resources = (pilots: number, completed: boolean, negative: boolean): Resources => {
  const pilotCost = pilots === 0 ? 0 : pilots === 1 ? 600 : 3240
  const pilotContacts = pilots === 0 ? 0 : pilots === 1 ? 150 : 270
  const finalCost = negative ? 0 : 56000
  const finalContacts = negative ? 500 : 9000
  return {
    budget: { limit: 100000, used_by_pilots: pilotCost, planned_final: completed ? finalCost : null, remaining_after_plan: completed ? 100000 - pilotCost - finalCost : null },
    contacts: { limit: 15000, used_by_pilots: pilotContacts, planned_final: completed ? finalContacts : null, remaining_after_plan: completed ? 15000 - pilotContacts - finalContacts : null },
    pilots_used: pilots, pilots_limit: 20, final_campaigns_count: completed ? negative ? 1 : 3 : 0, final_campaigns_limit: 10,
  }
}

export interface StoredRun { id: string; config: RunConfig; created_at: string; key: string }

export function buildSnapshot(run: StoredRun, now = Date.now()): RunSnapshot {
  const elapsed = Math.max(0, (now - new Date(run.created_at).getTime()) / 1000)
  const negative = run.config.seed === 7
  const shouldFail = run.config.seed === 13
  const cautious = run.config.risk_profile === 'conservative'
  const failed = shouldFail && elapsed >= 11
  const completed = !shouldFail && elapsed >= 14
  const pilots = elapsed >= 9 ? 2 : elapsed >= 6 ? 1 : 0
  const phase = failed ? 'failed' : completed ? 'completed' : elapsed < 2 ? 'queued' : elapsed < 4 ? 'audit' : elapsed < 6 ? 'candidates' : elapsed < 11 ? 'pilots' : 'planning'
  const activeEvents = elapsed < 2 ? 0 : elapsed < 4 ? 1 : elapsed < 6 ? 2 : elapsed < 9 ? 3 : elapsed < 11 ? 4 : elapsed < 14 ? 5 : 6
  const forecast: Forecast | null = completed ? {
    scope: 'pilots_and_final', expected_gross_gain: negative ? cautious ? -10760 : -6760 : cautious ? 2459240 : 2759240,
    expected_net_gain: negative ? cautious ? -14000 : -10000 : cautious ? 2400000 : 2700000,
    net_gain_interval: negative ? null : { low: cautious ? 1500000 : 1700000, high: cautious ? 3100000 : 3400000, level: 0.9, method: 'Демонстрационный модельный диапазон' },
    expected_unique_reach: negative ? 750 : 8620, overlap_method: 'Демонстрационная оценка пересечения пилотов и финальных кампаний.',
  } : null
  const local: LocalEvaluation | null = completed ? {
    label: 'local_simulation', gross_gain: negative ? -3000 : 2422000, net_arpu_gain: negative ? -6240 : 2362760,
    communication_cost: negative ? 3240 : 59240, total_contacts: negative ? 770 : 9270,
    unique_customers: negative ? 750 : 8620, n_pilots: 2, n_final_campaigns: negative ? 1 : 3, runtime_seconds: 14,
  } : null
  const status = failed ? 'failed' : completed ? 'completed' : elapsed < 2 ? 'queued' : 'running'
  return {
    id: run.id, api_version: '1', mode: 'demo', dataset_id: 'a85e9badf4cb51b1', config: run.config, status, phase,
    created_at: run.created_at, updated_at: iso(run.created_at, Math.min(Math.floor(elapsed), failed ? 11 : 14)),
    completed_at: failed ? iso(run.created_at, 11) : completed ? iso(run.created_at, 14) : null,
    forecast_net_gain: forecast?.expected_net_gain ?? null, local_net_gain: local?.net_arpu_gain ?? null,
    phase_message: failed ? 'Демонстрационный расчёт завершился ошибкой.' : completed ? 'План готов' :
      phase === 'queued' ? 'Запуск ожидает выполнения' : phase === 'audit' ? 'Оцениваем аудиторию' :
      phase === 'candidates' ? 'Подбираем предложения' : phase === 'pilots' ? 'Агент проверяет гипотезы' : 'Собираем план',
    resources: resources(pilots, completed, negative), pilots: pilots === 0 ? [] : pilots === 1 ? [pilotOne(run.created_at)] : [pilotOne(run.created_at), pilotTwo(run.created_at)],
    campaigns: completed ? negative ? [{ ...negativeCampaign, expected_incremental_net_gain: cautious ? -10760 : -6760 }] : cautious ? campaigns.map(item => ({ ...item, expected_incremental_net_gain: Math.round((item.expected_incremental_net_gain || 0) * 0.89) })) : campaigns : [],
    events: failed ? [...events(run.created_at, 4, negative), {
      id: 'event-failed', sequence: 5, created_at: iso(run.created_at, 11), phase: 'failed', title: 'Расчёт остановлен',
      message: 'Демонстрационный сбой при сборке плана. Пилоты сохранены; готового плана нет.',
    }] : events(run.created_at, activeEvents, negative), forecast, local_evaluation: local,
    warnings: completed && negative ? [{ code: 'NEGATIVE_FORECAST', severity: 'warning', message: 'Уверенно выгодные варианты не найдены.', affected_count: null }] : [],
    failure: failed ? { code: 'DEMO_FAILURE', message: 'Демонстрационная ошибка расчёта. Ранее полученные пилоты сохранены.', retryable: true } : null,
  }
}
