import { describe, expect, it } from 'vitest'
import { demoFetch } from '../src/mocks/transport'
import { buildSnapshot } from '../src/mocks/fixtures'
import type { RunSnapshot } from '../src/lib/api/types'

const create = (seed: number, key: string) => demoFetch('/api/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ seed, risk_profile: 'balanced' }) })

describe('demo API contract', () => {
  it('reuses one run for a repeated idempotency key and rejects a second active run', async () => {
    const first = await create(42, 'same-key')
    const firstBody = await first.json() as RunSnapshot
    const repeated = await create(42, 'same-key')
    const repeatedBody = await repeated.json() as RunSnapshot
    expect(repeatedBody.id).toBe(firstBody.id)
    const second = await create(7, 'other-key')
    expect(second.status).toBe(409)
    expect((await second.json()).error.details.active_run_id).toBe(firstBody.id)
    const list = await demoFetch('/api/v1/runs?limit=20')
    expect((await list.json()).items).toHaveLength(1)
  })

  it('keeps negative forecast separate from local result and conserves resources', () => {
    const snapshot = buildSnapshot({ id: 'negative', key: 'k', config: { seed: 7, risk_profile: 'balanced' }, created_at: new Date(Date.now() - 20000).toISOString() })
    expect(snapshot.status).toBe('completed')
    expect(snapshot.forecast?.expected_net_gain).toBeLessThan(0)
    expect(snapshot.local_evaluation?.net_arpu_gain).toBeLessThan(0)
    expect(snapshot.resources.budget.used_by_pilots + snapshot.resources.budget.planned_final! + snapshot.resources.budget.remaining_after_plan!).toBe(snapshot.resources.budget.limit)
    expect(snapshot.resources.contacts.used_by_pilots + snapshot.resources.contacts.planned_final! + snapshot.resources.contacts.remaining_after_plan!).toBe(snapshot.resources.contacts.limit)
    expect(snapshot.campaigns[0].evidence).toBe('fallback')
  })

  it('provides an explicit empty audience fixture', async () => {
    localStorage.setItem('orbitduo-demo-fixture', 'empty')
    const response = await demoFetch('/api/v1/overview')
    const body = await response.json()
    expect(body.dataset.customer_count).toBe(0)
    expect(body.segments).toHaveLength(0)
  })
})
