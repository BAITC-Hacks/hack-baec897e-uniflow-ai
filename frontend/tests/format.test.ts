import { describe, expect, it } from 'vitest'
import { elapsed, money, number, percentage, when } from '../src/lib/format'

describe('display formatting', () => {
  it('distinguishes a known zero from an unavailable estimate', () => {
    expect(number(0)).toBe('0')
    expect(money(0)).toBe('0 у.е.')
    expect(percentage(0)).toBe('0%')
    expect(money(null)).toBe('Пока нет оценки')
    expect(percentage(undefined)).toBe('Пока нет оценки')
    expect(percentage(0.125)).toBe('12,5%')
  })

  it('does not leak invalid numeric values into visible metrics', () => {
    expect(number(NaN)).toBe('—')
    expect(money(Infinity)).toBe('Пока нет оценки')
    expect(percentage(-Infinity)).toBe('Пока нет оценки')
  })

  it('keeps malformed dates from crashing the page', () => {
    expect(when('invalid')).toBe('—')
    expect(when(null)).toBe('—')
    expect(when('2026-01-01T00:00:00Z')).not.toBe('—')
    expect(elapsed('invalid')).toBe('—')
    expect(elapsed('2026-01-01T00:00:00Z', NaN)).toBe('—')
  })

  it('formats duration and clamps a future start to zero', () => {
    expect(elapsed('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:05Z'))).toBe('1:05')
    expect(elapsed('2026-01-01T00:00:00Z', Date.parse('2025-12-31T23:59:59Z'))).toBe('0:00')
  })
})
