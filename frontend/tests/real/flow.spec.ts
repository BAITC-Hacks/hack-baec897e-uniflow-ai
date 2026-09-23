import { expect, test } from '@playwright/test'

test('real API: overview, audience, run, reload, plan, exports and history', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByText('Локальная симуляция · синтетические данные')).toBeVisible()
  await expect(page.getByText(/23\s?441/).first()).toBeVisible()
  await page.getByRole('link', { name: 'Аудитория', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Кого можно включить в план' })).toBeVisible()
  await page.goto('/runs/new')
  await page.getByRole('button', { name: 'Подобрать кампании' }).click()
  await expect(page).toHaveURL(/\/runs\/[0-9a-f]{32}$/)
  const runId = page.url().split('/runs/')[1]
  await page.reload()
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`))
  await expect(page.getByRole('heading', { name: 'План готов' })).toBeVisible({ timeout: 40000 })
  let terminalPolls = 0
  page.on('request', req => { if (req.method() === 'GET' && req.url().endsWith(`/api/v1/runs/${runId}`)) terminalPolls += 1 })
  await page.waitForTimeout(2200)
  expect(terminalPolls).toBe(0)
  const run = await (await request.get(`http://127.0.0.1:8000/api/v1/runs/${runId}`)).json()
  expect(run.status).toBe('completed')
  expect(run.mode).toBe('local_simulation')
  expect(run.pilots.length).toBeGreaterThan(0)
  expect(run.campaigns.length).toBeGreaterThan(0)
  expect(run.local_evaluation.n_final_campaigns).toBe(run.campaigns.length)
  const trigger = page.getByRole('button', { name: 'Подробности кампании 1' }).first()
  await trigger.click()
  await expect(page.getByRole('dialog', { name: 'Подробности кампании' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  const csv = await (await request.get(`http://127.0.0.1:8000/api/v1/runs/${runId}/campaigns.csv`)).text()
  expect(csv.replace(/^\uFEFF/, '').split('\n')[0].trim()).toBe('campaign_name,filter_arpu_segment,filter_data_segment,filter_call_segment,filter_current_tariff,target_tariff,channel')
  for (const campaign of run.campaigns) expect(csv).toContain(campaign.spec.campaign_name)
  const report = await (await request.get(`http://127.0.0.1:8000/api/v1/runs/${runId}/report.json`)).json()
  expect(report).toEqual(run)
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  }
  const csvDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать план CSV' }).click()
  expect((await csvDownload).suggestedFilename()).toContain(runId)
  const jsonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать отчёт JSON' }).click()
  expect((await jsonDownload).suggestedFilename()).toContain(runId)
  await page.goto('/runs')
  await expect(page.getByRole('link', { name: /Открыть запуск от/ }).first()).toBeVisible()
})

test('lost connection keeps run and recovers without a second POST', async ({ page, request }) => {
  await page.goto('/runs/new')
  let initialSnapshot: unknown
  await page.route('**/api/v1/runs', async route => {
    const response = await route.fetch()
    initialSnapshot = await response.json()
    await route.fulfill({ response })
  })
  let outage = false
  await page.route('**/api/v1/runs/*', route => {
    return outage ? route.abort() : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(initialSnapshot) })
  })
  await page.getByRole('button', { name: 'Подобрать кампании' }).click()
  await expect(page).toHaveURL(/\/runs\/[0-9a-f]{32}$/)
  const runId = page.url().split('/runs/')[1]
  await expect(page.getByRole('heading', { name: 'Агент проверяет гипотезы' })).toBeVisible()
  outage = true
  await expect(page.getByText('Обновление данных приостановлено — показан последний ответ')).toBeVisible({ timeout: 15000 })
  await page.unroute('**/api/v1/runs/*')
  await page.unroute('**/api/v1/runs')
  await expect(page.getByRole('heading', { name: 'План готов' })).toBeVisible({ timeout: 40000 })
  const history = await (await request.get('http://127.0.0.1:8000/api/v1/runs')).json()
  expect(history.items.filter((item: { id: string }) => item.id === runId)).toHaveLength(1)
})

test('lost POST response retries with the saved Idempotency-Key', async ({ page, request }) => {
  await page.goto('/runs/new')
  const before = (await (await request.get('http://127.0.0.1:8000/api/v1/runs')).json()).items.length
  let receivedId = ''
  await page.route('**/api/v1/runs', async route => {
    const response = await route.fetch()
    receivedId = (await response.json()).id
    await route.abort()
  })
  await page.getByRole('button', { name: 'Подобрать кампании' }).click()
  await expect(page.getByText('Не удалось создать запуск')).toBeVisible()
  await page.unroute('**/api/v1/runs')
  await page.getByRole('button', { name: 'Подобрать кампании' }).click()
  await expect(page).toHaveURL(new RegExp(`/runs/${receivedId}$`))
  const after = (await (await request.get('http://127.0.0.1:8000/api/v1/runs')).json()).items.length
  expect(after).toBe(before + 1)
})

test('unknown run and repeated health failure are visible', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Подключено')).toBeVisible()
  await page.route('**/api/v1/health', route => route.abort())
  await expect(page.getByText('Нет связи')).toBeVisible({ timeout: 20000 })
  await page.unroute('**/api/v1/health')
  await page.goto('/runs/unknown-run')
  await expect(page.getByText('Запуск недоступен')).toBeVisible()
  await expect(page.getByText('Запуск не найден.')).toBeVisible()
})

test('active conflict links to the active run', async ({ page }) => {
  await page.goto('/runs/new')
  await page.route('**/api/v1/runs', route => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'RUN_ALREADY_ACTIVE', message: 'Другой запуск уже выполняется.',
      details: { active_run_id: 'active-123' }, request_id: 'browser-test' } }),
  }))
  await page.getByRole('button', { name: 'Подобрать кампании' }).click()
  await expect(page.getByRole('link', { name: /Открыть активный запуск/ })).toHaveAttribute('href', '/runs/active-123')
})

test('SERVER_RESTARTED failed run stops polling and blocks export', async ({ page }) => {
  await page.goto('/runs/new')
  const create = page.waitForResponse(response => response.url().endsWith('/api/v1/runs') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Подобрать кампании' }).click()
  const created = await (await create).json()
  const runId = created.id as string
  let reads = 0
  await page.route(`**/api/v1/runs/${runId}`, route => {
    reads += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...created, status: 'failed', phase: 'failed', completed_at: new Date().toISOString(),
      failure: { code: 'SERVER_RESTARTED', message: 'Сервер перезапущен.', retryable: true },
    }) })
  })
  await page.goto(`/runs/${runId}`)
  await expect(page.getByText(/SERVER_RESTARTED/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Скачать план CSV' })).toBeDisabled()
  const atFailure = reads
  await page.waitForTimeout(2200)
  expect(reads).toBe(atFailure)
})
