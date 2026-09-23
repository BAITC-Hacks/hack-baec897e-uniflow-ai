import { expect, test } from '@playwright/test'

test('opens a presentation report, prints an A4 PDF and returns to the original run', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('orbitduo-demo-runs-v1', JSON.stringify([{ id: 'report-example', key: 'report-example-key', config: { seed: 42, risk_profile: 'balanced' }, created_at: new Date(Date.now() - 60000).toISOString() }]))
    window.print = () => { document.documentElement.dataset.printRequested = 'true' }
  })
  await page.goto('/runs/report-example')
  await expect(page.getByRole('heading', { name: 'План готов', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Отчёт для PDF', exact: true }).click()
  await expect(page).toHaveURL(/\/runs\/report-example\/report$/)
  await expect(page.getByRole('heading', { name: 'План тарифных предложений', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Кому и что предлагается', exact: true })).toBeVisible()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(4)
  await expect(page.locator('.report-paper')).toContainText('Сценарий № 42')
  await expect(page.locator('.report-paper')).toContainText('не отражают полную прибыль бизнеса')
  await page.getByRole('button', { name: 'Печать / PDF' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-print-requested', 'true')
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.report-toolbar')).toBeHidden()
  const pdf = await page.pdf({ path: testInfo.outputPath('presentation.pdf'), preferCSSPageSize: true, printBackground: true })
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  expect(pdf.length).toBeGreaterThan(10000)
  await page.emulateMedia({ media: 'screen' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.getByRole('link', { name: 'К результату', exact: true }).click()
  await expect(page).toHaveURL(/\/runs\/report-example$/)
})

test('does not print an unfinished result as a completed report', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('orbitduo-demo-runs-v1', JSON.stringify([{ id: 'failed-report', key: 'failed-report-key', config: { seed: 13, risk_profile: 'balanced' }, created_at: new Date(Date.now() - 60000).toISOString() }])))
  await page.goto('/runs/failed-report/report')
  await expect(page.getByRole('heading', { name: 'Отчёт пока недоступен', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Печать / PDF' })).toBeDisabled()
  await expect(page.locator('.report-paper')).toHaveCount(0)
})
