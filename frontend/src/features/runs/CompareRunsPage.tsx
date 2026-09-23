import { useQueries } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, GitCompareArrows, Info, ShieldCheck } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import type { CSSProperties, ReactNode } from 'react'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'
import { api } from '../../lib/api/client'
import type { CampaignView, RunSnapshot } from '../../lib/api/types'
import { channel, money, number, percentage, risk, segment, status, tariff, when } from '../../lib/format'
import { campaignSignature, comparisonDifferences, parseComparisonIds } from '../../lib/runComparison'
import { useRunNotes } from '../../lib/runNotes'
import './run-organization.css'

function campaignAudience(campaign: CampaignView) {
  const spec = campaign.spec
  return `${spec.filter_arpu_segment ? spec.filter_arpu_segment.split(';').map(segment).join(', ') : 'Все уровни выручки'} · ${spec.filter_current_tariff ? spec.filter_current_tariff.split(';').map(tariff).join(', ') : 'все текущие тарифы'}`
}

export function CompareRunsPage() {
  const [params] = useSearchParams()
  const ids = parseComparisonIds(params.get('ids'))
  const { notes } = useRunNotes()
  const queries = useQueries({ queries: (ids || []).map(id => ({
    queryKey: ['run', id], queryFn: ({ signal }: { signal: AbortSignal }) => api.run(id, signal),
    refetchInterval: (query: { state: { data: RunSnapshot | undefined } }) => query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 2000 : false as const,
  })) })
  if (!ids) return <Card><EmptyState title="Выберите два или три расчёта" text="Откройте историю, отметьте нужные строки и нажмите «Сравнить». В сравнении каждый расчёт должен быть выбран один раз." action={<Link className="button button-primary" to="/runs">Открыть историю <ArrowRight size={17} aria-hidden="true" /></Link>} /></Card>

  const runs = queries.flatMap(query => query.data ? [query.data] : [])
  const allLoaded = runs.length === ids.length
  const differences = comparisonDifferences(runs)
  const signatures = new Map<string, Set<string>>()
  runs.forEach(run => run.campaigns.forEach(campaign => {
    const key = campaignSignature(campaign)
    if (!signatures.has(key)) signatures.set(key, new Set())
    signatures.get(key)!.add(run.id)
  }))
  const row = (title: string, render: (run: RunSnapshot) => ReactNode, className = '') => <tr key={title}><th scope="row">{title}</th>{queries.map((query, index) => <td key={ids[index]} className={className}>{query.data ? render(query.data) : query.isError ? 'Не удалось загрузить' : 'Загружаем…'}</td>)}</tr>
  const baseline = queries[0]?.data?.forecast?.expected_net_gain

  return <div className="page-stack run-comparison-page">
    <div className="section-intro with-action"><div><p className="eyebrow">ВАРИАНТЫ РЯДОМ</p><h2>Сравнение расчётов</h2><p>Посмотрите, как изменились ожидаемый эффект, расходы и выбранные предложения. Первый расчёт слева — точка отсчёта для разницы.</p></div><Link to="/runs" className="button button-secondary"><ArrowLeft size={17} aria-hidden="true" />К истории</Link></div>
    <Card className="comparison-fairness"><CardHeader eyebrow="ПРЕЖДЕ ЧЕМ ВЫБИРАТЬ" title="Насколько честно это сравнение" aside={<ShieldCheck size={24} aria-hidden="true" />} />
      {!allLoaded ? <p>Для проверки условий нужны все выбранные расчёты. Дождитесь загрузки или повторите запрос для недоступного варианта.</p> : differences.length ? <ul>{differences.map(item => <li key={item}>{item}</li>)}</ul> : <p>Совпадают набор данных, режим, номер сценария и сохранённые ограничения. Можно изучать разницу между подходами к риску и составом планов.</p>}
      <p className="comparison-version-note"><Info size={17} aria-hidden="true" />Версия алгоритма в отчётах не сохранена. Её совпадение не подтверждено; одинаковый номер версии API этого не гарантирует. Более высокий прогноз сам по себе не доказывает, что план лучше.</p>
    </Card>
    <div className="comparison-status-grid">{queries.map((query, index) => <div key={ids[index]}>{query.error && <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title={`Не удалось обновить расчёт ${index + 1}${query.data ? ' — показаны последние данные' : ''}`} />}{query.isPending && <Card><Skeleton rows={2} /></Card>}</div>)}</div>
    <Card className="comparison-metrics"><CardHeader eyebrow="ЭФФЕКТ И РЕСУРСЫ" title="Что меняется в цифрах" aside={<GitCompareArrows size={23} aria-hidden="true" />} />
      <p>Ожидаемый эффект — дополнительная выручка после расходов на связь, включая пробные проверки. Симуляция — учебная проверка, а не реальный доход.</p>
      <p className="table-hint">На небольшом экране прокрутите таблицу вправо →</p>
      <div className="table-scroll" role="region" aria-label="Сравнение показателей расчётов" tabIndex={0}><table className="comparison-table"><caption className="sr-only">Показатели выбранных расчётов</caption><thead><tr><th scope="col">Показатель</th>{ids.map((id, index) => <th scope="col" key={id}><Link to={`/runs/${encodeURIComponent(id)}`}>{notes[id]?.name || `Расчёт ${index + 1}`}</Link><small>{queries[index].data ? when(queries[index].data!.created_at) : id}</small></th>)}</tr></thead><tbody>
        {row('Статус', run => <StatusPill tone={run.status === 'failed' ? 'negative' : 'neutral'}>{status(run.status)}</StatusPill>)}
        {row('Прогноз эффекта', run => money(run.forecast?.expected_net_gain), 'comparison-primary-value')}
        {row('Разница с первым расчётом', run => {
          const value = run.forecast?.expected_net_gain
          if (value == null || baseline == null) return 'Пока нет оценки'
          if (run.id === ids[0]) return 'Точка отсчёта'
          return `${value > baseline ? '+' : ''}${money(value - baseline)}`
        })}
        {row('Диапазон прогноза', run => run.forecast?.net_gain_interval ? `${money(run.forecast.net_gain_interval.low)} … ${money(run.forecast.net_gain_interval.high)}; уровень ${percentage(run.forecast.net_gain_interval.level)}` : 'Не сохранён')}
        {row('Проверка в симуляции', run => money(run.local_evaluation?.net_arpu_gain))}
        {row('Плановые расходы на связь с проверками', run => run.resources.budget.planned_final == null ? 'Пока нет оценки' : money(run.resources.budget.used_by_pilots + run.resources.budget.planned_final))}
        {row('Остаток бюджета', run => money(run.resources.budget.remaining_after_plan))}
        {row('Уникальный охват по прогнозу', run => run.forecast?.expected_unique_reach == null ? 'Не сохранён' : number(run.forecast.expected_unique_reach))}
        {row('Предложений в плане', run => number(run.campaigns.length))}
        {row('Только исторические оценки', run => number(run.campaigns.filter(campaign => campaign.evidence === 'prior_only').length))}
        {row('Резервных предложений', run => number(run.campaigns.filter(campaign => campaign.evidence === 'fallback').length))}
        {row('Замечаний к расчёту', run => number(run.warnings.length))}
        {row('Подход к риску', run => risk(run.config.risk_profile))}
        {row('Номер сценария', run => number(run.config.seed))}
        {row('Режим', run => run.mode === 'demo' ? 'Демонстрация' : 'Локальная симуляция')}
        {row('Набор данных', run => <span className="comparison-dataset">{run.dataset_id}</span>)}
        {row('Заметка в этом браузере', run => notes[run.id]?.note || 'Нет заметки')}
      </tbody></table></div>
    </Card>
    <div className="comparison-plan-intro"><h2>Чем отличаются предложения</h2><p>Совпадение означает одинаковые фильтры аудитории, целевой тариф и канал. Количество клиентов, порядок выполнения и эффект могут отличаться; это не подтверждает совпадение конкретных абонентов.</p></div>
    <div className="comparison-plans" style={{ '--comparison-count': ids.length } as CSSProperties}>{queries.map((query, index) => <Card key={ids[index]}><CardHeader eyebrow={`ВАРИАНТ ${index + 1}`} title={notes[ids[index]]?.name || `Расчёт ${index + 1}`} />{query.data ? <>
      {query.data.campaigns.length === 0 && <p>Предложения пока не сохранены.</p>}
      <ol className="comparison-campaigns">{[...query.data.campaigns].sort((a, b) => a.execution_order - b.execution_order).map(campaign => <li key={campaign.id}><span className="comparison-order">{campaign.execution_order}</span><div><h3>{tariff(campaign.spec.target_tariff)}</h3><p>{channel(campaign.spec.channel)}</p><p>{campaignAudience(campaign)}</p>{(campaign.spec.filter_data_segment || campaign.spec.filter_call_segment) && <p>Есть дополнительные фильтры интернета или звонков; точные условия — в плане.</p>}<dl><div><dt>Контакты</dt><dd>{number(campaign.audience_count)}</dd></div><div><dt>Расходы</dt><dd>{money(campaign.communication_cost)}</dd></div><div><dt>Вклад в результат</dt><dd>{money(campaign.expected_incremental_net_gain)}</dd></div></dl><span className="comparison-match">{!allLoaded ? 'Для сравнения условий нужна загрузка всех вариантов' : signatures.get(campaignSignature(campaign))!.size > 1 ? `Такие же условия в ${signatures.get(campaignSignature(campaign))!.size} вариантах` : 'Такие условия только в этом варианте'}</span></div></li>)}</ol>
      <Link className="button button-secondary" to={`/runs/${encodeURIComponent(ids[index])}`}>Открыть расчёт <ArrowRight size={16} aria-hidden="true" /></Link>
    </> : <p>{query.isError ? 'Данные недоступны. Повторите запрос выше.' : 'Загружаем предложения…'}</p>}</Card>)}</div>
  </div>
}
