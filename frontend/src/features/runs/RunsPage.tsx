import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api/client'
import { money, risk, status, when } from '../../lib/format'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'

export function RunsPage() {
  const query = useQuery({ queryKey: ['runs', 20], queryFn: ({ signal }) => api.runs(20, signal), refetchInterval: q => q.state.data?.items.some(item => item.status === 'queued' || item.status === 'running') ? 2000 : false })
  if (query.isPending && !query.isError) return <Card><Skeleton rows={6} /></Card>
  if (query.error && !query.data) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="История недоступна" />
  const runs = query.data?.items || []
  return <div className="page-stack"><div className="section-intro with-action"><div><p className="eyebrow">СОХРАНЁННЫЕ РЕШЕНИЯ</p><h2>История запусков</h2><p>Прогноз агента и результат локальной синтетической оценки показаны отдельно.</p></div><Link to="/runs/new" className="button button-primary"><Plus size={18} /> Новый подбор</Link></div>
    {query.error && <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Связь с историей прервалась" />}
    <Card className="table-card"><CardHeader eyebrow="ПОСЛЕДНИЕ ЗАПУСКИ" title="Расчёты" aside={<span className="result-count">{runs.length} записей</span>} />
      {runs.length === 0 ? <EmptyState title="Здесь появятся запуски" text="Начните подбор, чтобы сохранить журнал и финальный план." action={<Link to="/runs/new" className="text-link">Подобрать кампании <ArrowRight size={16} /></Link>} /> : <div className="table-scroll" role="region" aria-label="История запусков" tabIndex={0}><table><thead><tr><th>Дата</th><th>Риск-профиль</th><th>Статус</th><th className="number-cell">Прогноз агента</th><th className="number-cell">Локальная симуляция</th><th aria-label="Открыть" /></tr></thead><tbody>{runs.map(run => <tr key={run.id}><td><strong>{when(run.created_at)}</strong><small className="table-subline">{run.id.slice(0, 8)}</small></td><td>{risk(run.config.risk_profile)}</td><td><StatusPill tone={run.status === 'failed' ? 'negative' : run.status === 'completed' ? run.forecast_net_gain != null && run.forecast_net_gain < 0 ? 'warning' : 'positive' : 'neutral'}>{status(run.status)}</StatusPill></td><td className="number-cell">{money(run.forecast_net_gain)}</td><td className="number-cell">{money(run.local_net_gain)}</td><td><Link to={`/runs/${run.id}`} className="icon-link" aria-label={`Открыть запуск от ${when(run.created_at)}`}><ArrowRight size={18} /></Link></td></tr>)}</tbody></table></div>}
    </Card>
  </div>
}
