import type { Channel, RiskProfile, RunStatus } from './api/types'

const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })

export const number = (value: number | null | undefined) => value == null ? '—' : integer.format(value)
export const money = (value: number | null | undefined) => value == null ? 'Пока нет оценки' : `${integer.format(value)} у.е.`
export const percentage = (ratio: number | null | undefined) => ratio == null ? 'Пока нет оценки' : `${decimal.format(ratio * 100)}%`
export const when = (value: string | null | undefined) => value ? date.format(new Date(value)) : '—'
export const segment = (code: string | null) => ({ HIGH: 'Высокая выручка', MID: 'Средняя выручка', LOW: 'Низкая выручка' })[code || ''] || 'Не указан'
export const channel = (code: Channel) => ({ push: 'Push', sms: 'SMS', digital_ads: 'Digital ads', call: 'Звонок' })[code]
export const risk = (code: RiskProfile) => code === 'conservative' ? 'Осторожный' : 'Сбалансированный'
export const status = (code: RunStatus) => ({ queued: 'В очереди', running: 'Идёт расчёт', completed: 'План готов', failed: 'Ошибка' })[code]
export const elapsed = (from: string, to = Date.now()) => {
  const seconds = Math.max(0, Math.floor((to - new Date(from).getTime()) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
