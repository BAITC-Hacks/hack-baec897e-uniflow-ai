import type { Channel, RiskProfile, RunStatus } from './api/types'

const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)

export const number = (value: number | null | undefined) => finite(value) ? integer.format(value) : '—'
export const money = (value: number | null | undefined) => finite(value) ? `${integer.format(value)} у.е.` : 'Пока нет оценки'
export const percentage = (ratio: number | null | undefined) => finite(ratio) ? `${decimal.format(ratio * 100)}%` : 'Пока нет оценки'
export const when = (value: string | null | undefined) => {
  const timestamp = value ? Date.parse(value) : NaN
  return Number.isFinite(timestamp) ? date.format(timestamp) : '—'
}
export const segment = (code: string | null) => ({ HIGH: 'Высокая выручка', MID: 'Средняя выручка', LOW: 'Низкая выручка' })[code || ''] || 'Не указан'
export const channel = (code: Channel) => ({ push: 'Уведомление в приложении', sms: 'СМС', digital_ads: 'Интернет-реклама', call: 'Звонок' })[code]
export const tariff = (code: string | null | undefined) => {
  if (!code) return 'Тариф не указан'
  const match = /^tariff_(\d+)$/i.exec(code)
  if (match) return `Тариф ${match[1]}`
  return /[а-яё]/i.test(code) && !/[a-z_]/i.test(code) ? code : 'Другой тариф'
}
export const risk = (code: RiskProfile) => code === 'conservative' ? 'Осторожный' : 'Сбалансированный'
export const status = (code: RunStatus) => ({ queued: 'В очереди', running: 'Идёт расчёт', completed: 'План готов', failed: 'Ошибка' })[code]
export const elapsed = (from: string, to = Date.now()) => {
  const start = Date.parse(from)
  if (!Number.isFinite(start) || !Number.isFinite(to)) return '—'
  const seconds = Math.max(0, Math.floor((to - start) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
