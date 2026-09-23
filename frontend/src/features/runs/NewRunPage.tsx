import { useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Info, Shield, Sparkles } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../../lib/api/client'
import type { RiskProfile, RunConfig } from '../../lib/api/types'
import { money, number } from '../../lib/format'
import { Card, ErrorPanel, Skeleton } from '../../components/ui/common'

const pendingKey = 'orbitduo-pending-create-v1'

export function NewRunPage() {
  const navigate = useNavigate()
  const overview = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api.overview(signal) })
  const [risk, setRisk] = useState<RiskProfile>('balanced')
  const [seed, setSeed] = useState(42)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const submitting = useRef(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || overview.data?.dataset.eligible_customer_count === 0) return
    submitting.current = true
    setPending(true); setError(null); setActiveId(null)
    const config: RunConfig = { seed, risk_profile: risk }
    const signature = JSON.stringify(config)
    let key: string
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) || 'null') as { signature: string; key: string } | null
      key = saved?.signature === signature ? saved.key : crypto.randomUUID()
    } catch { key = crypto.randomUUID() }
    sessionStorage.setItem(pendingKey, JSON.stringify({ signature, key }))
    try {
      const run = await api.createRun(config, key)
      sessionStorage.removeItem(pendingKey)
      navigate(`/runs/${run.id}`)
    } catch (caught) {
      setError(caught)
      if (caught instanceof ApiError && caught.code === 'RUN_ALREADY_ACTIVE' && typeof caught.details.active_run_id === 'string') setActiveId(caught.details.active_run_id)
    } finally { submitting.current = false; setPending(false) }
  }

  if (overview.isPending) return <Card><Skeleton rows={6} /></Card>
  if (overview.error || !overview.data) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} />
  const limits = overview.data.limits
  const noAudience = overview.data.dataset.eligible_customer_count === 0
  return <div className="page-stack narrow-page"><div className="section-intro"><p className="eyebrow">НОВЫЙ ЗАПУСК</p><h2>Настроить подбор</h2><p>Агент исследует предложения на синтетической среде. Реальные сообщения не отправляются.</p></div>
    <form onSubmit={submit} className="run-form"><Card><div className="form-heading"><div className="form-icon"><Sparkles size={21} aria-hidden="true" /></div><div><h3>Как оценивать риск</h3><p>Профиль влияет на осторожность при выборе кампаний.</p></div></div>
      <div className="risk-options" role="radiogroup" aria-label="Режим риска">
        <label className={`risk-option ${risk === 'balanced' ? 'selected' : ''}`}><input type="radio" name="risk" checked={risk === 'balanced'} onChange={() => setRisk('balanced')} /><span><strong>Сбалансированный</strong><small>Обычная оценка ожидаемого эффекта с учётом неопределённости.</small></span></label>
        <label className={`risk-option ${risk === 'conservative' ? 'selected' : ''}`}><input type="radio" name="risk" checked={risk === 'conservative'} onChange={() => setRisk('conservative')} /><span><strong>Осторожный</strong><small>Более сильный штраф за неопределённость в оценке кампаний.</small></span></label>
      </div>
    </Card>
    <Card><div className="form-heading"><div className="form-icon muted"><Shield size={20} aria-hidden="true" /></div><div><h3>Фиксированные лимиты</h3><p>Ограничения задаёт конкурсная среда.</p></div></div><div className="fixed-limits"><div><span>Бюджет</span><strong>{money(limits.budget)}</strong></div><div><span>Контакты</span><strong>{number(limits.contacts)}</strong></div><div><span>Пилоты</span><strong>до {number(limits.pilots)}</strong></div><div><span>Кампании</span><strong>до {number(limits.final_campaigns)}</strong></div></div>
      <details className="seed-details"><summary>Для воспроизводимости</summary><div><label htmlFor="seed">Seed локальной симуляции</label><input id="seed" type="number" min="0" max="2147483647" step="1" value={seed} onChange={event => setSeed(Number(event.target.value))} required /><p>Одинаковый seed помогает повторить сценарий. По умолчанию — 42.</p></div></details>
    </Card>
    {noAudience && <div className="error-panel" role="status"><Info size={19} /><div><strong>Нет доступной аудитории</strong><p>Подбор станет доступен после загрузки исходных сегментов.</p></div></div>}
    {error != null && <ErrorPanel error={error} title={activeId ? 'Другой запуск уже выполняется' : 'Не удалось создать запуск'} />}
    {activeId && <Link to={`/runs/${activeId}`} className="button button-secondary">Открыть активный запуск <ArrowRight size={17} /></Link>}
    <div className="form-footer"><span><Info size={17} aria-hidden="true" /> После запуска откроется журнал фактических шагов агента.</span><button type="submit" className="button button-primary" disabled={pending || noAudience || !Number.isInteger(seed) || seed < 0 || seed > 2147483647}>{pending ? 'Создаём запуск…' : 'Подобрать кампании'} <ArrowRight size={18} aria-hidden="true" /></button></div>
    </form>
  </div>
}
