import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ArrowUpRight, Database, Lightbulb, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api/client'
import { money, number, risk, status, when } from '../../lib/format'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'

export function OverviewPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api.overview(signal) })
  const runs = useQuery({ queryKey: ['runs', 1], queryFn: ({ signal }) => api.runs(1, signal) })
  if (overview.isPending && !overview.isError) return <div className="page-stack"><Card><Skeleton rows={4} /></Card><Card><Skeleton rows={3} /></Card></div>
  if (overview.error || !overview.data) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} title="Обзор недоступен" />
  const { dataset, limits } = overview.data
  const last = runs.data?.items[0]
  if (dataset.customer_count === 0) return <div className="page-stack"><div className="section-intro"><p className="eyebrow">РАБОЧИЙ ОБЗОР</p><h2>Данные аудитории пока недоступны</h2><p>Сначала нужен синтетический набор профилей и сегментов для подбора кампаний.</p></div><Card><EmptyState title="Нет профилей для анализа" text="Проверьте источник данных и обновите обзор после загрузки аудитории." action={<button className="button button-secondary" onClick={() => void overview.refetch()}>Обновить обзор</button>} /></Card></div>
  return <div className="page-stack">
    <div className="page-intro"><div><p className="eyebrow">РАБОЧИЙ ОБЗОР</p><h2>Решения для аудитории,<br /><em>основанные на проверке</em></h2><p>Исследуйте тарифные предложения в пределах фиксированных конкурсных ресурсов.</p></div><span className="case-note"><Database size={16} aria-hidden="true" /> Синтетический набор данных</span></div>
    <div className="overview-grid">
      <Card className="overview-data"><CardHeader eyebrow="ИСТОЧНИК" title="Что доступно" aside={<Link to="/audience" className="text-link">Открыть аудиторию <ArrowUpRight size={16} /></Link>} />
        <div className="big-metric"><strong>{number(dataset.customer_count)}</strong><span>абонентских профилей</span></div>
        <div className="baseline"><span>Ожидаемая выручка без новых кампаний</span><strong>{money(dataset.baseline_revenue)}</strong><small>Сумма исходных прогнозов ARPU всей аудитории. Это не результат агента.</small></div>
        <div className="data-foot"><span><b>{number(dataset.eligible_customer_count)}</b> доступны для адресного подбора</span><span><b>{number(dataset.excluded_customer_count)}</b> исключены из подбора</span></div>
      </Card>
      <Card className="action-card"><div className="action-icon"><Lightbulb size={23} aria-hidden="true" /></div><p className="eyebrow">СЛЕДУЮЩИЙ ШАГ</p><h2>Найдём кампании с наибольшим ожидаемым эффектом</h2><p>Агент проверит предложения на небольших группах и соберёт план в заданных лимитах.</p><Link className="button button-primary" to="/runs/new">Подобрать кампании <ArrowRight size={18} aria-hidden="true" /></Link><small>Подбор не отправляет сообщения клиентам.</small></Card>
    </div>
    <div className="bottom-grid">
      <Card><CardHeader eyebrow="КОНКУРСНЫЙ РЕЖИМ" title="Ресурсы под контролем" />
        <div className="limit-list"><div><span>Бюджет коммуникаций</span><strong>{money(limits.budget)}</strong></div><div><span>Контакты, включая повторные</span><strong>{number(limits.contacts)}</strong></div><div><span>Проверки предложений</span><strong>до {number(limits.pilots)} пилотов</strong></div><div><span>Финальный план</span><strong>до {number(limits.final_campaigns)} кампаний</strong></div></div>
      </Card>
      <Card><CardHeader eyebrow="ИСТОРИЯ" title="Последний запуск" aside={last && <Link to="/runs" className="text-link">Все запуски <ArrowUpRight size={16} /></Link>} />
        {runs.isPending ? <Skeleton rows={3} /> : runs.error ? <ErrorPanel error={runs.error} onRetry={() => void runs.refetch()} /> : last ? <div className="last-run"><div><StatusPill tone={last.status === 'completed' ? last.forecast_net_gain != null && last.forecast_net_gain < 0 ? 'warning' : 'positive' : last.status === 'failed' ? 'negative' : 'neutral'}>{status(last.status)}</StatusPill><span>{when(last.created_at)}</span></div><h3>{risk(last.config.risk_profile)} подход</h3><p>Прогноз: {money(last.forecast_net_gain)}</p><Link to={`/runs/${last.id}`} className="text-link">Открыть запуск <ArrowRight size={16} /></Link></div> : <EmptyState title="Запусков пока нет" text="Первый подбор покажет проверенные предложения и сохранит план здесь." action={<Link to="/runs/new" className="text-link">Начать подбор <ArrowRight size={16} /></Link>} />}
      </Card>
    </div>
    <Card className="quality-card"><ShieldCheck size={20} aria-hidden="true" /><div><strong>Качество исходных данных</strong><p>{dataset.exclusion_reason} {dataset.excluded_customer_count > 0 && `${number(dataset.excluded_customer_count)} записей показаны отдельно в разделе «Аудитория».`}</p></div><Link to="/audience" className="text-link">Посмотреть <ArrowRight size={16} /></Link></Card>
  </div>
}
