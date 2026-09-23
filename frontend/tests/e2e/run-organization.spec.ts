import { expect, test, type Page } from '@playwright/test'

async function seedRuns(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.setItem('orbitduo-demo-runs-v1', JSON.stringify(['one', 'two', 'three', 'four'].map((name, index) => ({
      id: `compare-${name}`, key: `compare-key-${name}`, config: { seed: 42, risk_profile: index === 1 ? 'conservative' : 'balanced' }, created_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    }))))
  })
}

test('names, notes and favorites persist and selected runs compare with honest conditions', async ({ page }) => {
  await seedRuns(page)
  await page.goto('/runs/compare-one')
  await page.getByRole('textbox', { name: 'Название расчёта' }).fill('Вариант для жюри')
  await page.getByRole('textbox', { name: 'Что важно запомнить' }).fill('Перепроверить отклик аудитории')
  await page.getByRole('checkbox', { name: 'В избранном' }).check()
  await page.getByRole('button', { name: 'Сохранить заметки' }).click()
  await expect(page.getByText('Сохранено в этом браузере.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Название расчёта' })).toHaveValue('Вариант для жюри')
  await page.getByRole('link', { name: 'Сравнить с другим запуском' }).click()
  await expect(page.getByRole('checkbox', { name: 'Сравнить расчёт Вариант для жюри', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Только избранное' }).click()
  const rows = page.getByRole('region', { name: 'История запусков', exact: true }).locator('tbody tr')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Перепроверить отклик аудитории')
  await page.getByRole('button', { name: 'Только избранное' }).click()
  await page.getByRole('checkbox', { name: 'Сравнить расчёт compare-two', exact: true }).check()
  await page.getByRole('link', { name: 'Сравнить (2)' }).click()
  await expect(page.getByRole('heading', { name: 'Сравнение расчётов', exact: true })).toBeVisible()
  const metrics = page.getByRole('region', { name: 'Сравнение показателей расчётов' })
  await expect(metrics.getByRole('link', { name: 'Вариант для жюри' })).toBeVisible()
  await expect(page.getByText(/Совпадают набор данных/)).toBeVisible()
  await expect(page.getByText(/Версия алгоритма в отчётах не сохранена/)).toBeVisible()
  await expect(page.getByText('Такие же условия в 2 вариантах').first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Сравнение расчётов', exact: true })).toBeVisible()
})

test('three-run comparison fits a phone and malformed links never open a single run', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedRuns(page)
  await page.goto('/runs/compare?ids=compare-one,compare-two,compare-three')
  await expect(page.getByRole('heading', { name: 'Сравнение расчётов', exact: true })).toBeVisible()
  await expect(page.getByText(/Совпадают набор данных/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.goto('/runs/compare?ids=compare-one')
  await expect(page.getByRole('heading', { name: 'Выберите два или три расчёта' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Открыть историю' })).toBeVisible()
})
