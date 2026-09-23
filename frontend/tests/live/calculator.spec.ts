import { expect, test } from '@playwright/test'
import type { Overview } from '../../src/lib/api/types'

test('calculator uses current API prices and eligible revenue without starting a run', async ({ page, request }) => {
  const response = await request.get('/api/v1/overview')
  expect(response.ok()).toBe(true)
  const overview: Overview = await response.json()
  const groups = overview.segments.filter(group => group.eligible && group.customer_count > 0)
  const average = groups.reduce((sum, group) => sum + group.baseline_revenue, 0)
    / groups.reduce((sum, group) => sum + group.customer_count, 0)
  const paid = overview.channels.find(item => item.cost_per_contact > 0)!
  expect(paid).toBeDefined()
  const postRequests: string[] = []
  page.on('request', request => { if (request.method() === 'POST') postRequests.push(request.url()) })
  await page.goto('/calculator')
  await expect(page.getByTestId('scenario-net')).toBeVisible()
  await page.getByRole('combobox', { name: 'Как связаться' }).selectOption(paid.code)
  await page.getByRole('spinbutton', { name: 'Сколько абонентов охватить', exact: true }).fill('10')
  await page.getByRole('spinbutton', { name: 'Бюджет на связь', exact: true }).fill(String(paid.cost_per_contact * 2))
  await page.getByRole('spinbutton', { name: 'Вероятность перехода', exact: true }).fill('20')
  await page.getByRole('spinbutton', { name: 'Изменение выручки после перехода', exact: true }).fill('15')
  const expected = 2 * average * 0.15 * Math.min(0.2 * paid.conversion_multiplier, 1) - 2 * paid.cost_per_contact
  const format = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} у.е.`
  await expect(page.getByTestId('scenario-contacts')).toHaveText('2')
  await expect(page.getByTestId('scenario-cost')).toHaveText(format(paid.cost_per_contact * 2))
  await expect(page.getByTestId('scenario-net')).toHaveText(format(expected))
  await expect(page.locator('.calculator-limits')).toContainText('2 из 10')
  expect(postRequests).toEqual([])
})
