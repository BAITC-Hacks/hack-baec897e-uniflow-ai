import { expect, test } from '@playwright/test'

for (const width of [1440, 1280, 768, 390]) {
  test(`main pages fit ${width}px viewport`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    for (const route of ['/', '/audience', '/runs/new']) {
      await page.goto(route)
      await expect(page.getByText('Демо · синтетические данные')).toBeVisible()
      if (route === '/') await expect(page.getByRole('heading', { name: /Решения для аудитории/ })).toBeVisible()
      if (route === '/audience') await expect(page.getByRole('heading', { name: 'Кого можно включить в план' })).toBeVisible()
      if (route === '/runs/new') await expect(page.getByRole('radio', { name: /Сбалансированный/ })).toBeVisible()
      await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      if (route === '/') await page.screenshot({ path: `test-results/overview-${width}.png`, fullPage: true })
    }
    await page.evaluate(() => localStorage.setItem('uniflow-demo-runs-v1', JSON.stringify([{
      id: 'responsive-run', key: 'responsive-key', config: { seed: 42, risk_profile: 'balanced' }, created_at: new Date(Date.now() - 20000).toISOString(),
    }])))
    await page.goto('/runs/responsive-run')
    await expect(page.getByRole('heading', { name: 'План готов' })).toBeVisible()
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    if (width === 1440 || width === 390) await page.screenshot({ path: `test-results/result-${width}.png`, fullPage: true })
    expect(pageErrors).toEqual([])
  })
}
