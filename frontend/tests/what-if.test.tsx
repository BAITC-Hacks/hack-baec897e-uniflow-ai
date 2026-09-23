import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CampaignWhatIf } from '../src/features/runs/CampaignWhatIf'
import * as api from '../src/lib/api/whatIf'
import { ApiError } from '../src/lib/api/client'
import { buildSnapshot } from '../src/mocks/fixtures'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function run() {
  const snapshot = structuredClone(buildSnapshot({ id: 'what-if-test', config: { seed: 42, risk_profile: 'balanced' }, created_at: '2026-09-23T10:00:00Z', key: 'what-if' }, new Date('2026-09-23T10:01:00Z').getTime()))
  snapshot.mode = 'local_simulation'
  return snapshot
}

function result(): api.WhatIfResult {
  const totals = { gross_gain: 3000, net_gain: 2500, communication_cost: 500, total_contacts: 120, unique_customers: 100, remaining_budget: 99500, remaining_contacts: 14880 }
  return { run_id: 'what-if-test', label: 'local_simulation', excluded_campaign_ids: ['one'], retained_campaign_ids: ['two'], original: totals, alternative: { ...totals, net_gain: 2300 }, net_gain_difference: -200, campaigns: [], valid_final_plan: true, explanation: 'Пересчитано с учётом повторных контактов.' }
}

it('sends exact excluded IDs and removes a stale result when selection changes', async () => {
  const snapshot = run()
  const calculate = vi.spyOn(api, 'calculateWhatIf').mockResolvedValue(result())
  render(<CampaignWhatIf run={snapshot} />)
  const user = userEvent.setup()
  const submit = screen.getByRole('button', { name: 'Пересчитать вариант' })
  expect(submit).toBeDisabled()
  const checkboxes = screen.getAllByRole('checkbox')
  await user.click(checkboxes[0])
  await user.click(submit)
  expect(await screen.findByText('Изменение эффекта после расходов')).toBeVisible()
  expect(calculate).toHaveBeenCalledWith(snapshot.id, [snapshot.campaigns[0].id], expect.any(AbortSignal))
  expect(screen.getByText('В учебной проверке исключение предложений снизило результат.')).toBeVisible()
  await user.click(checkboxes[1])
  expect(screen.queryByText('Изменение эффекта после расходов')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Вернуть все' }))
  for (const checkbox of checkboxes) expect(checkbox).toBeChecked()
  expect(submit).toBeDisabled()
})

it('locks selection while pending and aborts requests on unmount', async () => {
  let signal: AbortSignal | undefined
  vi.spyOn(api, 'calculateWhatIf').mockImplementation((_id, _excluded, currentSignal) => {
    signal = currentSignal
    return new Promise(() => {})
  })
  const view = render(<CampaignWhatIf run={run()} />)
  const user = userEvent.setup()
  await user.click(screen.getAllByRole('checkbox')[0])
  await user.click(screen.getByRole('button', { name: 'Пересчитать вариант' }))
  expect(screen.getByRole('button', { name: 'Пересчитываем вариант…' })).toBeDisabled()
  expect(screen.getAllByRole('checkbox')[0]).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Повторяем сохранённые')
  view.unmount()
  expect(signal?.aborted).toBe(true)
})

it('shows retryable server errors and labels an empty alternative as exploratory', async () => {
  const calculate = vi.spyOn(api, 'calculateWhatIf').mockRejectedValueOnce(new ApiError('WHAT_IF_BUSY', 'Другая проверка ещё выполняется.'))
    .mockResolvedValueOnce({ ...result(), retained_campaign_ids: [], valid_final_plan: false })
  render(<CampaignWhatIf run={run()} />)
  const user = userEvent.setup()
  await user.click(screen.getAllByRole('checkbox')[0])
  await user.click(screen.getByRole('button', { name: 'Пересчитать вариант' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Другая проверка ещё выполняется.')
  await user.click(within(alert).getByRole('button', { name: 'Повторить' }))
  expect(await screen.findByText(/Это вариант для изучения, а не готовый план/)).toBeVisible()
  expect(calculate).toHaveBeenCalledTimes(2)
})

it('does not invent demo estimates or show unfinished plans', () => {
  const snapshot = run()
  snapshot.mode = 'demo'
  const view = render(<CampaignWhatIf run={snapshot} />)
  expect(screen.getByText(/В демонстрационном примере эта проверка недоступна/)).toBeVisible()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  snapshot.status = 'running'
  view.rerender(<CampaignWhatIf run={snapshot} />)
  expect(screen.queryByRole('heading')).not.toBeInTheDocument()
})
