import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleAlert, Clock3, Download, FileJson2, RefreshCw, X } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api/client'
import type { CampaignSpec, CampaignView, RunSnapshot } from '../../lib/api/types'
import { channel, elapsed, money, number, percentage, risk, segment, status, when } from '../../lib/format'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'

const evidence = { pilot_supported: 'Подтверждено пилотами', prior_only: 'Предварительная оценка', fallback: 'Резервный вариант' }
const phaseLabel = { queued: 'В очереди', audit: 'Аудит аудитории', candidates: 'Поиск гипотез', pilots: 'Проверка гипотез', planning: 'Планирование', evaluation: 'Локальная проверка', completed: 'Готово', failed: 'Ошибка' }

function audience(spec: CampaignSpec) {
  return `${segment(spec.filter_arpu_segment)} · ${spec.filter_current_tariff || 'тариф не указан'}`
}

function CampaignDrawer({ campaign, run, onClose }: { campaign: CampaignView | null; run: RunSnapshot; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (campaign && dialog.current && !dialog.current.open) { origin.current = document.activeElement as HTMLElement; dialog.current.showModal() }
    if (!campaign && dialog.current?.open) dialog.current.close()
  }, [campaign])
  return <dialog ref={dialog} className="campaign-dialog" onClose={() => { onClose(); origin.current?.focus() }} aria-label="Подробности кампании">
    {campaign && <div className="drawer-content"><div className="drawer-top"><div><p className="eyebrow">КАМПАНИЯ #{campaign.execution_order}</p><h2>{campaign.spec.campaign_name}</h2></div><button className="icon-button" type="button" onClick={() => dialog.current?.close()} aria-label="Закрыть подробности"><X size={20} /></button></div>
      <StatusPill tone={campaign.evidence === 'pilot_supported' ? 'positive' : campaign.evidence === 'fallback' ? 'warning' : 'neutral'}>{evidence[campaign.evidence]}</StatusPill>
      <div className="drawer-section"><h3>Кого охватывает</h3><p>{audience(campaign.spec)}</p><dl className="detail-list"><div><dt>Сегмент ARPU</dt><dd>{campaign.spec.filter_arpu_segment || 'Не задан'}</dd></div><div><dt>Текущий тариф</dt><dd>{campaign.spec.filter_current_tariff || 'Не задан'}</dd></div><div><dt>Сегмент трафика</dt><dd>{campaign.spec.filter_data_segment || 'Не задан'}</dd></div><div><dt>Сегмент звонков</dt><dd>{campaign.spec.filter_call_segment || 'Не задан'}</dd></div></dl></div>
      <div className="drawer-section"><h3>Предложение и ресурсы</h3><dl className="detail-list"><div><dt>Целевой тариф</dt><dd>{campaign.spec.target_tariff}</dd></div><div><dt>Канал</dt><dd>{channel(campaign.spec.channel)}</dd></div><div><dt>Контакты</dt><dd>{number(campaign.audience_count)}</dd></div><div><dt>Стоимость</dt><dd>{money(campaign.communication_cost)}</dd></div><div><dt>Предельный вклад</dt><dd>{money(campaign.expected_incremental_net_gain)}</dd></div><div><dt>Оценка эффекта</dt><dd>{percentage(campaign.expected_lift_ratio)}</dd></div></dl></div>
      <div className="drawer-section"><h3>Почему выбрана</h3><ul className="reason-list">{campaign.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>{campaign.warnings.map(warning => <p className="drawer-warning" key={warning}>{warning}</p>)}</div>
      <div className="drawer-section"><h3>Использованные пилоты</h3>{campaign.supporting_pilot_ids.length ? <ul className="reason-list">{campaign.supporting_pilot_ids.map(id => { const pilot = run.pilots.find(item => item.id === id); return <li key={id}>{pilot ? `Пилот ${pilot.sequence}: ${audience(pilot.campaign)}, наблюдение ${percentage(pilot.observed_lift_ratio)}` : id}</li> })}</ul> : <p>Для этой точной группы пилотных наблюдений нет.</p>}</div>
      <button className="button button-secondary drawer-close" onClick={() => dialog.current?.close()}>Закрыть</button>
    </div>}
  </dialog>
}

export function RunPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [tick, setTick] = useState(0)
  const [sort, setSort] = useState<'order' | 'gain' | 'contacts'>('order')
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null)
  const [exportError, setExportError] = useState<unknown>(null)
  const query = useQuery({ queryKey: ['run', id], queryFn: ({ signal }) => api.run(id, signal), enabled: !!id,
    refetchInterval: q => q.state.error || ['completed', 'failed'].includes(q.state.data?.status || '') ? false : 1000,
    networkMode: 'always', retry: false })
  const run = query.data
  const active = run?.status === 'queued' || run?.status === 'running'
  useEffect(() => { if (!active) return; const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer) }, [active])
  const sorted = useMemo(() => {
    const list = [...(run?.campaigns || [])]
    if (sort === 'gain') list.sort((a, b) => (b.expected_incremental_net_gain ?? -Infinity) - (a.expected_incremental_net_gain ?? -Infinity))
    if (sort === 'contacts') list.sort((a, b) => b.audience_count - a.audience_count)
    return list
  }, [run?.campaigns, sort])
  const chosen = run?.campaigns.find(item => item.id === params.get('campaign')) || null
  const closeDrawer = () => { const next = new URLSearchParams(params); next.delete('campaign'); setParams(next, { replace: true }) }
  const openCampaign = (campaignId: string) => { const next = new URLSearchParams(params); next.set('campaign', campaignId); setParams(next) }
  async function download(kind: 'csv' | 'json') {
    if (!run || run.status !== 'completed') return
    setExporting(kind); setExportError(null)
    try { await api.download(run.id, kind) } catch (error) { setExportError(error) } finally { setExporting(null) }
  }

  if (query.isPending) return <div className="page-stack"><Card><Skeleton rows={4} /></Card><Card><Skeleton rows={6} /></Card></div>
  if (!run) return <div className="page-stack"><Link className="text-link" to="/runs"><ArrowLeft size={16} /> К запускам</Link><ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Запуск недоступен" /></div>
  const negative = run.forecast != null && run.forecast.expected_net_gain < 0
  const budget = run.resources.budget
  const spentPilots = budget.used_by_pilots
  const spentFinal = budget.planned_final ?? 0
  const remaining = budget.remaining_after_plan ?? Math.max(0, budget.limit - spentPilots)
  return <div className="page-stack run-page">
    <div className="run-heading"><div><Link to="/runs" className="back-link"><ArrowLeft size={16} /> Все запуски</Link><div className="run-title"><h2>{run.status === 'completed' ? 'План готов' : run.status === 'failed' ? 'Расчёт завершился ошибкой' : 'Агент проверяет гипотезы'}</h2><StatusPill tone={run.status === 'failed' ? 'negative' : run.status === 'completed' ? negative ? 'warning' : 'positive' : 'neutral'}>{status(run.status)}</StatusPill></div><p>{when(run.created_at)} · {risk(run.config.risk_profile)} подход · seed {run.config.seed} · {run.id.slice(0, 8)}</p></div><span className="run-elapsed"><Clock3 size={16} aria-hidden="true" /> {elapsed(run.created_at, active ? tick || new Date(run.created_at).getTime() : run.completed_at ? new Date(run.completed_at).getTime() : tick)}</span></div>
    {query.error && <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Соединение прервалось" />}
    {run.status === 'failed' && <Card className="failure-card"><CircleAlert size={24} aria-hidden="true" /><div><h3>План не завершён</h3><p>{run.failure?.message || 'Не удалось завершить расчёт.'} Доступные пилоты и журнал сохранены.</p><Link to="/runs/new" className="button button-secondary">Повторить расчёт как новый запуск <ArrowRight size={16} /></Link></div></Card>}
    {active && <Card className="progress-card"><div className="progress-top"><span className="eyebrow">ТЕКУЩИЙ ЭТАП · {phaseLabel[run.phase]}</span><span className="live-dot" aria-hidden="true" /></div><h3 aria-live="polite" aria-atomic="true">{run.phase_message}</h3><p>Расчёт продолжается на сервере при переходе между страницами.</p><div className="progress-stats"><div><strong>{number(run.resources.pilots_used)} <small>из максимум {number(run.resources.pilots_limit)}</small></strong><span>Проверено гипотез</span></div><div><strong>{money(run.resources.budget.used_by_pilots)}</strong><span>Затраты пилотов</span></div><div><strong>{number(run.resources.contacts.used_by_pilots)}</strong><span>Контакты пилотов</span></div></div></Card>}
    {run.status === 'completed' && <>
      {negative && <Card className="negative-card"><CircleAlert size={22} aria-hidden="true" /><div><h3>Уверенно выгодные варианты не найдены</h3><p>Прогноз плана отрицательный. Конкурсный контракт требует хотя бы одну кампанию; агент сохранил допустимый вариант с наименьшим ожидаемым ущербом. Техническая корректность не означает ожидаемую выгоду.</p></div></Card>}
      <div className="result-grid"><Card className="forecast-card"><CardHeader eyebrow="ПРОГНОЗ АГЕНТА" title="Ожидаемый эффект" /><div className={`result-main ${negative ? 'negative' : ''}`}>{money(run.forecast?.expected_net_gain)}</div><p>Дополнительная выручка за вычетом коммуникаций, включая пилоты. Это оценка модели.</p>{run.forecast?.net_gain_interval ? <div className="interval"><span>Расчётный диапазон ({percentage(run.forecast.net_gain_interval.level)})</span><strong>{money(run.forecast.net_gain_interval.low)} — {money(run.forecast.net_gain_interval.high)}</strong><small>{run.forecast.net_gain_interval.method}</small></div> : <p className="fine-print">Диапазон неопределённости не рассчитан.</p>}</Card>
        <Card className="local-card"><CardHeader eyebrow="ЛОКАЛЬНАЯ ПРОВЕРКА" title="Синтетический оценщик" /><div className={`result-main compact ${run.local_evaluation && run.local_evaluation.net_arpu_gain < 0 ? 'negative' : ''}`}>{money(run.local_evaluation?.net_arpu_gain)}</div><p>Фактический результат публичной mock-модели. Не прогноз скрытой проверки и не реальный доход.</p><div className="local-details"><span>Коммуникации <b>{money(run.local_evaluation?.communication_cost)}</b></span><span>Контакты <b>{number(run.local_evaluation?.total_contacts)}</b></span><span>Уникальный охват <b>{number(run.local_evaluation?.unique_customers)}</b></span></div></Card></div>
      <Card className="budget-card"><CardHeader eyebrow="РАСПРЕДЕЛЕНИЕ РЕСУРСОВ" title="Бюджет и охват" /><div className="budget-bar" role="img" aria-label={`Из бюджета ${money(budget.limit)}: пилоты ${money(spentPilots)}, финальный план ${money(spentFinal)}, остаток ${money(remaining)}`}><span className="budget-pilots" style={{ width: `${spentPilots / budget.limit * 100}%` }} /><span className="budget-final" style={{ width: `${spentFinal / budget.limit * 100}%` }} /><span className="budget-left" style={{ width: `${remaining / budget.limit * 100}%` }} /></div><div className="budget-legend"><span><i className="key-pilots" /> Пилоты <b>{money(spentPilots)}</b></span><span><i className="key-final" /> Финальный план <b>{money(spentFinal)}</b></span><span><i className="key-left" /> Остаток <b>{money(remaining)}</b></span></div><div className="resource-foot">Контакты: {number(run.resources.contacts.used_by_pilots)} в пилотах + {number(run.resources.contacts.planned_final)} в плане. Уникальный охват: {number(run.forecast?.expected_unique_reach)} по оценке агента.</div></Card>
      <Card className="table-card"><CardHeader eyebrow="ФИНАЛЬНОЕ РЕШЕНИЕ" title="План кампаний" aside={<span className="result-count">{number(run.campaigns.length)} кампаний</span>} /><p className="table-explainer">Предельный вклад оценивается с учётом предыдущих кампаний. Сортировка меняет только отображение; номер исполнения остаётся прежним.</p><div className="table-controls"><label className="select-field"><span>Сортировка</span><select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="order">Порядок исполнения</option><option value="gain">Оценённый вклад</option><option value="contacts">Контакты</option></select></label></div>
        {sorted.length ? <><div className="mobile-campaigns">{sorted.map(campaign => <article className="mobile-campaign" key={campaign.id}><div className="mobile-campaign-head"><span className="order-cell">#{campaign.execution_order}</span><strong>{audience(campaign.spec)}</strong><button className="icon-button" aria-label={`Подробности кампании ${campaign.execution_order}`} onClick={() => openCampaign(campaign.id)}><ChevronRight size={18} /></button></div><p>{campaign.spec.target_tariff} · {channel(campaign.spec.channel)} · {evidence[campaign.evidence]}</p><div className="mobile-campaign-facts"><span>Контакты <b>{number(campaign.audience_count)}</b></span><span>Стоимость <b>{money(campaign.communication_cost)}</b></span><span>Вклад <b className={campaign.expected_incremental_net_gain != null && campaign.expected_incremental_net_gain < 0 ? 'negative-text' : ''}>{money(campaign.expected_incremental_net_gain)}</b></span></div></article>)}</div><div className="table-scroll plan-table-scroll" role="region" aria-label="Финальный план кампаний" tabIndex={0}><table><thead><tr><th>№</th><th>Аудитория</th><th>Предложение</th><th className="number-cell">Контакты</th><th className="number-cell">Стоимость</th><th className="number-cell">Предельный вклад</th><th>Обоснование</th><th aria-label="Подробности" /></tr></thead><tbody>{sorted.map(campaign => <tr key={campaign.id}><td className="order-cell">{campaign.execution_order}</td><td><strong>{audience(campaign.spec)}</strong><small className="table-subline">{evidence[campaign.evidence]}</small></td><td>{campaign.spec.target_tariff}<small className="table-subline">{channel(campaign.spec.channel)}</small></td><td className="number-cell">{number(campaign.audience_count)}</td><td className="number-cell">{money(campaign.communication_cost)}</td><td className={`number-cell ${campaign.expected_incremental_net_gain != null && campaign.expected_incremental_net_gain < 0 ? 'negative-text' : ''}`}>{money(campaign.expected_incremental_net_gain)}</td><td className="reason-cell">{campaign.reasons[0] || '—'}</td><td><button className="icon-button" aria-label={`Подробности кампании ${campaign.execution_order}`} onClick={() => openCampaign(campaign.id)}><ChevronRight size={19} /></button></td></tr>)}</tbody></table></div></> : <EmptyState title="Кампаний пока нет" text="Сохранённый план не содержит кампаний." />}
      </Card>
    </>}
    <div className="activity-grid"><Card><CardHeader eyebrow="ИССЛЕДОВАНИЕ" title="Пилоты" aside={<span className="result-count">{run.pilots.length} из максимум {run.resources.pilots_limit}</span>} />{run.pilots.length ? <div className="pilot-list">{run.pilots.map(pilot => <article className="pilot-item" key={pilot.id}><div className="pilot-head"><span className="pilot-seq">{pilot.sequence.toString().padStart(2, '0')}</span><div><strong>{audience(pilot.campaign)}</strong><small>{pilot.campaign.target_tariff} · {channel(pilot.campaign.channel)}</small></div><span className={pilot.observed_lift_ratio < 0 ? 'negative-text' : 'positive-text'}>{percentage(pilot.observed_lift_ratio)}</span></div><p>{pilot.selection_reason}</p><div className="pilot-facts">Выборка {number(pilot.actual_customers)} из {number(pilot.requested_customers)} · Расход {money(pilot.cost)}</div><div className="pilot-decision"><Check size={15} aria-hidden="true" /> {pilot.decision_after}</div></article>)}</div> : <EmptyState title="Пилотов пока нет" text="После первой проверки здесь появятся фактическая выборка, эффект и решение агента." />}</Card>
      <Card><CardHeader eyebrow="ХОД РАБОТЫ" title="Журнал решений" />{run.events.length ? <ol className="event-list">{run.events.map(event => <li key={event.id}><span className="event-point" /><div><small>{when(event.created_at)} · {phaseLabel[event.phase]}</small><strong>{event.title}</strong><p>{event.message}</p></div></li>)}</ol> : <EmptyState title="Ожидаем первые события" text="Фактические шаги появятся в журнале по мере выполнения." />}</Card></div>
    <Card className="export-card"><div><p className="eyebrow">СОХРАНЁННЫЙ РЕЗУЛЬТАТ</p><h2>Файлы этого запуска</h2><p>CSV содержит только план кампаний. Конкурсный submission.csv создаётся отдельно штатной командой.</p>{run.status !== 'completed' && <small>Экспорт доступен после завершения и сохранения плана.</small>}</div><div className="export-actions"><button className="button button-primary" disabled={run.status !== 'completed' || exporting !== null} onClick={() => void download('csv')}><Download size={17} /> {exporting === 'csv' ? 'Загрузка…' : 'Скачать план CSV'}</button><button className="button button-secondary" disabled={run.status !== 'completed' || exporting !== null} onClick={() => void download('json')}><FileJson2 size={17} /> {exporting === 'json' ? 'Загрузка…' : 'Скачать отчёт JSON'}</button></div></Card>
    {exportError != null && <ErrorPanel error={exportError} onRetry={() => setExportError(null)} title="Не удалось скачать файл" />}
    {query.error && <button className="button button-secondary reconnect" onClick={() => void query.refetch()}><RefreshCw size={16} /> Восстановить соединение</button>}
    <CampaignDrawer campaign={chosen} run={run} onClose={closeDrawer} />
  </div>
}
