import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

it('does not switch to demo when the real API is offline', async () => {
  vi.stubEnv('VITE_DEMO_MODE', 'false')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
  vi.resetModules()
  const { api, ApiError } = await import('../src/lib/api/client')
  await expect(api.overview()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  expect(ApiError).toBeDefined()
})

it('reuses an unchanged snapshot and replaces it after the server revision changes', async () => {
  vi.stubEnv('VITE_DEMO_MODE', 'false')
  const first = { id: 'run-1', status: 'running' }
  const completed = { id: 'run-1', status: 'completed' }
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(first), { headers: { 'Content-Type': 'application/json', ETag: 'W/"1"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(completed), { headers: { 'Content-Type': 'application/json', ETag: 'W/"2"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
  vi.stubGlobal('fetch', fetchMock)
  const { api } = await import('../src/lib/api/client')
  const initial = await api.run('run-1')
  expect(await api.run('run-1')).toBe(initial)
  expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'If-None-Match': 'W/"1"' })
  const updated = await api.run('run-1')
  expect(updated).toEqual(completed)
  expect(await api.run('run-1')).toBe(updated)
  expect(fetchMock.mock.calls[3][1].headers).toEqual({ 'If-None-Match': 'W/"2"' })
})

it('does not turn a failed request into a cached success', async () => {
  vi.stubEnv('VITE_DEMO_MODE', 'false')
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response('{"id":"run-1"}', { headers: { 'Content-Type': 'application/json', ETag: 'W/"1"' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'RUN_NOT_FOUND', message: 'Missing' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })))
  const { api } = await import('../src/lib/api/client')
  await api.run('run-1')
  await expect(api.run('run-1')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND', status: 404 })
})

it('rejects a 304 when no snapshot has been received for that run', async () => {
  vi.stubEnv('VITE_DEMO_MODE', 'false')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 304 })))
  const { api } = await import('../src/lib/api/client')
  await expect(api.run('unknown-run')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 304 })
})

it('preserves cancellation so leaving a page does not become a network error', async () => {
  vi.stubEnv('VITE_DEMO_MODE', 'false')
  const abort = new DOMException('Cancelled', 'AbortError')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
  const { api } = await import('../src/lib/api/client')
  await expect(api.run('run-1')).rejects.toBe(abort)
})

it('preserves cancellation while the response body is still being read', async () => {
  vi.stubEnv('VITE_DEMO_MODE', 'false')
  const abort = new DOMException('Cancelled during body read', 'AbortError')
  const response = new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  vi.spyOn(response, 'json').mockRejectedValue(abort)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  const { api } = await import('../src/lib/api/client')
  await expect(api.run('run-1')).rejects.toBe(abort)
})

it('keeps demo routes independent of a configured real API prefix', async () => {
  vi.stubEnv('VITE_DEMO_MODE', 'true')
  vi.stubEnv('VITE_API_BASE_URL', 'https://example.test/custom-api')
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const { api } = await import('../src/lib/api/client')
  await expect(api.health()).resolves.toMatchObject({ status: 'ok', mode: 'demo' })
  expect(fetchMock).not.toHaveBeenCalled()
})
