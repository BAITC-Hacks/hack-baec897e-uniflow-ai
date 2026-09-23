import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Overview } from '../../src/lib/api/types'
import type { StoredRun } from '../../src/mocks/fixtures'

const overview = JSON.parse(readFileSync(new URL('../../src/mocks/overview.json', import.meta.url), 'utf8')) as Overview
const historyStorageKey = 'orbitduo-demo-runs-v1'
const audienceCount = overview.segments.length

async function seedHistory(page: Page) {
  const createdAt = Date.now() - 60_000
  const runs: StoredRun[] = Array.from({ length: 32 }, (_, index) => ({
    id: `history-${String(index + 1).padStart(2, '0')}`,
    key: `history-key-${index + 1}`,
    config: { seed: index === 21 ? 7 : 42, risk_profile: index % 2 === 0 ? 'balanced' : 'conservative' },
    created_at: new Date(createdAt - index * 60_000).toISOString(),
  }))
  await page.goto('/')
  await page.evaluate(({ key, items }) => localStorage.setItem(key, JSON.stringify(items)), { key: historyStorageKey, items: runs })
  await page.goto('/runs')
  await expect(page.getByRole('heading', { name: 'История запусков' })).toBeVisible()
  return runs
}

test('audience pagination preserves every group, full totals and the page after reload', async ({ page }) => {
  await page.goto('/audience')
  const rows = page.getByRole('region', { name: 'Таблица сегментов', exact: true }).locator('tbody tr')
  const pagination = page.getByRole('navigation', { name: 'Страницы групп аудитории' })
  const total = page.getByText(/клиентов во всех найденных группах/)
  await expect(rows).toHaveCount(15)
  await expect(page.getByText(`${audienceCount} из ${audienceCount} групп`, { exact: true })).toBeVisible()
  const fullCustomerCount = await total.textContent()
  const signatures = () => rows.evaluateAll(items => items.map(row => [...row.querySelectorAll('td')].slice(0, 2).map(cell => cell.textContent).join('|')))
  const allSignatures = await signatures()
  await expect(pagination.getByRole('button', { name: 'Предыдущая страница групп' })).toBeDisabled()

  const pages = Math.ceil(audienceCount / 15)
  for (let currentPage = 2; currentPage <= pages; currentPage += 1) {
    await pagination.getByRole('button', { name: 'Следующая страница групп' }).click()
    await expect(page).toHaveURL(url => url.searchParams.get('page') === String(currentPage))
    await expect(pagination.getByRole('status')).toHaveText(`Группы ${(currentPage - 1) * 15 + 1}–${Math.min(currentPage * 15, audienceCount)} из ${audienceCount}`)
    await expect(rows).toHaveCount(Math.min(15, audienceCount - (currentPage - 1) * 15))
    const pageSignatures = await signatures()
    if (currentPage === 2) {
      await page.reload()
      await expect(pagination.getByRole('status')).toHaveText(`Группы 16–30 из ${audienceCount}`)
      expect(await signatures()).toEqual(pageSignatures)
    }
    await expect(total).toHaveText(fullCustomerCount!)
    allSignatures.push(...pageSignatures)
  }
  expect(allSignatures).toHaveLength(audienceCount)
  expect(new Set(allSignatures).size).toBe(audienceCount)
  await expect(pagination.getByRole('button', { name: 'Следующая страница групп' })).toBeDisabled()
})

test('audience filters and sort survive reload, reset pagination and retain unrelated URL parameters', async ({ page }) => {
  await page.goto('/audience?page=3&reference=audience-test')
  const rows = page.getByRole('region', { name: 'Таблица сегментов', exact: true }).locator('tbody tr')
  const search = page.getByRole('searchbox', { name: 'Поиск по тарифу' })
  await expect(rows).toHaveCount(15)
  await search.fill('  tariff_11  ')
  await expect(rows).toHaveCount(3)
  await expect(page).toHaveURL(url => url.searchParams.get('q') === '  tariff_11  ' && !url.searchParams.has('page'))
  await page.getByRole('combobox', { name: 'Уровень выручки', exact: true }).selectOption('HIGH')
  await page.getByRole('combobox', { name: 'Допуск к подбору', exact: true }).selectOption('eligible')
  await expect(rows).toHaveCount(1)
  await page.getByRole('button', { name: 'Выручка на абонента', exact: true }).click()
  await expect(page.getByRole('columnheader', { name: 'Выручка на абонента' })).toHaveAttribute('aria-sort', 'descending')
  await page.reload()
  await expect(search).toHaveValue('  tariff_11  ')
  await expect(page.getByRole('combobox', { name: 'Уровень выручки', exact: true })).toHaveValue('HIGH')
  await expect(page.getByRole('combobox', { name: 'Допуск к подбору', exact: true })).toHaveValue('eligible')
  await expect(page.getByRole('columnheader', { name: 'Выручка на абонента' })).toHaveAttribute('aria-sort', 'descending')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().locator('td').first()).toHaveText('Тариф 11')

  await page.getByRole('combobox', { name: 'Допуск к подбору', exact: true }).selectOption('excluded')
  await expect(page.getByRole('heading', { name: 'Подходящих групп нет' })).toBeVisible()
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click()
  await expect(page).toHaveURL(url => url.search === '?reference=audience-test')
  await expect(rows).toHaveCount(15)
  await expect(search).toHaveValue('')
  await expect(page.getByRole('columnheader', { name: 'Клиенты', exact: true })).toHaveAttribute('aria-sort', 'descending')

  const highSegment = page.getByRole('button', { name: /Высокая выручка/ })
  await highSegment.click()
  await expect(highSegment).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('combobox', { name: 'Уровень выручки', exact: true })).toHaveValue('HIGH')
  await highSegment.click()
  await expect(page.getByRole('combobox', { name: 'Уровень выручки', exact: true })).toHaveValue('all')
  await expect(page.getByText(`${audienceCount} из ${audienceCount} групп`, { exact: true })).toBeVisible()
})

test('history pagination preserves run identity and dates, and sorting returns to the first page', async ({ page }) => {
  await seedHistory(page)
  const rows = page.getByRole('region', { name: 'История запусков', exact: true }).locator('tbody tr')
  const pagination = page.getByRole('navigation', { name: 'Страницы истории' })
  const runLinks = rows.getByRole('link', { name: /Открыть запуск от/ })
  await expect(rows).toHaveCount(15)
  await expect(pagination.getByRole('status')).toHaveText('Запуски 1–15 из 32')
  await expect(runLinks.first()).toHaveAttribute('href', '/runs/history-01')
  await expect(runLinks.last()).toHaveAttribute('href', '/runs/history-15')

  await pagination.getByRole('button', { name: 'Следующая страница запусков' }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('page') === '2')
  await expect(pagination.getByRole('status')).toHaveText('Запуски 16–30 из 32')
  await expect(runLinks.first()).toHaveAttribute('href', '/runs/history-16')
  await expect(runLinks.last()).toHaveAttribute('href', '/runs/history-30')
  await page.reload()
  await expect(pagination.getByRole('status')).toHaveText('Запуски 16–30 из 32')
  await expect(runLinks.first()).toHaveAttribute('href', '/runs/history-16')

  await pagination.getByRole('button', { name: 'Следующая страница запусков' }).click()
  await expect(rows).toHaveCount(2)
  await expect(pagination.getByRole('status')).toHaveText('Запуски 31–32 из 32')
  await expect(runLinks.first()).toHaveAttribute('href', '/runs/history-31')
  await expect(runLinks.last()).toHaveAttribute('href', '/runs/history-32')
  await expect(pagination.getByRole('button', { name: 'Следующая страница запусков' })).toBeDisabled()
  await expect(page.getByText('Найдено 32 из 32 запусков', { exact: true })).toBeVisible()

  await page.getByRole('combobox', { name: 'Порядок', exact: true }).selectOption('oldest')
  await expect(page).toHaveURL(url => url.searchParams.get('order') === 'oldest' && !url.searchParams.has('page'))
  await expect(rows).toHaveCount(15)
  await expect(pagination.getByRole('status')).toHaveText('Запуски 1–15 из 32')
  await expect(runLinks.first()).toHaveAttribute('href', '/runs/history-32')
  const dates = await rows.locator('time').evaluateAll(items => items.map(item => Date.parse(item.getAttribute('datetime')!)))
  expect(dates).toEqual([...dates].sort((a, b) => a - b))
})

test('history filters persist in the URL and reset without altering saved runs', async ({ page }) => {
  const storedRuns = await seedHistory(page)
  const rows = page.getByRole('region', { name: 'История запусков', exact: true }).locator('tbody tr')
  const search = page.getByRole('searchbox', { name: 'Найти запуск' })
  await page.getByRole('button', { name: 'Следующая страница запусков' }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('page') === '2')
  await page.getByRole('combobox', { name: 'Подход к риску', exact: true }).selectOption('conservative')
  await expect(page).toHaveURL(url => url.searchParams.get('risk') === 'conservative' && !url.searchParams.has('page'))
  await expect(page.getByText('Найдено 16 из 32 запусков', { exact: true })).toBeVisible()
  await expect(rows).toHaveCount(15)
  await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('completed')
  await page.getByRole('button', { name: 'Следующая страница запусков' }).click()
  await expect(rows).toHaveCount(1)
  await search.fill('  history-22  ')
  await expect(page).toHaveURL(url => url.searchParams.get('q') === '  history-22  ' && !url.searchParams.has('page'))
  await expect(rows).toHaveCount(1)
  await expect(rows.getByRole('link', { name: /Открыть запуск от/ })).toHaveAttribute('href', '/runs/history-22')
  await page.reload()
  await expect(search).toHaveValue('  history-22  ')
  await expect(page.getByRole('combobox', { name: 'Подход к риску', exact: true })).toHaveValue('conservative')
  await expect(page.getByRole('combobox', { name: 'Статус', exact: true })).toHaveValue('completed')
  await expect(rows).toHaveCount(1)
  await expect(rows.getByText('Прогноз ниже нуля', { exact: true })).toBeVisible()
  await expect(rows.getByText('План готов', { exact: true })).not.toHaveClass(/status-positive/)
  await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('failed')
  await expect(page.getByRole('heading', { name: 'Запуски не найдены' })).toBeVisible()
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click()
  await expect(page).toHaveURL(url => url.pathname === '/runs' && url.search === '')
  await expect(rows).toHaveCount(15)
  await expect(page.getByText('Найдено 32 из 32 запусков', { exact: true })).toBeVisible()
  const savedRuns = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), historyStorageKey)
  expect(savedRuns).toEqual(storedRuns)
})
