import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Overview, RunSnapshot } from '../../src/lib/api/types'

test('real API: create, reload, inspect the plan, download the saved result', async ({ page, request }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const overviewResponse = await request.get('/api/v1/overview')
  expect(overviewResponse.ok()).toBe(true)
  const overview: Overview = await overviewResponse.json()
  expect(overview.mode).toBe('local_simulation')
  expect(overview.dataset.eligible_customer_count).toBeGreaterThan(0)
  await page.goto('/')
  await expect(page).toHaveTitle(/OrbitDuo/)
  await expect(page.getByText('Локальная симуляция · синтетические данные')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Кому предложить тариф/ })).toBeVisible()
  await page.getByRole('link', { name: 'Подобрать кампании', exact: true }).click()
  await page.getByRole('button', { name: 'Подобрать кампании' }).click()
  await expect(page).toHaveURL(/\/runs\/[0-9a-f]{32}$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  await page.reload()
  await expect(page.getByRole('heading', { name: 'План готов' })).toBeVisible({ timeout: 60000 })
  const snapshotResponse = await request.get(`/api/v1/runs/${id}`)
  expect(snapshotResponse.ok()).toBe(true)
  const snapshot: RunSnapshot = await snapshotResponse.json()
  expect(snapshot.status).toBe('completed')
  expect(snapshot.pilots.length).toBeGreaterThan(0)
  expect(snapshot.campaigns.length).toBeGreaterThan(0)
  expect(snapshot.campaigns.length).toBeLessThanOrEqual(overview.limits.final_campaigns)
  expect(snapshot.local_evaluation?.total_contacts).toBeLessThanOrEqual(overview.limits.contacts)
  expect(snapshot.local_evaluation?.communication_cost).toBeLessThanOrEqual(overview.limits.budget)
  expect(snapshot.local_evaluation?.label).toBe('local_simulation')
  await expect(page.getByText('ПРОГНОЗ ПРОГРАММЫ')).toBeVisible()
  await expect(page.getByText('ЛОКАЛЬНАЯ ПРОВЕРКА', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Подробности кампании 1', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(snapshot.campaigns[0].spec.target_tariff)
  await page.keyboard.press('Escape')

  for (const [kind, label, filename] of [
    ['csv', 'Скачать план CSV', 'campaigns.csv'],
    ['json', 'Скачать отчёт JSON', 'report.json'],
  ] as const) {
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: label }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(`orbitduo-${id}-${filename}`)
    const saved = testInfo.outputPath(`saved-${filename}`)
    await download.saveAs(saved)
    const exportResponse = await request.get(`/api/v1/runs/${id}/${filename}`)
    expect(exportResponse.ok()).toBe(true)
    expect(await readFile(saved)).toEqual(await exportResponse.body())
    if (kind === 'json') expect(JSON.parse(await readFile(saved, 'utf-8')).campaigns).toEqual(snapshot.campaigns)
  }
  await page.screenshot({ path: testInfo.outputPath('live-result.png'), fullPage: true })
  await page.goto('/runs')
  await expect(page.locator(`a[href="/runs/${id}"]`).first()).toBeVisible()
  expect(pageErrors).toEqual([])
})
