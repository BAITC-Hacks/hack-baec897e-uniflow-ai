import { expect, test } from '@playwright/test'
import type { RunSnapshot, RunSummary } from '../../src/lib/api/types'
import type { WhatIfResult } from '../../src/lib/api/whatIf'
import { money, number } from '../../src/lib/format'

test('real API: exclusions recalculate the saved plan without modifying it', async ({ page, request }) => {
  const listResponse = await request.get('/api/v1/runs?limit=100')
  expect(listResponse.ok()).toBe(true)
  const { items }: { items: RunSummary[] } = await listResponse.json()
  let id = items.find(item => item.status === 'completed')?.id
  if (!id) {
    id = items.find(item => item.status === 'running' || item.status === 'queued')?.id
    if (!id) {
      const created = await request.post('/api/v1/runs', {
        data: { seed: 42, risk_profile: 'balanced' }, headers: { 'Idempotency-Key': `what-if-test-${Date.now()}` },
      })
      expect(created.ok()).toBe(true)
      id = (await created.json() as RunSnapshot).id
    }
    await expect.poll(async () => (await (await request.get(`/api/v1/runs/${id}`)).json() as RunSnapshot).status, { timeout: 60000 }).toBe('completed')
  }
  const savedResponse = await request.get(`/api/v1/runs/${id}`)
  const saved: RunSnapshot = await savedResponse.json()
  const csvBefore = await (await request.get(`/api/v1/runs/${id}/campaigns.csv`)).text()
  const first = [...saved.campaigns].sort((left, right) => left.execution_order - right.execution_order)[0]
  expect(first).toBeDefined()
  await page.goto(`/runs/${id}#campaign-what-if`)
  const section = page.locator('#campaign-what-if')
  await expect(section.getByRole('heading', { name: 'Что будет, если убрать предложение?' })).toBeVisible()
  const checkbox = section.getByRole('checkbox').first()
  await checkbox.uncheck()
  const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/v1/runs/${id}/what-if`) && response.request().method() === 'POST')
  await section.getByRole('button', { name: 'Пересчитать вариант' }).click()
  const response = await responsePromise
  expect(response.ok(), await response.text()).toBe(true)
  expect(response.request().postDataJSON()).toEqual({ excluded_campaign_ids: [first.id] })
  const result: WhatIfResult = await response.json()
  expect(result.original.net_gain).toBeCloseTo(saved.local_evaluation!.net_arpu_gain, 6)
  expect(result.alternative.total_contacts).toBeGreaterThanOrEqual(saved.resources.contacts.used_by_pilots)
  expect(result.retained_campaign_ids).not.toContain(first.id)
  const alternatives = section.locator('.what-if-comparison > div')
  await expect(alternatives.nth(0)).toContainText(money(result.original.net_gain))
  await expect(alternatives.nth(1)).toContainText(money(result.alternative.net_gain))
  await expect(alternatives.nth(1)).toContainText(number(result.alternative.unique_customers))
  await expect(section.getByText('Изменение эффекта после расходов')).toBeVisible()
  await checkbox.check()
  await expect(section.getByText('Изменение эффекта после расходов')).toHaveCount(0)
  await expect(section.getByRole('button', { name: 'Пересчитать вариант' })).toBeDisabled()
  expect(await (await request.get(`/api/v1/runs/${id}`)).json()).toEqual(saved)
  expect(await (await request.get(`/api/v1/runs/${id}/campaigns.csv`)).text()).toBe(csvBefore)
})
