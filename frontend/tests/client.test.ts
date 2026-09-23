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
