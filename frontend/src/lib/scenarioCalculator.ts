export type ScenarioInput = {
  requestedContacts: number
  audienceSize: number
  averageRevenue: number
  conversionRate: number
  revenueLift: number
  costPerContact: number
  conversionMultiplier: number
  budget: number
  contactLimit: number
  campaignLimit: number
}

export type ScenarioLimit = 'audience' | 'contacts' | 'campaign' | 'budget'

export type ScenarioResult = {
  valid: boolean
  error: string | null
  contacts: number
  requestedContacts: number
  effectiveConversion: number
  expectedConversions: number
  baselineRevenue: number
  grossGain: number
  communicationCost: number
  netGain: number
  remainingBudget: number
  limitedBy: ScenarioLimit[]
  breakEvenConversion: number | null
  breakEvenMessage: string
}

const countFields = {
  requestedContacts: 'Число получателей',
  audienceSize: 'Размер аудитории',
  contactLimit: 'Общий лимит контактов',
  campaignLimit: 'Лимит контактов одного предложения',
} as const

const amountFields = {
  averageRevenue: 'Средняя выручка на человека',
  costPerContact: 'Цена одного контакта',
  conversionMultiplier: 'Коэффициент канала',
  budget: 'Бюджет',
} as const

function invalid(error: string): ScenarioResult {
  return {
    valid: false,
    error,
    contacts: 0,
    requestedContacts: 0,
    effectiveConversion: 0,
    expectedConversions: 0,
    baselineRevenue: 0,
    grossGain: 0,
    communicationCost: 0,
    netGain: 0,
    remainingBudget: 0,
    limitedBy: [],
    breakEvenConversion: null,
    breakEvenMessage: 'Исправьте параметры, чтобы узнать порог окупаемости.',
  }
}

function affordableContacts(budget: number, cost: number): number {
  if (cost === 0) return Number.MAX_SAFE_INTEGER
  const quotient = budget / cost
  if (quotient >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  const whole = Math.floor(quotient)
  // Decimal amounts such as 0.3 / 0.1 can round just below an integer.
  const nextCost = (whole + 1) * cost
  const tolerance = Number.EPSILON * Math.max(budget, nextCost)
  return Number.isFinite(nextCost) && Math.abs(nextCost - budget) <= tolerance
    ? whole + 1
    : whole
}

function breakEven(
  input: ScenarioInput,
  contacts: number,
): Pick<ScenarioResult, 'breakEvenConversion' | 'breakEvenMessage'> {
  if (contacts === 0) {
    return {
      breakEvenConversion: null,
      breakEvenMessage: 'Нет получателей: доход и расходы равны нулю. Сначала увеличьте доступное число контактов.',
    }
  }
  if (input.revenueLift < 0 && input.averageRevenue > 0 && input.conversionMultiplier > 0) {
    return {
      breakEvenConversion: null,
      breakEvenMessage: 'При снижении выручки переходы не окупают рассылку. Чем больше переходов, тем ниже результат.',
    }
  }
  if (input.costPerContact === 0) {
    return {
      breakEvenConversion: 0,
      breakEvenMessage: 'Контакты бесплатны: порог окупаемости — 0%. Положительный эффект появится только при переходах с ростом выручки.',
    }
  }
  const gainPerConversion = input.averageRevenue * input.revenueLift
  if (gainPerConversion <= 0 || input.conversionMultiplier === 0) {
    return {
      breakEvenConversion: null,
      breakEvenMessage: 'При этих условиях переходы не дают дополнительной выручки. Расходы на контакты не окупаются.',
    }
  }
  const requiredEffectiveConversion = input.costPerContact / gainPerConversion
  const highestEffectiveConversion = Math.min(input.conversionMultiplier, 1)
  const thresholdTolerance = Number.EPSILON * highestEffectiveConversion
  if (requiredEffectiveConversion - highestEffectiveConversion > thresholdTolerance) {
    return {
      breakEvenConversion: null,
      breakEvenMessage: 'Даже при максимальной вероятности перехода дополнительные поступления не покрывают стоимость контактов.',
    }
  }
  return {
    breakEvenConversion: Math.min(requiredEffectiveConversion, highestEffectiveConversion) / input.conversionMultiplier,
    breakEvenMessage: 'Это минимальная вероятность перехода до поправки на канал, при которой дополнительная выручка покрывает контакты.',
  }
}

/** One offer, one contact per person, and one revenue period. No pilots or overlaps. */
export function calculateScenario(input: ScenarioInput): ScenarioResult {
  if (!input || typeof input !== 'object') return invalid('Укажите параметры расчёта.')
  for (const [field, label] of Object.entries(countFields)) {
    const value = input[field as keyof typeof countFields]
    if (!Number.isSafeInteger(value) || value < 0) {
      return invalid(`${label}: укажите целое неотрицательное число.`)
    }
  }
  for (const [field, label] of Object.entries(amountFields)) {
    const value = input[field as keyof typeof amountFields]
    if (!Number.isFinite(value) || value < 0) {
      return invalid(`${label}: укажите конечное неотрицательное число.`)
    }
  }
  if (!Number.isFinite(input.conversionRate) || input.conversionRate < 0 || input.conversionRate > 1) {
    return invalid('Вероятность перехода должна быть от 0% до 100%.')
  }
  if (!Number.isFinite(input.revenueLift) || input.revenueLift < -1 || input.revenueLift > 1) {
    return invalid('Изменение выручки должно быть от −100% до 100%.')
  }

  const limits: [ScenarioLimit, number][] = [
    ['audience', input.audienceSize],
    ['contacts', input.contactLimit],
    ['campaign', input.campaignLimit],
    ['budget', affordableContacts(input.budget, input.costPerContact)],
  ]
  const contacts = Math.min(input.requestedContacts, ...limits.map(([, value]) => value))
  const effectiveConversion = Math.min(input.conversionRate * input.conversionMultiplier, 1)
  const expectedConversions = contacts * effectiveConversion
  const baselineRevenue = contacts * input.averageRevenue
  const grossGain = baselineRevenue * input.revenueLift * effectiveConversion
  // Clamp insignificant rounding overshoots of the budget (e.g. 3 × 0.1).
  const communicationCost = Math.min(contacts * input.costPerContact, input.budget)
  const netGain = grossGain - communicationCost
  const remainingBudget = input.budget - communicationCost
  if (![effectiveConversion, expectedConversions, baselineRevenue, grossGain, communicationCost, netGain, remainingBudget].every(Number.isFinite)) {
    return invalid('Значения слишком велики для точного расчёта. Уменьшите выручку или число получателей.')
  }

  return {
    valid: true,
    error: null,
    contacts,
    requestedContacts: input.requestedContacts,
    effectiveConversion,
    expectedConversions,
    baselineRevenue,
    grossGain: grossGain === 0 ? 0 : grossGain,
    communicationCost,
    netGain: netGain === 0 ? 0 : netGain,
    remainingBudget,
    limitedBy: contacts < input.requestedContacts
      ? limits.filter(([, value]) => value === contacts).map(([kind]) => kind)
      : [],
    ...breakEven(input, contacts),
  }
}
