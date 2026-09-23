import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { CompareRunsPage } from '../src/features/runs/CompareRunsPage'
import { RunsPage } from '../src/features/runs/RunsPage'
import { api, ApiError } from '../src/lib/api/client'
import { buildSnapshot } from '../src/mocks/fixtures'
import { campaignSignature, comparisonDifferences, parseComparisonIds } from '../src/lib/runComparison'
import { saveRunNote } from '../src/lib/runNotes'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

function fixture(id = 'one') {
  return structuredClone(buildSnapshot({ id, config: { seed: 42, risk_profile: 'balanced' }, created_at: '2026-09-23T10:00:00Z', key: id }, new Date('2026-09-23T10:01:00Z').getTime()))
}

function mount(element: React.ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{element}</MemoryRouter></QueryClientProvider>)
}

it.each([null, '', 'one', 'one,one', 'one,two,three,four', 'one,../../etc', 'one,,two'])('rejects invalid comparison inputs: %s', value => {
  expect(parseComparisonIds(value)).toBeNull()
})

it('accepts two or three unique IDs and removes duplicates', () => {
  expect(parseComparisonIds('one,two,one')).toEqual(['one', 'two'])
  expect(parseComparisonIds('one,two,three')).toEqual(['one', 'two', 'three'])
})

it('flags differing datasets, mode, seed, limits and unfinished results', () => {
  const a = fixture()
  const b = fixture('two')
  expect(comparisonDifferences([a, b])).toEqual([])
  b.dataset_id = 'other'; b.mode = 'local_simulation'; b.config.seed = 7; b.resources.budget.limit = 1; b.status = 'running'
  expect(comparisonDifferences([a, b])).toHaveLength(5)
})

it('compares every audience filter while ignoring textual order in filter lists', () => {
  const a = fixture().campaigns[0]
  const b = structuredClone(a)
  a.spec.filter_current_tariff = 'tariff_1;tariff_2'
  b.spec.filter_current_tariff = 'tariff_2;tariff_1'
  expect(campaignSignature(a)).toBe(campaignSignature(b))
  b.spec.filter_call_segment = 'HIGH'
  expect(campaignSignature(a)).not.toBe(campaignSignature(b))
})

it('does not request runs for an invalid comparison link', () => {
  const fetch = vi.spyOn(api, 'run')
  mount(<CompareRunsPage />, '/runs/compare?ids=one')
  expect(screen.getByRole('heading', { name: 'Выберите два или три расчёта' })).toBeVisible()
  expect(fetch).not.toHaveBeenCalled()
})

it('compares metrics, names and common proposals without claiming algorithm versions match', async () => {
  const a = fixture()
  const b = fixture('two')
  b.forecast = { ...b.forecast!, expected_net_gain: a.forecast!.expected_net_gain + 3000 }
  b.config.risk_profile = 'conservative'
  saveRunNote('one', { name: 'Мой первый', note: 'Для сравнения', favorite: false })
  vi.spyOn(api, 'run').mockImplementation(async id => id === 'one' ? a : b)
  mount(<CompareRunsPage />, '/runs/compare?ids=one,two')
  expect(await screen.findByText(/Совпадают набор данных/)).toBeVisible()
  const table = screen.getByRole('table')
  expect(within(table).getByRole('link', { name: 'Мой первый' })).toHaveAttribute('href', '/runs/one')
  expect(within(table).getByText('+3 000 у.е.')).toBeVisible()
  expect(screen.getByText(/Версия алгоритма в отчётах не сохранена/)).toBeVisible()
  expect(screen.getAllByText('Такие же условия в 2 вариантах').length).toBeGreaterThan(0)
})

it('keeps a loaded result visible if another result fails, without claiming complete comparison', async () => {
  vi.spyOn(api, 'run').mockImplementation(async id => { if (id === 'two') throw new ApiError('NOT_FOUND', 'Расчёт не найден'); return fixture() })
  mount(<CompareRunsPage />, '/runs/compare?ids=one,two')
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось обновить расчёт 2')
  expect(within(screen.getByRole('table')).getByText('План готов')).toBeVisible()
  expect(screen.getByText(/Для проверки условий нужны все выбранные расчёты/)).toBeVisible()
  expect(screen.queryByText('Такие условия только в этом варианте')).not.toBeInTheDocument()
})

it('limits history selection to three, keeps selected rows removable and builds the comparison link', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'runs').mockResolvedValue({ items: ['one', 'two', 'three', 'four'].map(fixture) })
  mount(<RunsPage />, '/runs')
  const choices = await screen.findAllByRole('checkbox')
  await user.click(choices[0]); await user.click(choices[1]); await user.click(choices[2])
  expect(choices[3]).toBeDisabled()
  expect(screen.getByRole('link', { name: 'Сравнить (3)' })).toHaveAttribute('href', '/runs/compare?ids=one,two,three')
  await user.click(choices[1])
  expect(choices[3]).toBeEnabled()
  expect(screen.getByRole('link', { name: 'Сравнить (2)' })).toHaveAttribute('href', '/runs/compare?ids=one,three')
})

it('preselects the run from its detail page even when it is outside the loaded history', async () => {
  vi.spyOn(api, 'runs').mockResolvedValue({ items: [fixture()] })
  mount(<RunsPage />, '/runs?compare=older-run')
  await userEvent.setup().click(await screen.findByRole('checkbox', { name: 'Сравнить расчёт one' }))
  expect(screen.getByRole('link', { name: 'Сравнить (2)' })).toHaveAttribute('href', '/runs/compare?ids=older-run,one')
})

it('searches saved notes and filters favorites without changing server data', async () => {
  const user = userEvent.setup()
  saveRunNote('one', { name: 'Для жюри', note: 'Проверить конверсию', favorite: true })
  saveRunNote('two', { name: 'Черновик', note: '', favorite: false })
  vi.spyOn(api, 'runs').mockResolvedValue({ items: [fixture(), fixture('two')] })
  mount(<RunsPage />, '/runs')
  await screen.findByText('Для жюри')
  await user.type(screen.getByRole('searchbox', { name: 'Найти запуск' }), 'конверсию')
  expect(screen.queryByText('Черновик')).not.toBeInTheDocument()
  await user.clear(screen.getByRole('searchbox', { name: 'Найти запуск' }))
  await user.click(screen.getByRole('button', { name: 'Только избранное' }))
  expect(screen.queryByText('Черновик')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Убрать из избранного: Для жюри' }))
  expect(screen.getByRole('heading', { name: 'Запуски не найдены' })).toBeVisible()
})
