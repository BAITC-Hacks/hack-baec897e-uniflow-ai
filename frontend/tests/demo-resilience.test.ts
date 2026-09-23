import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSnapshot } from '../src/mocks/fixtures'

const storageKey = 'orbitduo-demo-runs-v1'
const config = { seed: 42, risk_profile: 'balanced' }
const post = (body: unknown = config, key = 'create-key'): RequestInit => ({
  method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body),
})

afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

describe('demo recovery', () => {
  it.each(['null', '{}', '{broken'])('recovers an empty history from damaged storage: %s', async stored => {
    localStorage.setItem(storageKey, stored)
    const { demoFetch } = await import('../src/mocks/transport')
    const response = await demoFetch('/api/v1/runs')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
  })

  it('keeps valid records, drops broken entries, and orders the newest run first', async () => {
    localStorage.setItem(storageKey, JSON.stringify([
      { id: 'older', key: 'older', config, created_at: '2026-01-01T00:00:00Z' },
      null,
      { id: 'invalid-date', key: 'bad', config, created_at: 'not-a-date' },
      { id: 'invalid-config', key: 'bad', config: null, created_at: '2026-01-02T00:00:00Z' },
      { id: 'newer', key: 'newer', config, created_at: '2026-01-03T00:00:00Z' },
    ]))
    const { demoFetch } = await import('../src/mocks/transport')
    const response = await demoFetch('/api/v1/runs')
    const body = await response.json()
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(['newer', 'older'])
  })

  it('continues the same run in memory when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    const { demoFetch } = await import('../src/mocks/transport')
    expect((await demoFetch('/api/v1/overview')).status).toBe(200)
    const first = await (await demoFetch('/api/v1/runs', post())).json()
    const repeated = await (await demoFetch('/api/v1/runs', post())).json()
    expect(repeated.id).toBe(first.id)
    expect(first.warnings).toContainEqual(expect.objectContaining({ code: 'DEMO_STORAGE_UNAVAILABLE' }))
    expect((await (await demoFetch('/api/v1/runs')).json()).items).toHaveLength(1)
    expect((await (await demoFetch(`/api/v1/runs/${first.id}`)).json()).id).toBe(first.id)
  })

  it('keeps newly created runs accessible when storage has no space', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    const { demoFetch } = await import('../src/mocks/transport')
    const response = await demoFetch('/api/v1/runs', post())
    expect(response.status).toBe(202)
    const first = await response.json()
    const repeated = await (await demoFetch('/api/v1/runs', post())).json()
    expect(repeated.id).toBe(first.id)
    expect((await demoFetch(`/api/v1/runs/${first.id}`)).status).toBe(200)
  })

  it.each([null, [], { seed: 42 }, { ...config, extra: true }])('returns a validation error for malformed config %j', async body => {
    const { demoFetch } = await import('../src/mocks/transport')
    const response = await demoFetch('/api/v1/runs', post(body))
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('recognizes an equivalent retry regardless of JSON property order', async () => {
    const { demoFetch } = await import('../src/mocks/transport')
    const first = await (await demoFetch('/api/v1/runs', post({ risk_profile: 'balanced', seed: 42 }))).json()
    const repeated = await demoFetch('/api/v1/runs', post())
    expect(repeated.status).toBe(202)
    expect((await repeated.json()).id).toBe(first.id)
    const conflict = await demoFetch('/api/v1/runs', post({ ...config, seed: 7 }))
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('ends a failed demo journal with the actual failure and retains completed pilots', () => {
    const snapshot = buildSnapshot({ id: 'failed', key: 'failure', config: { seed: 13, risk_profile: 'balanced' }, created_at: '2026-01-01T00:00:00Z' }, Date.parse('2026-01-01T00:00:20Z'))
    expect(snapshot.status).toBe('failed')
    expect(snapshot.events.at(-1)?.phase).toBe('failed')
    expect(snapshot.events.every(event => event.phase !== 'completed')).toBe(true)
    expect(snapshot.pilots).toHaveLength(2)
    expect(snapshot.campaigns).toHaveLength(0)
  })
})
