import type { Channel, Overview } from '../../lib/api/types'
import { calculateScenario, type ScenarioInput } from '../../lib/scenarioCalculator'

export const SCENARIO_STORAGE_KEY = 'orbitduo-calculator-scenarios-v1'
export const MAX_SAVED_SCENARIOS = 40

export interface ScenarioParameters {
  version: 1
  datasetId: string
  mode: Overview['mode']
  group: { tariff: string | null; arpu: string | null } | null
  channel: Channel
  contacts: number
  budget: number
  conversion: number
  lift: number
  spread: number
}

export interface SavedScenario {
  id: string
  name: string
  note: string
  createdAt: string
  parameters: ScenarioParameters
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finiteRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const nullableString = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 200)

export function isScenarioParameters(value: unknown): value is ScenarioParameters {
  if (!record(value)) return false
  return value.version === 1 && typeof value.datasetId === 'string' && value.datasetId.length > 0 && value.datasetId.length <= 200
    && (value.mode === 'demo' || value.mode === 'local_simulation')
    && (value.group === null || (record(value.group) && nullableString(value.group.tariff) && nullableString(value.group.arpu)))
    && ['push', 'sms', 'digital_ads', 'call'].includes(String(value.channel))
    && Number.isSafeInteger(value.contacts) && finiteRange(value.contacts, 0, Number.MAX_SAFE_INTEGER)
    && finiteRange(value.budget, 0, Number.MAX_SAFE_INTEGER)
    && finiteRange(value.conversion, 0, 100) && finiteRange(value.lift, -100, 100) && finiteRange(value.spread, 0, 100)
}

/** Group identity uses source fields, never a position in the API array. */
export function matchingGroupIndex(parameters: ScenarioParameters, overview: Overview): number {
  if (!parameters.group) return -1
  return overview.segments.filter(group => group.eligible && group.customer_count > 0).findIndex(group => group.current_tariff === parameters.group?.tariff && group.arpu_segment === parameters.group?.arpu)
}

export function scenarioCompatibility(parameters: ScenarioParameters, overview: Overview): string | null {
  if (parameters.datasetId !== overview.dataset.id || parameters.mode !== overview.mode) return 'Сценарий создан для другого набора данных или режима. Параметры не применены: результат нельзя воспроизвести на текущих данных.'
  const eligible = overview.segments.filter(group => group.eligible && group.customer_count > 0)
  const index = matchingGroupIndex(parameters, overview)
  if (parameters.group && index < 0) return 'Группа из сценария больше не доступна. Параметры не применены; выберите аудиторию заново.'
  if (!overview.channels.some(channel => channel.code === parameters.channel)) return 'Способ связи из сценария недоступен в текущих данных. Параметры не применены.'
  const audience = parameters.group ? eligible[index].customer_count : eligible.reduce((sum, group) => sum + group.customer_count, 0)
  if (parameters.contacts > Math.min(audience, overview.limits.contacts, overview.limits.customers_per_campaign) || parameters.budget > overview.limits.budget) return 'Сценарий превышает текущий размер аудитории или лимиты. Параметры не применены, чтобы не изменить их незаметно.'
  return null
}

export function parseSharedScenario(search: string): { parameters: ScenarioParameters | null; error: string | null } {
  const query = new URLSearchParams(search)
  if (!query.has('scenario')) return { parameters: null, error: null }
  const raw = query.get('scenario') || ''
  try {
    if (query.getAll('scenario').length !== 1 || raw.length > 5000) throw new Error('Invalid scenario')
    const parameters: unknown = JSON.parse(raw)
    if (!isScenarioParameters(parameters)) throw new Error('Invalid scenario')
    return { parameters, error: null }
  } catch {
    return { parameters: null, error: 'Не удалось открыть сценарий из ссылки: параметры повреждены или версия не поддерживается. Показан стартовый пример.' }
  }
}

export function createScenarioUrl(parameters: ScenarioParameters, currentUrl: string): string {
  const url = new URL(currentUrl)
  url.pathname = '/calculator'
  url.search = ''
  url.hash = ''
  url.searchParams.set('scenario', JSON.stringify(parameters))
  return url.toString()
}

function isSavedScenario(value: unknown): value is SavedScenario {
  return record(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 100
    && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 80
    && typeof value.note === 'string' && value.note.length <= 600
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && isScenarioParameters(value.parameters)
}

export function readSavedScenarios(storage: Pick<Storage, 'getItem'>): { items: SavedScenario[]; error: string | null } {
  try {
    const raw = storage.getItem(SCENARIO_STORAGE_KEY)
    if (raw === null) return { items: [], error: null }
    if (raw.length > 250000) throw new Error('Too large')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length > MAX_SAVED_SCENARIOS || !parsed.every(isSavedScenario) || new Set(parsed.map(item => item.id)).size !== parsed.length) throw new Error('Invalid storage')
    return { items: parsed, error: null }
  } catch {
    return { items: [], error: 'Не удалось прочитать сохранённые сценарии. Браузер ограничил доступ или данные повреждены. Хранилище не изменено; используйте ссылку на сценарий.' }
  }
}

export function writeSavedScenarios(storage: Pick<Storage, 'setItem'>, items: SavedScenario[]): string | null {
  try {
    if (items.length > MAX_SAVED_SCENARIOS || !items.every(isSavedScenario)) return 'Не удалось сохранить сценарии: проверьте название, заметку и параметры.'
    storage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(items))
    return null
  } catch {
    return 'Браузер не разрешил сохранить изменения. Список остался прежним. Освободите место или скопируйте ссылку на сценарий.'
  }
}

/** Sensitivity of the same formula, not a confidence interval or trained forecast. */
export function calculateSensitivity(input: ScenarioInput, spreadPercentagePoints: number) {
  if (!Number.isFinite(spreadPercentagePoints) || spreadPercentagePoints < 0 || spreadPercentagePoints > 100 || !calculateScenario(input).valid) return null
  const step = spreadPercentagePoints / 100
  const variants = [Math.max(0, input.conversionRate - step), Math.min(1, input.conversionRate + step)]
    .map(conversionRate => ({ conversionRate, result: calculateScenario({ ...input, conversionRate }) }))
    .sort((a, b) => a.result.netGain - b.result.netGain)
  return {
    cautious: variants[0],
    base: { conversionRate: input.conversionRate, result: calculateScenario(input) },
    optimistic: variants[1],
  }
}
