import { describe, expect, it } from 'vitest'
import { calculateScenario, type ScenarioInput } from '../src/lib/scenarioCalculator'

const defaults: ScenarioInput = {
  requestedContacts: 1_000,
  audienceSize: 10_000,
  averageRevenue: 500,
  conversionRate: 0.2,
  revenueLift: 0.3,
  costPerContact: 5,
  conversionMultiplier: 1.5,
  budget: 50_000,
  contactLimit: 10_000,
  campaignLimit: 5_000,
}

function scenario(overrides: Partial<ScenarioInput> = {}) {
  return calculateScenario({ ...defaults, ...overrides })
}

describe('preliminary scenario calculator', () => {
  it('calculates additional revenue and subtracts the cost of every contact', () => {
    const result = scenario()
    expect(result.valid).toBe(true)
    expect(result.error).toBeNull()
    expect(result.contacts).toBe(1_000)
    expect(result.effectiveConversion).toBeCloseTo(0.3)
    expect(result.expectedConversions).toBeCloseTo(300)
    expect(result.baselineRevenue).toBe(500_000)
    expect(result.grossGain).toBeCloseTo(45_000)
    expect(result.communicationCost).toBe(5_000)
    expect(result.netGain).toBeCloseTo(40_000)
    expect(result.remainingBudget).toBe(45_000)
    expect(result.limitedBy).toEqual([])
    expect(result.breakEvenConversion).toBeCloseTo(5 / (500 * 0.3 * 1.5))
  })

  it('caps conversion at 100% before calculating revenue and break-even', () => {
    const result = scenario({ conversionRate: 0.8, conversionMultiplier: 2 })
    expect(result.effectiveConversion).toBe(1)
    expect(result.expectedConversions).toBe(1_000)
    expect(result.grossGain).toBe(150_000)
    expect(result.netGain).toBe(145_000)
    expect(result.breakEvenConversion).toBeCloseTo(1 / 60)
  })

  it.each([
    ['audienceSize', 'audience'],
    ['contactLimit', 'contacts'],
    ['campaignLimit', 'campaign'],
  ] as const)('respects %s and recalculates all totals for the actual audience', (field, limitation) => {
    const result = scenario({ [field]: 300 })
    expect(result.contacts).toBe(300)
    expect(result.requestedContacts).toBe(1_000)
    expect(result.expectedConversions).toBeCloseTo(90)
    expect(result.grossGain).toBeCloseTo(13_500)
    expect(result.communicationCost).toBe(1_500)
    expect(result.netGain).toBeCloseTo(12_000)
    expect(result.limitedBy).toEqual([limitation])
  })

  it('spends only the affordable whole number of contacts', () => {
    const result = scenario({ budget: 1_002 })
    expect(result.contacts).toBe(200)
    expect(result.communicationCost).toBe(1_000)
    expect(result.remainingBudget).toBe(2)
    expect(result.netGain).toBeCloseTo(8_000)
    expect(result.limitedBy).toEqual(['budget'])
  })

  it('reports all equally binding limits without calling a nonbinding cap a limitation', () => {
    expect(scenario({ audienceSize: 200, contactLimit: 200, campaignLimit: 200, budget: 1_000 }).limitedBy)
      .toEqual(['audience', 'contacts', 'campaign', 'budget'])
    expect(scenario({ requestedContacts: 200, audienceSize: 200, contactLimit: 200, campaignLimit: 200, budget: 1_000 }).limitedBy)
      .toEqual([])
    expect(scenario({ audienceSize: 300, contactLimit: 200, budget: 1_000 }).limitedBy)
      .toEqual(['contacts', 'budget'])
  })

  it('does not lose a contact to decimal floating point rounding at the budget boundary', () => {
    const result = scenario({ requestedContacts: 5, budget: 0.3, costPerContact: 0.1 })
    expect(result.contacts).toBe(3)
    expect(result.communicationCost).toBe(0.3)
    expect(result.remainingBudget).toBe(0)
    expect(result.limitedBy).toEqual(['budget'])
    expect(scenario({ budget: 0.299, costPerContact: 0.1 }).contacts).toBe(2)
  })

  it('allows a free channel without dividing by zero or consuming the budget', () => {
    const result = scenario({ costPerContact: 0, budget: 0 })
    expect(result.contacts).toBe(1_000)
    expect(result.communicationCost).toBe(0)
    expect(result.netGain).toBeCloseTo(45_000)
    expect(result.remainingBudget).toBe(0)
    expect(result.limitedBy).toEqual([])
    expect(result.breakEvenConversion).toBe(0)
  })

  it('keeps negative revenue effects negative, including free contacts', () => {
    const result = scenario({ revenueLift: -0.2 })
    expect(result.grossGain).toBeCloseTo(-30_000)
    expect(result.netGain).toBeCloseTo(-35_000)
    expect(result.breakEvenConversion).toBeNull()
    expect(result.breakEvenMessage).toContain('При снижении выручки')
    const free = scenario({ revenueLift: -0.2, costPerContact: 0 })
    expect(free.netGain).toBeCloseTo(-30_000)
    expect(free.breakEvenConversion).toBeNull()
  })

  it.each([
    { conversionRate: 0 },
    { revenueLift: 0 },
    { averageRevenue: 0 },
    { conversionMultiplier: 0 },
  ])('charges for contacts even when no extra revenue is expected: %j', (overrides) => {
    const result = scenario(overrides)
    expect(result.grossGain).toBe(0)
    expect(result.communicationCost).toBe(5_000)
    expect(result.netGain).toBe(-5_000)
    if (!('conversionRate' in overrides)) expect(result.breakEvenConversion).toBeNull()
  })

  it.each([
    { requestedContacts: 0 },
    { audienceSize: 0 },
    { contactLimit: 0 },
    { campaignLimit: 0 },
    { budget: 0 },
    { budget: 4.99 },
  ])('has no costs, revenue or break-even threshold without contacts: %j', (overrides) => {
    const result = scenario(overrides)
    expect(result.valid).toBe(true)
    expect(result.contacts).toBe(0)
    expect(result.expectedConversions).toBe(0)
    expect(result.baselineRevenue).toBe(0)
    expect(result.grossGain).toBe(0)
    expect(result.communicationCost).toBe(0)
    expect(result.netGain).toBe(0)
    expect(result.remainingBudget).toBe(overrides.budget ?? defaults.budget)
    expect(result.breakEvenConversion).toBeNull()
    expect(result.breakEvenMessage).toContain('Нет получателей')
  })

  it('distinguishes a zero-cost, zero-effect scenario from an unreachable break-even threshold', () => {
    const result = scenario({ costPerContact: 0, revenueLift: 0 })
    expect(result.netGain).toBe(0)
    expect(result.breakEvenConversion).toBe(0)
    expect(result.breakEvenMessage).toContain('Контакты бесплатны')
  })

  it('uses the channel multiplier for a reachable break-even threshold', () => {
    const result = scenario({ averageRevenue: 100, revenueLift: 0.2, costPerContact: 5, conversionMultiplier: 0.5 })
    expect(result.breakEvenConversion).toBe(0.5)
    expect(scenario({ averageRevenue: 100, revenueLift: 0.2, costPerContact: 5, conversionMultiplier: 0.5, conversionRate: 0.5 }).netGain).toBe(0)
  })

  it('allows exactly zero net gain at the maximum possible conversion', () => {
    const result = scenario({ averageRevenue: 100, revenueLift: 0.2, costPerContact: 20, conversionMultiplier: 2, conversionRate: 0.5 })
    expect(result.breakEvenConversion).toBe(0.5)
    expect(result.netGain).toBe(0)
    const weakChannel = scenario({ averageRevenue: 100, revenueLift: 0.2, costPerContact: 10, conversionMultiplier: 0.5, conversionRate: 1 })
    expect(weakChannel.breakEvenConversion).toBe(1)
    expect(weakChannel.netGain).toBe(0)
  })

  it('does not call a decimal break-even boundary unreachable because of rounding', () => {
    const result = scenario({ averageRevenue: 3, revenueLift: 0.3, costPerContact: 0.9, conversionMultiplier: 1, conversionRate: 1 })
    expect(result.breakEvenConversion).toBe(1)
    expect(result.netGain).toBeCloseTo(0, 10)
  })

  it.each([
    { costPerContact: 151, conversionMultiplier: 2 },
    { costPerContact: 76, conversionMultiplier: 0.5 },
  ])('does not invent break-even beyond attainable conversion: %j', (overrides) => {
    const result = scenario(overrides)
    expect(result.breakEvenConversion).toBeNull()
    expect(result.breakEvenMessage).toContain('Даже при максимальной вероятности')
  })

  it.each(Object.keys(defaults) as (keyof ScenarioInput)[])('rejects non-finite %s without leaking non-finite outputs', (field) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const result = scenario({ [field]: value })
      expect(result.valid).toBe(false)
      expect(result.error).toBeTruthy()
      expect(Object.values(result).filter((entry) => typeof entry === 'number').every(Number.isFinite)).toBe(true)
    }
  })

  it.each(Object.keys(defaults).filter((field) => field !== 'revenueLift') as (keyof ScenarioInput)[])('rejects negative %s', (field) => {
    expect(scenario({ [field]: -1 }).valid).toBe(false)
  })

  it.each(['requestedContacts', 'audienceSize', 'contactLimit', 'campaignLimit'] as const)('requires safe, whole counts for %s', (field) => {
    expect(scenario({ [field]: 0.5 }).valid).toBe(false)
    expect(scenario({ [field]: Number.MAX_SAFE_INTEGER + 1 }).valid).toBe(false)
  })

  it('rejects percentages outside the model bounds', () => {
    expect(scenario({ conversionRate: 1.01 }).valid).toBe(false)
    expect(scenario({ revenueLift: 1.01 }).valid).toBe(false)
    expect(scenario({ revenueLift: -1.01 }).valid).toBe(false)
    expect(scenario({ conversionRate: 1, revenueLift: 1 }).valid).toBe(true)
    expect(scenario({ revenueLift: -1 }).valid).toBe(true)
  })

  it('rejects missing and nonnumeric runtime values without throwing', () => {
    expect(calculateScenario(null as unknown as ScenarioInput).valid).toBe(false)
    expect(calculateScenario({} as ScenarioInput).valid).toBe(false)
    expect(scenario({ budget: '100' as unknown as number }).valid).toBe(false)
  })

  it('rejects arithmetic overflow instead of presenting an infinite gain', () => {
    const result = scenario({ averageRevenue: Number.MAX_VALUE })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('слишком велики')
    expect(result.netGain).toBe(0)
  })

  it('handles extreme finite multipliers and near-zero channel costs', () => {
    const result = scenario({ conversionMultiplier: Number.MAX_VALUE, costPerContact: Number.MIN_VALUE })
    expect(result.valid).toBe(true)
    expect(result.contacts).toBe(1_000)
    expect(result.effectiveConversion).toBe(1)
    expect(result.netGain).toBe(150_000)
    expect(Number.isFinite(result.breakEvenConversion)).toBe(true)
    const noTransitions = scenario({ conversionMultiplier: Number.MAX_VALUE, conversionRate: 0 })
    expect(noTransitions.effectiveConversion).toBe(0)
    expect(noTransitions.netGain).toBe(-5_000)
  })
})
