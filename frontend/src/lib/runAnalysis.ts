import type { CampaignView, RunSnapshot } from './api/types'
import { money, number, percentage } from './format'

export type AnalysisTone = 'neutral' | 'positive' | 'warning' | 'negative'
export interface AnalysisAction {
  label: string
  href: string
  campaignId?: string
}
export interface AnalysisRecommendation {
  id: string
  tone: AnalysisTone
  title: string
  evidence: string
  nextStep: string
  action: AnalysisAction
}
export interface RunAnalysisResult {
  tone: AnalysisTone
  label: string
  headline: string
  summary: string
  recommendations: AnalysisRecommendation[]
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)
const campaignAction = (campaign: CampaignView): AnalysisAction => ({
  label: `Разобрать кампанию № ${campaign.execution_order}`, href: '#campaign-plan', campaignId: campaign.id,
})

/** Explain the saved API result without changing the plan or estimating a new one. */
export function analyzeRun(run: RunSnapshot): RunAnalysisResult {
  if (run.status !== 'completed') {
    const failed = run.status === 'failed'
    return {
      tone: failed ? 'negative' : 'neutral',
      label: failed ? 'Расчёт прерван' : 'Промежуточные данные',
      headline: failed ? 'Итоговый вывод пока сделать нельзя' : 'Разбор появится после завершения расчёта',
      summary: failed
        ? `Расчёт остановился. Сохранено пробных проверок: ${number(run.pilots.length)}. Предварительные кампании и оценки нельзя считать готовым решением.`
        : `Система ещё подбирает предложения. Завершено пробных проверок: ${number(run.pilots.length)}. Состав плана и оценки могут измениться.`,
      recommendations: [{
        id: 'incomplete', tone: failed ? 'negative' : 'neutral',
        title: failed ? 'Посмотрите, на каком шаге остановился расчёт' : 'Дождитесь готового результата',
        evidence: `Записей о ходе работы: ${number(run.events.length)}.`,
        nextStep: failed
          ? 'Откройте ход работы и сообщение об ошибке. Сохранённые пробные проверки помогут понять, что успело выполниться; они не заменяют готовый план.'
          : 'Страница обновляется автоматически. В ходе работы можно увидеть уже выполненные шаги и результаты пробных проверок.',
        action: { label: 'Посмотреть ход работы', href: '#run-research' },
      }],
    }
  }

  const recommendations: AnalysisRecommendation[] = []
  const forecast = run.forecast
  const gain = finite(forecast?.expected_net_gain) ? forecast.expected_net_gain : null
  const localGain = finite(run.local_evaluation?.net_arpu_gain) ? run.local_evaluation.net_arpu_gain : null
  const interval = forecast?.net_gain_interval
  const validInterval = interval != null && finite(interval.low) && finite(interval.high) && interval.low <= interval.high
  const includesZero = validInterval && interval.low <= 0 && interval.high >= 0
  const negativeCampaigns = run.campaigns.filter(item => finite(item.expected_incremental_net_gain) && item.expected_incremental_net_gain < 0)
    .sort((a, b) => a.expected_incremental_net_gain! - b.expected_incremental_net_gain!)
  const unverified = run.campaigns.filter(item => item.evidence !== 'pilot_supported')

  let tone: AnalysisTone = 'positive'
  let label = 'Есть положительная оценка'
  let headline = 'План выглядит перспективно — проверьте детали'
  let summary = `Ожидаемый эффект после расходов — ${money(gain)}. Он включает пробные проверки и итоговые кампании. Это расчётная оценка, а не обещанный доход.`
  if (gain == null) {
    tone = 'neutral'; label = 'Недостаточно данных'; headline = 'В отчёте нет общего прогноза'
    summary = 'Расчёт завершён, но общий ожидаемый эффект пробных проверок и итоговых кампаний не сохранён. Отдельные оценки кампаний не заменяют этот итог.'
    recommendations.push({
      id: 'no-forecast', tone: 'warning', title: 'Не делайте вывод о выгоде без общего прогноза',
      evidence: `Кампаний в отчёте: ${number(run.campaigns.length)}. Общая оценка отсутствует.`,
      nextStep: 'Посмотрите причины выбора кампаний и замечания к расчёту. Если нужен прогноз, выполните новый расчёт; отсутствие числа не означает нулевой эффект.',
      action: { label: 'Посмотреть кампании', href: '#campaign-plan' },
    })
  } else if (gain < 0) {
    tone = 'negative'; label = 'Нужен пересмотр'; headline = 'Прогноз показывает отрицательный эффект предложений'
    summary = `Ожидаемое изменение выручки после расходов на предложения — ${money(gain)}. Это эффект данного плана, а не прибыль или убыток всего бизнеса. Разберите причины перед новым подбором.`
  } else if (gain === 0) {
    tone = 'warning'; label = 'Рост не показан'; headline = 'Прогноз не показывает дополнительной выгоды'
    summary = 'Ожидаемый эффект после расходов равен нулю. Проверьте предложения, стоимость контактов и результаты пробных проверок перед следующим решением.'
  } else if (includesZero) {
    tone = 'warning'; label = 'Результат неопределён'
    headline = interval.low < 0 ? 'Оценка положительная, но возможен отрицательный эффект' : 'Оценка положительная, но рост нельзя считать уверенным'
    summary = `Ожидаемый эффект — ${money(gain)}. При этом диапазон оценки включает ноль: имеющихся данных недостаточно, чтобы считать выгоду уверенной.`
  } else if (localGain != null && localGain < 0) {
    tone = 'warning'; label = 'Есть противоречивый сигнал'; headline = 'Прогноз положительный, а проверка показала отрицательный эффект'
    summary = `Прогноз после расходов — ${money(gain)}, результат локальной проверки — ${money(localGain)}. Разберите причины до следующего решения; это два разных способа оценки.`
  } else if (negativeCampaigns.length || unverified.length || !validInterval) {
    tone = 'warning'; label = 'Есть что проверить'
  }

  if (!run.campaigns.length) {
    tone = 'warning'; label = 'Нет итоговых кампаний'; headline = 'В отчёте нет предложений для итогового плана'
    summary = gain == null
      ? 'Расчёт завершён, но итоговые кампании и общий прогноз не сохранены. Посмотрите ход работы и замечания, прежде чем делать вывод о результате.'
      : `Кампании не сохранены. Общая оценка — ${money(gain)} — относится к данным этого расчёта, в том числе к пробным проверкам. Она не подтверждает наличие готового плана.`
    recommendations.unshift({
      id: 'empty-plan', tone: 'warning', title: 'Уточните, почему не сформирован итоговый план',
      evidence: `Итоговых кампаний: 0. Пробных проверок: ${number(run.pilots.length)}.`,
      nextStep: 'Посмотрите ход работы и причины остановки подбора. Отсутствие итоговых кампаний не означает, что все предложения бесполезны; для нового решения потребуется новый расчёт.',
      action: { label: 'Посмотреть ход работы', href: '#run-research' },
    })
  }

  if (negativeCampaigns.length) {
    const campaign = negativeCampaigns[0]
    recommendations.push({
      id: 'negative-campaigns', tone: 'negative', title: 'Пересмотрите кампании с отрицательным вкладом',
      evidence: `Таких кампаний: ${number(negativeCampaigns.length)}. У кампании № ${campaign.execution_order} оценённый вклад — ${money(campaign.expected_incremental_net_gain)}.`,
      nextStep: 'Проверьте аудиторию, предложение и расходы. Для пересмотра выполните новый подбор с другим уровнем осторожности. Система заново определит состав плана; эффект возможного исключения кампании нужно оценить заново.',
      action: campaignAction(campaign),
    })
  } else if (gain != null && gain <= 0) {
    recommendations.push({
      id: 'nonpositive-forecast', tone: gain < 0 ? 'negative' : 'warning', title: 'Разберите, почему план не даёт ожидаемой выгоды',
      evidence: `Эффект после расходов: ${money(gain)}. На пробные проверки потрачено ${money(run.resources.budget.used_by_pilots)}.`,
      nextStep: 'Сопоставьте вклад кампаний с расходами и наблюдениями пробных проверок. Положительный вклад отдельной кампании ещё не делает весь план выгодным. Изменения требуют нового расчёта.',
      action: { label: 'Разобрать состав плана', href: '#campaign-plan' },
    })
  }

  if (localGain != null && localGain < 0) recommendations.push({
    id: 'negative-local', tone: 'negative', title: 'Разберите отрицательный эффект в локальной проверке',
    evidence: `Результат проверки после расходов — ${money(localGain)}.`,
    nextStep: 'Проверьте состав кампаний и расходы. Прогноз и локальная проверка используют разные способы оценки; их расхождение само по себе не измеряет точность прогноза.',
    action: { label: 'Посмотреть обе оценки', href: '#run-forecast' },
  })

  if (gain != null && includesZero) recommendations.push({
    id: 'uncertain-forecast', tone: 'warning', title: 'Уточните риск перед следующим подбором',
    evidence: `Диапазон эффекта: от ${money(interval.low)} до ${money(interval.high)}. Он включает ноль.`,
    nextStep: 'Изучите пробные проверки выбранных предложений. Для следующего расчёта можно рассмотреть осторожный режим, но он тоже не гарантирует положительный результат.',
    action: { label: 'Посмотреть диапазон оценки', href: '#run-forecast' },
  })
  else if (gain != null && !validInterval) recommendations.push({
    id: 'missing-interval', tone: 'warning', title: 'Уточните, насколько устойчив прогноз',
    evidence: `Общая оценка есть — ${money(gain)}, но диапазон возможных значений не сохранён.`,
    nextStep: 'Посмотрите, какие пробные проверки подтверждают выбранные предложения. Одного числа недостаточно, чтобы оценить разброс результата; положительная пробная проверка не гарантирует успех всей кампании.',
    action: { label: 'Изучить пробные проверки', href: '#run-research' },
  })

  if (unverified.length) {
    const first = unverified.find(item => item.evidence === 'fallback') || unverified[0]
    const fallbackCount = unverified.filter(item => item.evidence === 'fallback').length
    recommendations.push({
      id: 'unverified-campaigns', tone: 'warning', title: 'Обратите внимание на слабо подтверждённые предложения',
      evidence: `Кампаний с предварительной оценкой или резервным выбором: ${number(unverified.length)} из ${number(run.campaigns.length)}.${fallbackCount ? ` Резервных вариантов: ${number(fallbackCount)}.` : ''}`,
      nextStep: 'Откройте причины выбора и связанные пробные проверки. Для сравнения можно выполнить новый подбор в осторожном режиме; кампании и проверки система выбирает сама. Точный размер непроверенной аудитории в отчёте не указан.',
      action: campaignAction(first),
    })
  }

  const dataWarnings = run.warnings.filter(item => item.severity !== 'info' && !['NEGATIVE_FORECAST', 'FORECAST_APPROXIMATION'].includes(item.code))
  if (dataWarnings.length) {
    const excluded = dataWarnings.find(item => item.code === 'INELIGIBLE_CUSTOMERS')
    const detail = finite(excluded?.affected_count)
      ? ` Не включены в адресный подбор: ${number(excluded.affected_count)} клиентов.`
      : ''
    recommendations.push({
      id: 'data-warnings', tone: 'warning', title: 'Проверьте замечания к исходным данным и расчёту',
      evidence: `Замечаний, требующих внимания: ${number(dataWarnings.length)}.${detail}`,
      nextStep: 'Откройте пояснения к замечаниям. Уточните отсутствующие или неверные данные в источнике перед новым расчётом. Числа в разных замечаниях могут относиться к одним и тем же клиентам.',
      action: { label: 'Прочитать замечания', href: '#run-notices' },
    })
  }

  const negativePilots = run.pilots.filter(item => finite(item.observed_lift_ratio) && item.observed_lift_ratio < 0)
    .sort((a, b) => a.observed_lift_ratio - b.observed_lift_ratio)
  if (negativePilots.length) {
    const pilot = negativePilots[0]
    recommendations.push({
      id: 'negative-pilots', tone: 'warning', title: 'Разберите слабые результаты пробных проверок',
      evidence: `Отрицательный результат у ${number(negativePilots.length)} из ${number(run.pilots.length)} проверок. Проверка № ${pilot.sequence}: ${percentage(pilot.observed_lift_ratio)}, выборка ${number(pilot.actual_customers)} клиентов.`,
      nextStep: 'Посмотрите, какие тарифы, каналы и группы проверялись, и что изменилось после проверки. Одно слабое наблюдение не повод автоматически исключать предложение: на небольшой выборке результат может колебаться.',
      action: { label: 'Посмотреть пробные проверки', href: '#run-research' },
    })
  }

  const budget = run.resources.budget.remaining_after_plan
  const contacts = run.resources.contacts.remaining_after_plan
  if (finite(budget) && finite(contacts)) {
    const roomForCampaigns = run.resources.final_campaigns_count < run.resources.final_campaigns_limit
    recommendations.push({
      id: 'resources', tone: 'neutral',
      title: contacts > 0 && roomForCampaigns ? 'Свободные ресурсы можно оставить в резерве' : 'Учтите оставшиеся ограничения',
      evidence: `После плана остаётся ${money(budget)} и ${number(contacts)} контактов. Кампаний: ${number(run.resources.final_campaigns_count)} из ${number(run.resources.final_campaigns_limit)}.`,
      nextStep: contacts > 0 && roomForCampaigns
        ? budget > 0
          ? 'Тратить весь бюджет необязательно. Если хотите сравнить другой план, выполните новый подбор с другим уровнем осторожности. Система сама решит, какие предложения включить в пределах доступных ресурсов.'
          : 'Денежный бюджет исчерпан. Предложение без денежной стоимости всё равно расходует контакты. Для сравнения другого состава плана нужен новый подбор; сохранённые кампании здесь не редактируются.'
        : 'Проверьте, какой ресурс закончился: свободный денежный бюджет не заменяет контакты и места для кампаний. При новом подборе система заново распределит эти ресурсы в тех же пределах.',
      action: { label: 'Посмотреть расход ресурсов', href: '#run-resources' },
    })
  } else recommendations.push({
    id: 'unknown-resources', tone: 'neutral', title: 'Уточните остатки перед следующим решением',
    evidence: 'В отчёте нет полной оценки оставшегося бюджета или контактов.',
    nextStep: 'Посмотрите расход ресурсов. Не считайте отсутствующие значения нулём или свободным запасом. Если нужны полные оценки для сравнения, выполните новый подбор.',
    action: { label: 'Посмотреть расход ресурсов', href: '#run-resources' },
  })

  if (recommendations.length < 3) recommendations.push({
    id: 'review-plan', tone: 'neutral', title: 'Начните с проверки конкретного предложения',
    evidence: `В плане кампаний: ${number(run.campaigns.length)}. Сохранено пробных проверок: ${number(run.pilots.length)}.`,
    nextStep: 'Откройте кампанию: проверьте, кому предлагают какой тариф, через какой канал и на чём основан выбор. Успешная пробная проверка не гарантирует такой же результат при расширении.',
    action: { label: 'Посмотреть состав плана', href: '#campaign-plan' },
  })

  return { tone, label, headline, summary, recommendations: recommendations.slice(0, 5) }
}
