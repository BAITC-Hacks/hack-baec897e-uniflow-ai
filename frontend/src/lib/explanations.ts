import type { Channel, DecisionEvent, Notice, Phase, PilotRecord } from './api/types'
import { channel, money, number, segment, tariff } from './format'

/** Presentation only: original API text stays available for technical details and exports. */
export interface Explanation {
  title: string
  text: string
  raw: string
  recognized: boolean
}

const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const percent = (ratio: number) => `${decimal.format(ratio * 100)}%`
const numeric = '(-?\\d+(?:\\.\\d+)?)'
const explanation = (title: string, text: string, raw: string, recognized = true): Explanation => ({ title, text, raw, recognized })

const phaseTitles: Record<Phase, string> = {
  queued: 'Расчёт ожидает своей очереди',
  audit: 'Проверяем данные об абонентах',
  candidates: 'Подбираем варианты предложений',
  pilots: 'Проверяем предложения на небольших группах',
  planning: 'Составляем план предложений',
  evaluation: 'Проверяем результат в симуляции',
  completed: 'Расчёт завершён',
  failed: 'Расчёт остановлен из-за ошибки',
}

// Older saved reports and demo fixtures already contain Russian prose. Translate
// known field names, but never present an unknown English sentence as user copy.
function plainRussian(raw: string): string | null {
  const text = raw
    .replace(/\btariff_\d+\b/gi, code => tariff(code))
    .replace(/\b(digital_ads|push|sms|call)\b/gi, code => channel(code.toLowerCase() as Channel))
    .replace(/\bcurrent_tariff\b/g, 'текущий тариф')
    .replace(/\barpu_segment\b/g, 'группа по выручке')
    .replace(/\bdata_segment\b/g, 'группа по использованию интернета')
    .replace(/\bcall_segment\b/g, 'группа по использованию звонков')
    .replace(/\bpredicted_arpu\b/g, 'ожидаемая выручка на абонента')
    .replace(/\bARPU\b/gi, 'выручка на абонента')
    .replace(/локальным harness/g, 'в симуляции')
    .replace(/\bharness\b/g, 'симулятор')
    .replace(/\bID\b/g, 'идентификатор')
    .trim()
  return /[а-яё]/i.test(text) && !/[a-z_]/i.test(text) ? text : null
}

function fallback(title: string, raw: string, text = 'Для этой записи пока нет понятной расшифровки. Исходное сообщение доступно в технических деталях.'): Explanation {
  const russian = plainRussian(raw)
  return explanation(title, russian ?? text, raw, russian !== null)
}

function selection(raw: string): Explanation {
  const match = /^(Diverse initial coverage|Decision-relevant uncertainty); compared sample sizes (\d+(?:\/\d+)*) and available unsaturated channels; heuristic value -?\d+(?:\.\d+)? CU\.$/.exec(raw)
  if (!match) return fallback('Почему выбрана эта проверка', raw)
  const sizes = match[2].split('/').map(Number)
  if (!sizes.every(Number.isFinite)) return fallback('Почему выбрана эта проверка', raw)
  const purpose = match[1] === 'Diverse initial coverage'
    ? 'В начале расчёта система проверяет разные группы абонентов, чтобы не делать вывод по одной группе.'
    : 'Эта проверка помогает уточнить оценку, от которой зависит выбор итоговых предложений.'
  return explanation('Почему выбрана эта проверка', `${purpose} Сравнили размеры групп (${sizes.map(number).join(', ')} абонентов) и доступные каналы связи.`, raw)
}

function decision(raw: string): Explanation {
  const match = new RegExp(`^Posterior mean changed ${numeric} → ${numeric}; portfolio recomputed with actual resource balances\\.$`).exec(raw)
  if (!match || ![match[1], match[2]].every(value => Number.isFinite(Number(value)))) return fallback('Что изменилось после проверки', raw)
  return explanation('Что изменилось после проверки', `Ожидаемый прирост выручки для этого предложения пересчитан: с ${percent(Number(match[1]))} до ${percent(Number(match[2]))}. Это обновлённый прогноз модели с учётом проверки, а не наблюдаемый результат самой проверки. План пересобран с учётом оставшегося бюджета и числа контактов.`, raw)
}

export const explainPilotSelection = (pilot: PilotRecord): Explanation => selection(pilot.selection_reason)
export const explainPilotDecision = (pilot: PilotRecord): Explanation => decision(pilot.decision_after)

function knownMessage(raw: string): Explanation | null {
  if (raw === 'Validating customer identifiers, public segment labels and baseline values.') {
    return explanation('Проверяем данные об абонентах', 'Система проверяет идентификаторы абонентов, их группы и исходную выручку, прежде чем подбирать предложения.', raw)
  }
  if (raw === 'Best estimated value of additional information is below its communication, contact and harm costs.') {
    return explanation('Дополнительные проверки остановлены', 'По оценке системы, следующая проверка даст меньше полезной информации, чем потребует денег и контактов, с учётом риска снижения выручки. Оставшиеся ресурсы сохраняются для итогового плана.', raw)
  }
  let match = /^(\d+) homogeneous groups and (\d+) source\/target hypotheses; no same-tariff offers\.$/.exec(raw)
  if (match) return explanation('Варианты предложений подготовлены', `Групп абонентов со сходными условиями: ${number(Number(match[1]))}. Вариантов перехода на другой тариф: ${number(Number(match[2]))}. Предложения остаться на том же тарифе исключены.`, raw)

  match = new RegExp(`^(\\d+) executable final campaigns; risk penalty ${numeric} standard deviations\\.$`).exec(raw)
  if (match) return explanation('Первый вариант плана готов', `Количество предложений в предварительном плане: ${number(Number(match[1]))}. Система учла доступный бюджет, число контактов и выбранную осторожность при оценке неопределённости. После проверок этот план может измениться.`, raw)

  match = /^(tariff_\d+)\/(HIGH|MID|LOW) → (tariff_\d+), (push|sms|digital_ads|call), requested (\d+)\. (.+)$/.exec(raw)
  if (match) {
    const why = selection(match[6])
    return explanation('Выбрано предложение для проверки', `Группа: ${segment(match[2]).toLowerCase()}. Переход: ${tariff(match[1])} → ${tariff(match[3])}. Канал: ${channel(match[4] as Channel).toLowerCase()}. Запрошено абонентов: ${number(Number(match[5]))}. ${why.text}`, raw, why.recognized)
  }

  match = new RegExp(`^pilot-(\\d+): actual n=(\\d+), observed lift=${numeric}; (.+)$`).exec(raw)
  if (match) {
    const after = decision(match[4])
    const observed = Number(match[3])
    if (!Number.isFinite(observed)) return null
    return explanation(`Проверка ${number(Number(match[1]))} завершена`, `В проверке участвовало абонентов: ${number(Number(match[2]))}. Наблюдаемый прирост выручки: ${percent(observed)}. Результат небольшой выборки может содержать случайный шум. ${after.text}`, raw, after.recognized)
  }

  match = new RegExp(`^(\\d+) final campaigns; forecast net including pilots ${numeric} CU\\.$`).exec(raw)
  if (match && Number.isFinite(Number(match[2]))) return explanation('План обновлён после проверки', `Предложений в текущем плане: ${number(Number(match[1]))}. Ожидаемый чистый прирост выручки за весь запуск, включая проверки и расходы на связь: ${money(Number(match[2]))}. Это прогноз, который может измениться после следующих проверок.`, raw)

  match = new RegExp(`^(\\d+) campaigns, (\\d+) successful pilots, runtime ${numeric}s\\. Official evaluation runs separately\\.$`).exec(raw)
  if (match && Number.isFinite(Number(match[3]))) return explanation('Итоговый план проверен', `Предложений в плане: ${number(Number(match[1]))}. Завершённых проверок: ${number(Number(match[2]))}. Время расчёта: ${decimal.format(Number(match[3]))} с. План прошёл проверку допустимости; результат симуляции рассчитывается отдельно.`, raw)
  return null
}

export function explainPhaseMessage(phase: Phase, raw: string): Explanation {
  return knownMessage(raw) ?? fallback(phaseTitles[phase], raw, phase === 'failed' ? 'Не удалось завершить расчёт. Причина сбоя сохранена в технических сведениях об ошибке.' : undefined)
}

export function explainEvent(event: DecisionEvent): Explanation {
  const result = knownMessage(event.message)
  if (result) return { ...result, raw: `${event.title}\n${event.message}` }
  const title = plainRussian(event.title) ?? phaseTitles[event.phase]
  return { ...fallback(title, event.message), raw: `${event.title}\n${event.message}` }
}

export function explainCampaignReason(raw: string): Explanation {
  let match = new RegExp(`^Posterior lift ${numeric}, standard deviation ${numeric}\\.$`).exec(raw)
  if (match && [match[1], match[2]].every(value => Number.isFinite(Number(value)))) {
    return explanation('Ожидаемый эффект и неопределённость', `Модель ожидает прирост выручки ${percent(Number(match[1]))}. Неопределённость оценки (стандартное отклонение): ${decimal.format(Number(match[2]) * 100)} процентного пункта. Чем больше этот показатель, тем менее уверенной является оценка; это не гарантированный результат.`, raw)
  }
  match = new RegExp(`^Executable ID-ordered audience: (\\d+); marginal expected net: ${numeric} CU\\.$`).exec(raw)
  if (match && Number.isFinite(Number(match[2]))) {
    return explanation('Кого охватит предложение и какой вклад ожидается', `Абонентов в доступной группе: ${number(Number(match[1]))}. Ожидаемый дополнительный чистый вклад этого предложения в общий план: ${money(Number(match[2]))}. Учтены его расходы на связь и уже выбранные предложения. Абоненты выбираются по порядку идентификаторов.`, raw)
  }
  if (raw === 'Selection accounts for previous campaigns, estimated pilot overlap, contacts and budget.') {
    return explanation('Почему предложение подходит общему плану', 'При выборе учтены уже добавленные предложения, возможное повторное обращение к участникам проверок, оставшийся бюджет и лимит контактов.', raw)
  }
  return fallback('Основание для выбора предложения', raw)
}

export function explainCampaignWarning(raw: string): Explanation {
  if (raw === 'Historical prior only; no direct pilot evidence.') {
    return explanation('Нужна дополнительная проверка', 'Для этого предложения нет прямого подтверждения небольшой проверкой. Оценка опирается на историю переходов между тарифами. Выводы предварительные; для уверенного выбора нужны дополнительные проверки.', raw)
  }
  if (raw === 'Required nonempty fallback: minimum estimated damage under the selected risk penalty; gain is not guaranteed.') {
    return explanation('Выгодный вариант с учётом риска не найден', 'Условия задачи требуют хотя бы одно предложение. Система выбрала допустимый вариант с наименьшим оценённым ущербом при выбранной осторожности. Положительный эффект не гарантирован; этот вариант нужно пересмотреть.', raw)
  }
  return fallback('На что обратить внимание', raw)
}

const noticeMessages: Record<string, { title: string; text: string }> = {
  SYNTHETIC_DATA: { title: 'Учебные данные', text: 'Абоненты и результаты в этом наборе данных искусственные. Симуляция помогает сравнить варианты, но не предсказывает результат реальной рассылки.' },
  INVALID_CURRENT_TARIFF: { title: 'Нужно уточнить текущий тариф', text: 'У части абонентов тариф не указан или отсутствует в справочнике. Они исключены из адресных предложений. Проверьте и заполните их текущий тариф в исходных данных.' },
  INVALID_ARPU_SEGMENT: { title: 'Нужно уточнить группу по выручке', text: 'У части абонентов нет корректной группы по выручке. Они исключены из адресных предложений. Проверьте и заполните эту группу в исходных данных.' },
  MISSING_DATA_SEGMENT: { title: 'Не хватает данных об использовании интернета', text: 'Эти абоненты остаются в общих группах, но их нельзя отбирать по использованию интернета. Заполните данные, если нужен такой отбор.' },
  MISSING_CALL_SEGMENT: { title: 'Не хватает данных об использовании звонков', text: 'Эти абоненты остаются в общих группах, но их нельзя отбирать по использованию звонков. Заполните данные, если нужен такой отбор.' },
  INELIGIBLE_CUSTOMERS: { title: 'Часть абонентов исключена из подбора', text: 'Не указан или не распознан текущий тариф либо группа по выручке. Уточните эти поля в исходных данных, чтобы включить абонентов в адресные предложения.' },
  OPTIONAL_SEGMENTS_MISSING: { title: 'Доступны не все способы отбора аудитории', text: 'У части абонентов не указаны группы по использованию интернета или звонков. Они доступны в общих группах, но не попадают в отбор по недостающим признакам.' },
  HISTORY_UNAVAILABLE: { title: 'История переходов недоступна', text: 'Система не смогла использовать историю переходов между тарифами и начала с нейтральной оценки. Проверьте файл истории; текущие выводы нужно оценивать с учётом этого ограничения.' },
  FORECAST_APPROXIMATION: { title: 'Прогноз содержит приблизительные оценки', text: 'Точные участники небольших проверок недоступны. Повторные обращения к одним и тем же абонентам оценены приблизительно. Надёжный диапазон прогноза не рассчитан; сравните прогноз с результатом симуляции.' },
  TIME_RESERVE: { title: 'Проверки завершены по ограничению времени', text: 'Система остановила дополнительные проверки, оставив 30 секунд на итоговую проверку плана. Часть возможных предложений могла остаться непроверенной.' },
  PILOT_FAILED: { title: 'Одна из проверок не завершилась', text: 'Проверку предложения не удалось выполнить. Система исключила этот вариант из следующих проверок и пересчитала план с учётом оставшихся ресурсов. Причина сбоя сохранена в технических деталях.' },
  OBSERVER_FAILED: { title: 'Возник сбой передачи хода расчёта', text: 'Одно из обновлений прогресса не удалось передать. Это сообщение само по себе не означает, что расчёт остановился. Проверьте текущий статус и итоговый результат.' },
  REQUIRED_FALLBACK: { title: 'План требует пересмотра перед запуском', text: 'С учётом выбранной осторожности выгодного плана не найдено. Условия задачи требуют хотя бы одно предложение, поэтому сохранён вариант с наименьшим оценённым ущербом. Не считайте его рекомендацией к реальной рассылке.' },
  NEGATIVE_FORECAST: { title: 'Общий прогноз ниже нуля', text: 'Ожидаемый эффект всего запуска отрицательный. В него входят и пробные проверки, и итоговые предложения. Посмотрите их вклад и расходы в разборе результата.' },
}

export function explainNotice(notice: Notice): Explanation {
  const known = noticeMessages[notice.code]
  return known ? explanation(known.title, known.text, notice.message) : fallback('Комментарий к данным или расчёту', notice.message)
}

export function explainExclusionReason(raw: string): Explanation {
  if (/current_tariff/.test(raw) && /arpu_segment/.test(raw)) {
    return explanation('Почему часть абонентов не участвует', 'Чтобы подобрать новое предложение, нужно знать текущий тариф и группу абонента по выручке. Если эти данные отсутствуют или не распознаны, абонент не участвует в подборе. Исходные записи сохранены — их можно уточнить и использовать в следующем расчёте.', raw)
  }
  return fallback('Почему часть абонентов не участвует', raw)
}
