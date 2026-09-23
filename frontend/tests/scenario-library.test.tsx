import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Overview } from '../src/lib/api/types'
import type { ScenarioInput } from '../src/lib/scenarioCalculator'
import { ScenarioLibrary } from '../src/features/calculator/ScenarioLibrary'
import {
  calculateSensitivity, createScenarioUrl, isScenarioParameters, matchingGroupIndex, parseSharedScenario,
  readSavedScenarios, scenarioCompatibility, SCENARIO_STORAGE_KEY, writeSavedScenarios,
  type ScenarioParameters, type SavedScenario,
} from '../src/features/calculator/calculatorScenarioStore'

const parameters: ScenarioParameters = { version: 1, datasetId: 'dataset-1', mode: 'demo', group: { tariff: 'tariff_2', arpu: 'HIGH' }, channel: 'sms', contacts: 100, budget: 345.67, conversion: 12.345, lift: -7.89, spread: 3.456 }
const overview: Overview = {
  mode: 'demo', currency: 'CU',
  dataset: { id: 'dataset-1', customer_count: 1000, eligible_customer_count: 1000, excluded_customer_count: 0, exclusion_reason: '', baseline_revenue: 100000, notices: [] },
  limits: { budget: 10000, contacts: 1000, customers_per_campaign: 1000, pilots: 20, final_campaigns: 10, pilot_size_min: 10, pilot_size_max: 100 },
  channels: [{ code: 'sms', label: 'SMS', cost_per_contact: 4, conversion_multiplier: 0.65 }], tariffs: [],
  segments: [
    { current_tariff: 'tariff_1', arpu_segment: 'HIGH', customer_count: 500, baseline_revenue: 50000, average_predicted_arpu: 100, eligible: true },
    { current_tariff: 'tariff_2', arpu_segment: 'HIGH', customer_count: 500, baseline_revenue: 50000, average_predicted_arpu: 100, eligible: true },
  ],
}
const saved: SavedScenario = { id: 'one', name: 'Проверка', note: 'Точная заметка', createdAt: '2026-09-23T10:00:00Z', parameters }
const input: ScenarioInput = { requestedContacts: 100, audienceSize: 500, averageRevenue: 1000, conversionRate: 0.1, revenueLift: 0.2, costPerContact: 4, conversionMultiplier: 1, budget: 1000, contactLimit: 1000, campaignLimit: 1000 }

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('shared and saved calculator conditions', () => {
  it('round-trips all precise parameters without title/note or stale query/hash', () => {
    const url = new URL(createScenarioUrl(parameters, 'http://localhost:8080/calculator?old=true#result'))
    expect(url.hash).toBe('')
    expect([...url.searchParams.keys()]).toEqual(['scenario'])
    expect(parseSharedScenario(url.search)).toEqual({ parameters, error: null })
  })
  it('finds a group by its source identity after array reorder', () => {
    expect(matchingGroupIndex(parameters, overview)).toBe(1)
    const reordered = { ...overview, segments: [...overview.segments].reverse() }
    expect(matchingGroupIndex(parameters, reordered)).toBe(0)
    expect(scenarioCompatibility(parameters, reordered)).toBeNull()
  })
  it.each([
    ['different dataset', { ...parameters, datasetId: 'another' }],
    ['different mode', { ...parameters, mode: 'local_simulation' }],
    ['unknown group', { ...parameters, group: { tariff: 'missing', arpu: 'HIGH' } }],
    ['missing channel', { ...parameters, channel: 'call' }],
    ['new contact limit', { ...parameters, contacts: 501 }],
    ['new budget limit', { ...parameters, budget: 10001 }],
  ])('does not silently apply a scenario with %s', (_, value) => {
    expect(scenarioCompatibility(value as ScenarioParameters, overview)).toBeTruthy()
  })
  it.each(['?scenario=', '?scenario=garbage', '?scenario=%7B%7D', '?scenario=null', '?scenario=%5B%5D', `?scenario=${JSON.stringify({ ...parameters, conversion: 101 })}`, `?scenario=${JSON.stringify(parameters)}&scenario=${JSON.stringify(parameters)}`])('rejects malformed query %s', query => {
    const result = parseSharedScenario(query)
    expect(result.parameters).toBeNull()
    expect(result.error).toContain('повреждены')
  })
  it('allows ordinary navigation without a shared scenario', () => expect(parseSharedScenario('?other=1')).toEqual({ parameters: null, error: null }))
  it.each([{ contacts: 1.5 }, { spread: -1 }, { lift: -101 }, { budget: Infinity }, { channel: '__proto__' }, { datasetId: '' }, { group: { tariff: 3, arpu: null } }])('rejects invalid numeric and identity data %j', bad => {
    expect(isScenarioParameters({ ...parameters, ...bad })).toBe(false)
  })
  it('stores named scenarios with notes and precise parameters', () => {
    expect(writeSavedScenarios(localStorage, [saved])).toBeNull()
    expect(readSavedScenarios(localStorage)).toEqual({ items: [saved], error: null })
  })
  it('leaves corrupt storage unchanged instead of dropping saved data', () => {
    localStorage.setItem(SCENARIO_STORAGE_KEY, '{damaged')
    expect(readSavedScenarios(localStorage).error).toBeTruthy()
    expect(localStorage.getItem(SCENARIO_STORAGE_KEY)).toBe('{damaged')
  })
  it('reports unavailable storage and quota failure truthfully', () => {
    expect(readSavedScenarios({ getItem: () => { throw new Error('blocked') } }).error).toBeTruthy()
    expect(writeSavedScenarios({ setItem: () => { throw new Error('full') } }, [saved])).toContain('остался прежним')
  })
  it('does not show a saved item or success when browser refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    render(<ScenarioLibrary parameters={parameters} overview={overview} onLoad={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Название сценария'), { target: { value: 'Новый вариант' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить сценарий' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Список остался прежним')
    expect(screen.queryByRole('button', { name: 'Загрузить сценарий Новый вариант' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('does not overwrite unreadable data when a save is requested', () => {
    localStorage.setItem(SCENARIO_STORAGE_KEY, 'not-json')
    render(<ScenarioLibrary parameters={parameters} overview={overview} onLoad={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Название сценария'), { target: { value: 'Новый вариант' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить сценарий' }))
    expect(localStorage.getItem(SCENARIO_STORAGE_KEY)).toBe('not-json')
  })
  it('saves, loads precise conditions and deletes only the chosen item', () => {
    const onLoad = vi.fn()
    render(<ScenarioLibrary parameters={parameters} overview={overview} onLoad={onLoad} />)
    fireEvent.change(screen.getByLabelText('Название сценария'), { target: { value: 'Точный вариант' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить сценарий' }))
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить сценарий Точный вариант' }))
    expect(onLoad).toHaveBeenCalledWith(parameters)
    expect(readSavedScenarios(localStorage).items).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Удалить сценарий Точный вариант' }))
    expect(readSavedScenarios(localStorage).items).toHaveLength(0)
  })
})

describe('three sensitivity scenarios', () => {
  it('uses the explicit percentage-point step and the same costs', () => {
    const result = calculateSensitivity(input, 5)!
    expect(result.cautious.conversionRate).toBeCloseTo(0.05)
    expect(result.optimistic.conversionRate).toBeCloseTo(0.15)
    expect(result.cautious.result.netGain).toBeCloseTo(600)
    expect(result.base.result.netGain).toBeCloseTo(1600)
    expect(result.optimistic.result.netGain).toBeCloseTo(2600)
  })
  it('reverses probability ordering for a negative revenue change', () => {
    const result = calculateSensitivity({ ...input, revenueLift: -0.2 }, 5)!
    expect(result.cautious.conversionRate).toBeCloseTo(0.15)
    expect(result.optimistic.conversionRate).toBeCloseTo(0.05)
    expect(result.cautious.result.netGain).toBeLessThan(result.base.result.netGain)
    expect(result.optimistic.result.netGain).toBeGreaterThan(result.base.result.netGain)
  })
  it('clips probability endpoints and keeps the base case unchanged', () => {
    const result = calculateSensitivity(input, 100)!
    expect(result.cautious.conversionRate).toBe(0)
    expect(result.optimistic.conversionRate).toBe(1)
    expect(result.base.conversionRate).toBe(0.1)
  })
  it('handles zero and saturated responses without claiming a difference', () => {
    expect(calculateSensitivity(input, 0)!.cautious.result.netGain).toBe(calculateSensitivity(input, 0)!.optimistic.result.netGain)
    const saturated = calculateSensitivity({ ...input, conversionRate: 0.9, conversionMultiplier: 2 }, 5)!
    expect(saturated.cautious.result.netGain).toBe(saturated.optimistic.result.netGain)
  })
  it.each([NaN, -1, 101, Infinity])('rejects invalid spread %s', spread => expect(calculateSensitivity(input, spread)).toBeNull())
})
