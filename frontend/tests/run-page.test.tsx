import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { RunPage } from '../src/features/runs/RunPage'
import { api, ApiError } from '../src/lib/api/client'
import { buildSnapshot } from '../src/mocks/fixtures'
import type { RunSnapshot } from '../src/lib/api/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function completedRun() {
  return structuredClone(buildSnapshot({ id: 'test-run', config: { seed: 42, risk_profile: 'balanced' }, created_at: '2026-09-23T10:00:00Z', key: 'test-key' }, new Date('2026-09-23T10:01:00Z').getTime()))
}

function renderRun(run: RunSnapshot) {
  vi.spyOn(api, 'run').mockResolvedValue(run)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/runs/test-run']}><Routes><Route path="/runs/:id" element={<RunPage />} /></Routes></MemoryRouter></QueryClientProvider>)
}

it('sorts by execution order from the API and preserves it when sorting by contribution', async () => {
  const run = completedRun()
  run.campaigns.reverse()
  run.campaigns.find(item => item.execution_order === 1)!.expected_incremental_net_gain = null
  renderRun(run)
  await screen.findByRole('heading', { name: 'План готов' })
  const table = screen.getByRole('table')
  const orders = () => within(table).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[0].textContent)
  expect(orders()).toEqual(['1', '2', '3'])
  await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'gain')
  expect(orders()).toEqual(['2', '3', '1'])
})

it('retries the failed export using the same run and format', async () => {
  const download = vi.spyOn(api, 'download').mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 'Загрузка прервана')).mockResolvedValueOnce(undefined)
  renderRun(completedRun())
  const button = await screen.findByRole('button', { name: 'Скачать отчёт JSON' })
  const user = userEvent.setup()
  await user.click(button)
  const error = await screen.findByRole('alert')
  await user.click(within(error).getByRole('button', { name: /Повторить/ }))
  await screen.findByText('JSON передан браузеру. Файл доступен в загрузках.')
  expect(download.mock.calls).toEqual([['test-run', 'json'], ['test-run', 'json']])
})

it('shows warnings and preserves unknown budgets while handling a zero budget', async () => {
  const run = completedRun()
  run.resources.budget = { limit: 0, used_by_pilots: 0, planned_final: null, remaining_after_plan: null }
  run.campaigns[0].spec.filter_arpu_segment = null
  run.campaigns[0].spec.filter_current_tariff = null
  run.warnings = [{ code: 'LIMITED_DATA', severity: 'warning', message: 'Недостаточно наблюдений для части групп.', affected_count: 12 }]
  renderRun(run)
  await userEvent.setup().click(await screen.findByText(/Замечания к данным и расчёту/))
  expect(screen.getByText(/Недостаточно наблюдений для части групп/, { selector: 'p' })).toBeVisible()
  expect(screen.getByRole('img', { name: /Из бюджета/ })).toHaveAccessibleName(/финальный план Пока нет оценки, остаток Пока нет оценки/)
  expect(screen.getAllByText('Все уровни выручки · все текущие тарифы').length).toBeGreaterThan(0)
  for (const bar of screen.getByRole('img', { name: /Из бюджета/ }).children) expect(bar).toHaveStyle({ width: '0%' })
})

it('uses the last update to show elapsed time for a failed run without a completed timestamp', async () => {
  const run = completedRun()
  run.status = 'failed'
  run.phase = 'failed'
  run.completed_at = null
  run.updated_at = '2026-09-23T10:02:05Z'
  renderRun(run)
  expect(await screen.findByText('Длительность 2:05')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Скачать план CSV' })).toBeDisabled()
})
