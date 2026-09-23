import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { RunSnapshot } from '../../src/lib/api/types'

// This is an unchanged completed API response, including its original English
// reasons and event messages. No test starts a calculation or mutates the API.
const snapshot = JSON.parse(readFileSync(new URL('../fixtures/real-run.json', import.meta.url), 'utf-8')) as RunSnapshot
const rawTerms = /\b(?:queued|audit|Posterior|Diverse initial coverage|Decision-relevant uncertainty|Pilot selected|Pilot observed|Public profile audit|Candidates constructed|Initial feasible plan|Portfolio updated|Final plan validated|Historical prior)\b|tariff_|digital_ads/iu

async function openSavedRun(page: Page) {
  const pageErrors: string[] = []
  const postRequests: string[] = []
  let fixtureReads = 0
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/runs') postRequests.push(request.url())
  })
  // Protect the live backend even if a future navigation change starts a POST.
  await page.route('**/api/v1/runs', route => route.request().method() === 'POST' ? route.abort() : route.continue())
  await page.route(`**/api/v1/runs/${snapshot.id}`, async route => {
    if (route.request().method() !== 'GET') return route.abort()
    fixtureReads += 1
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(snapshot) })
  })
  await page.goto(`/runs/${snapshot.id}`)
  await expect.poll(() => fixtureReads, { message: 'The live HTTP transport must read the real backend fixture; demo transport cannot exercise this test.' }).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { name: 'План готов', exact: true })).toBeVisible()
  return { pageErrors, postRequests }
}

async function expectRussianPrimaryText(page: Page) {
  // innerText checks rendered content. textContent would also include the
  // intentionally preserved source text inside closed technical <details>.
  expect(await page.locator('body').innerText()).not.toMatch(rawTerms)
}

async function expandResearch(page: Page) {
  const research = page.locator('#run-research')
  await research.getByRole('button', { name: /^Показать все проверки/ }).click()
  await research.getByRole('button', { name: /^Показать весь ход подбора/ }).click()
  await expect(research.locator('.plain-pilot')).toHaveCount(snapshot.pilots.length)
  await expect(research.locator('.event-list > li')).toHaveCount(snapshot.events.length)
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(page.viewportSize()?.width).toBe(390)
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth), {
    message: 'The page must fit the mobile viewport without horizontal scrolling.',
  }).toBeLessThanOrEqual(1)
}

test('real saved messages are explained in Russian and the originals require opening technical details', async ({ page }) => {
  const audit = await openSavedRun(page)
  await expect(page.getByRole('heading', { name: 'Разбор результата', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Проверки предложений', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Что сделала программа', exact: true })).toBeVisible()
  await expect(page.getByText('Это история расчёта: выполнять команды или вводить что-либо здесь не нужно.', { exact: false })).toBeVisible()
  await expectRussianPrimaryText(page)

  await expandResearch(page)
  await expect(page.getByRole('heading', { name: 'Расчёт ожидает своей очереди', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Варианты предложений подготовлены', exact: true })).toBeVisible()
  await expectRussianPrimaryText(page)

  const firstPilot = page.locator('#run-research .plain-pilot').first()
  const source = firstPilot.locator('details.technical-details')
  await expect(source.locator('pre')).toBeHidden()
  await source.locator('summary').click()
  await expect(source.locator('pre')).toBeVisible()
  await expect(source.locator('pre')).toContainText(snapshot.pilots[0].selection_reason)
  await expect(source.locator('pre')).toContainText(snapshot.pilots[0].decision_after)
  expect(await page.locator('body').innerText()).toContain('Posterior mean changed')
  await source.locator('summary').click()
  await expect(source.locator('pre')).toBeHidden()
  await expectRussianPrimaryText(page)

  const sourceEventIndex = snapshot.events.findIndex(event => event.title === 'Public profile audit')
  expect(sourceEventIndex).toBeGreaterThanOrEqual(0)
  const eventSource = page.locator('#run-research .event-list > li').nth(sourceEventIndex).locator('details.technical-details')
  await expect(eventSource.locator('pre')).toBeHidden()
  await eventSource.locator('summary').click()
  await expect(eventSource.locator('pre')).toBeVisible()
  await expect(eventSource.locator('pre')).toContainText('Public profile audit')
  await expect(eventSource.locator('pre')).toContainText(snapshot.events[sourceEventIndex].message)
  await eventSource.locator('summary').click()
  await expectRussianPrimaryText(page)
  expect(audit.pageErrors).toEqual([])
  expect(audit.postRequests).toEqual([])
})

test('analysis links reveal warnings and open the relevant campaign with keyboard focus restored', async ({ page }) => {
  const audit = await openSavedRun(page)
  const noticePanel = page.locator('details.run-notices-panel')
  await expect(noticePanel).not.toHaveAttribute('open', '')
  await page.locator('#run-analysis').getByRole('link', { name: 'Прочитать замечания', exact: true }).click()
  await expect(noticePanel).toHaveAttribute('open', '')
  await expect(page.locator('#run-notices')).toBeVisible()
  await expect(page.locator('#run-notices').getByText('Нужно уточнить текущий тариф', { exact: true })).toBeVisible()
  await expectRussianPrimaryText(page)

  const campaign = snapshot.campaigns.find(item => item.evidence === 'prior_only')!
  expect(campaign).toBeDefined()
  const trigger = page.locator('#run-analysis').getByRole('button', { name: `Разобрать кампанию № ${campaign.execution_order}`, exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Подробности кампании', exact: true })
  await expect(dialog).toBeVisible()
  const target = campaign.spec.target_tariff.replace(/^tariff_/, 'Тариф ')
  await expect(dialog.getByRole('heading', { name: `Предложение №${campaign.execution_order}: ${target}`, exact: true })).toBeVisible()
  await expect(dialog).toContainText('Выводы предварительные')
  await expectRussianPrimaryText(page)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
  expect(audit.pageErrors).toEqual([])
  expect(audit.postRequests).toEqual([])
})

test('Russian explanations, expanded source records and campaign details fit a 390px screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const audit = await openSavedRun(page)
  await expectRussianPrimaryText(page)
  await expectNoHorizontalOverflow(page)
  await expandResearch(page)
  await expectRussianPrimaryText(page)
  await expectNoHorizontalOverflow(page)

  const source = page.locator('#run-research .plain-pilot').first().locator('details.technical-details')
  await source.locator('summary').click()
  await expect(source.locator('pre')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await source.locator('summary').click()

  await page.locator('#run-analysis').getByRole('link', { name: 'Прочитать замечания', exact: true }).click()
  await expect(page.locator('#run-notices')).toBeVisible()
  await expectRussianPrimaryText(page)
  await expectNoHorizontalOverflow(page)

  const trigger = page.locator('.mobile-campaigns').getByRole('button', { name: 'Подробности кампании 1', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Подробности кампании', exact: true })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await expectNoHorizontalOverflow(page)
  await expectRussianPrimaryText(page)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
  expect(audit.pageErrors).toEqual([])
  expect(audit.postRequests).toEqual([])
})
