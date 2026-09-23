import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, ChevronRight, CircleAlert, Clock3, Download, FileJson2, Info, ListChecks, Printer, RefreshCw, X } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api/client'
import type { CampaignSpec, CampaignView, RunSnapshot } from '../../lib/api/types'
import { channel, elapsed, filterLabel, money, number, percentage, risk, segment, status, tariff, when } from '../../lib/format'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'
import { TechnicalDetails } from '../../components/ui/TechnicalDetails'
import { explainCampaignReason, explainCampaignWarning, explainNotice, explainPhaseMessage, explainPilotDecision } from '../../lib/explanations'
import { ResearchActivity } from './ResearchActivity'
import { RunAnalysis } from './RunAnalysis'
import { RunNotebook } from './RunNotebook'
import { CampaignWhatIf } from './CampaignWhatIf'
import './run-experience.css'

const evidence = { pilot_supported: 'Есть пробные проверки', prior_only: 'Предварительная оценка', fallback: 'Резервный вариант' }
const evidenceHelp = {
  pilot_supported: 'При выборе использованы пилотные наблюдения. Они снижают неопределённость, но не гарантируют будущий эффект.',
  prior_only: 'Оценка опирается на исходные предположения модели. Прямых пилотных наблюдений для этой кампании недостаточно.',
  fallback: 'Программа не нашла план с положительным эффектом с учётом риска, но условия задачи требуют хотя бы одно предложение. Поэтому сохранён допустимый резервный вариант. Его выгода не подтверждена.',
}
const phaseLabel = { queued: 'В очереди', audit: 'Проверка данных', candidates: 'Подбор предложений', pilots: 'Пробные проверки', planning: 'Составление плана', evaluation: 'Проверка в учебной среде', completed: 'Готово', failed: 'Ошибка' }

function audience(spec: CampaignSpec) {
  const segments = spec.filter_arpu_segment?.split(';').map(value => segment(value.trim())).join(', ') || 'Все уровни выручки'
  const tariffs = spec.filter_current_tariff?.split(';').map(value => tariff(value.trim())).join(', ') || 'все текущие тарифы'
  return `${segments} · ${tariffs}`
}

function CampaignDrawer({ campaign, run, onClose }: { campaign: CampaignView | null; run: RunSnapshot; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  const isOpen = campaign !== null
  useEffect(() => {
    if (isOpen && dialog.current && !dialog.current.open) {
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.current.showModal()
    }
    if (!isOpen && dialog.current?.open) dialog.current.close()
  }, [isOpen])
  useEffect(() => {
    if (!isOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [isOpen])
  return <dialog ref={dialog} className="campaign-dialog" aria-label="Подробности кампании" aria-describedby={campaign ? 'campaign-evidence-help' : undefined}
    onClose={() => { if (campaign) onClose(); if (origin.current?.isConnected) origin.current.focus() }}
    onClick={event => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.current?.close() }}>
    {campaign && <div className="drawer-content">
      <div className="drawer-top"><div><p className="eyebrow">КАМПАНИЯ #{campaign.execution_order} · ПОРЯДОК ИСПОЛНЕНИЯ</p><h2>Предложение №{campaign.execution_order}: {tariff(campaign.spec.target_tariff)}</h2></div><button className="icon-button" type="button" onClick={() => dialog.current?.close()} aria-label="Закрыть подробности"><X size={20} aria-hidden="true" /></button></div>
      <StatusPill tone={campaign.evidence === 'pilot_supported' ? 'positive' : campaign.evidence === 'fallback' ? 'warning' : 'neutral'}>{evidence[campaign.evidence]}</StatusPill>
      <p id="campaign-evidence-help" className="drawer-explanation">{evidenceHelp[campaign.evidence]}</p>
      <div className="drawer-section"><h3>Кого охватывает</h3><p>{audience(campaign.spec)}</p><p>ARPU — средняя выручка на абонента. Фильтры ниже применяются одновременно; «Все» означает отсутствие ограничения по этому признаку.</p><dl className="detail-list"><div><dt>Сегмент ARPU</dt><dd>{campaign.spec.filter_arpu_segment?.split(';').map(value => segment(value.trim())).join(', ') || 'Все'}</dd></div><div><dt>Текущий тариф</dt><dd>{campaign.spec.filter_current_tariff?.split(';').map(value => tariff(value.trim())).join(', ') || 'Все'}</dd></div><div><dt>Сегмент трафика</dt><dd>{filterLabel(campaign.spec.filter_data_segment, 'data')}</dd></div><div><dt>Сегмент звонков</dt><dd>{filterLabel(campaign.spec.filter_call_segment, 'calls')}</dd></div></dl></div>
      <div className="drawer-section"><h3>Предложение и ресурсы</h3><dl className="detail-list"><div><dt>Целевой тариф</dt><dd>{tariff(campaign.spec.target_tariff)}</dd></div><div><dt>Канал</dt><dd>{channel(campaign.spec.channel)}</dd></div><div><dt>Контакты кампании</dt><dd>{number(campaign.audience_count)}</dd></div><div><dt>Стоимость коммуникаций</dt><dd>{money(campaign.communication_cost)}</dd></div><div><dt>Вклад в результат</dt><dd className={campaign.expected_incremental_net_gain != null && campaign.expected_incremental_net_gain < 0 ? 'negative-text' : ''}>{money(campaign.expected_incremental_net_gain)}</dd></div><div><dt>Прогноз прироста выручки</dt><dd>{percentage(campaign.expected_lift_ratio)}</dd></div></dl><p>Вклад в результат — сколько эта кампания добавляет к прогнозу после предыдущих кампаний и пилотов, с учётом расходов. Его нельзя прибавлять к общему эффекту повторно.</p><p>Процент прироста рассчитан относительно базовой выручки аудитории этой кампании до учёта пересечений с другими кампаниями.</p></div>
      <div className="drawer-section"><h3>Почему выбрана</h3>{campaign.reasons.length ? <ul className="reason-list">{campaign.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{explainCampaignReason(reason).text}</li>)}</ul> : <p>Подробное обоснование не сохранено в этом запуске.</p>}{campaign.warnings.map((warning, index) => <p className="drawer-warning" key={`${index}-${warning}`}><CircleAlert size={16} aria-hidden="true" /> {explainCampaignWarning(warning).text}</p>)}</div>
      <div className="drawer-section"><h3>На какие пробные проверки опирались</h3>{campaign.supporting_pilot_ids.length ? <ul className="drawer-pilots">{campaign.supporting_pilot_ids.map(id => { const pilot = run.pilots.find(item => item.id === id); return <li key={id}>{pilot ? <><strong>Проверка {pilot.sequence} · {percentage(pilot.observed_lift_ratio)}</strong><span>{audience(pilot.campaign)}</span><small>{channel(pilot.campaign.channel)} · {number(pilot.actual_customers)} абонентов · {money(pilot.cost)}</small><p>{explainPilotDecision(pilot).text}</p></> : <span>Проверка {id}: подробности недоступны в сохранённом отчёте.</span>}</li> })}</ul> : <p>Для этой точной группы пробные проверки не проводились или не сохранены.</p>}<p>Наблюдение на небольшой выборке содержит шум. Один отрицательный пилот ещё не означает, что предложение невыгодно.</p></div>
      <TechnicalDetails summary="Точные фильтры, коды и исходные пояснения">{JSON.stringify({ campaign: campaign.spec, reasons: campaign.reasons, warnings: campaign.warnings }, null, 2)}</TechnicalDetails>
      <button type="button" className="button button-secondary drawer-close" onClick={() => dialog.current?.close()}>Закрыть</button><p className="drawer-keyboard-hint">Закрыть панель также можно клавишей Esc.</p>
    </div>}
  </dialog>
}

export function RunPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [tick, setTick] = useState(() => Date.now())
  const [sort, setSort] = useState<'order' | 'gain' | 'contacts'>('order')
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null)
  const [exportError, setExportError] = useState<{ kind: 'csv' | 'json'; error: unknown } | null>(null)
  const [exportMessage, setExportMessage] = useState('')
  const downloadPending = useRef(false)
  const query = useQuery({ queryKey: ['run', id], queryFn: ({ signal }) => api.run(id, signal), enabled: !!id,
    refetchInterval: q => ['completed', 'failed'].includes(q.state.data?.status || '') ? false : q.state.error ? 2500 : 1000,
    networkMode: 'always', retry: false })
  const run = query.data
  const active = run?.status === 'queued' || run?.status === 'running'
  useEffect(() => { if (!active) return; const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer) }, [active, id])
  const sorted = useMemo(() => {
    const list = [...(run?.campaigns || [])]
    list.sort((a, b) => {
      if (sort === 'gain') {
        if (a.expected_incremental_net_gain == null && b.expected_incremental_net_gain != null) return 1
        if (b.expected_incremental_net_gain == null && a.expected_incremental_net_gain != null) return -1
        const gain = (b.expected_incremental_net_gain ?? 0) - (a.expected_incremental_net_gain ?? 0)
        if (gain) return gain
      }
      if (sort === 'contacts' && a.audience_count !== b.audience_count) return b.audience_count - a.audience_count
      return a.execution_order - b.execution_order
    })
    return list
  }, [run?.campaigns, sort])
  const chosen = run?.campaigns.find(item => item.id === params.get('campaign')) || null
  const closeDrawer = () => { const next = new URLSearchParams(params); next.delete('campaign'); setParams(next, { replace: true }) }
  const openCampaign = (campaignId: string) => { const next = new URLSearchParams(params); next.set('campaign', campaignId); setParams(next) }
  async function download(kind: 'csv' | 'json') {
    if (!run || run.status !== 'completed' || downloadPending.current) return
    downloadPending.current = true
    setExporting(kind); setExportError(null); setExportMessage('')
    try { await api.download(run.id, kind); setExportMessage(`${kind.toUpperCase()} передан браузеру. Файл доступен в загрузках.`) }
    catch (error) { setExportError({ kind, error }) }
    finally { downloadPending.current = false; setExporting(null) }
  }

  if (query.isPending && !query.isError) return <div className="page-stack"><Card><Skeleton rows={4} /></Card><Card><Skeleton rows={6} /></Card></div>
  if (!run) return <div className="page-stack"><Link className="text-link" to="/runs"><ArrowLeft size={16} aria-hidden="true" /> К запускам</Link><ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Запуск недоступен" /></div>
  const negative = run.forecast != null && run.forecast.expected_net_gain < 0
  const uncertain = run.forecast?.net_gain_interval != null && run.forecast.net_gain_interval.low <= 0 && run.forecast.net_gain_interval.high >= 0
  const completed = run.status === 'completed'
  const budget = run.resources.budget
  const spentPilots = budget.used_by_pilots
  const spentFinal = budget.planned_final
  const remaining = budget.remaining_after_plan
  const budgetWidth = (value: number | null) => `${budget.limit > 0 && value != null ? Math.min(100, Math.max(0, value / budget.limit * 100)) : 0}%`
  const endTime = active ? Math.max(tick, query.dataUpdatedAt) : new Date(run.completed_at || run.updated_at).getTime()

  return <div className="page-stack run-page">
    <div className="run-heading"><div><Link to="/runs" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> Все запуски</Link><div className="run-title"><h2>{completed ? 'План готов' : run.status === 'failed' ? 'Расчёт завершился ошибкой' : 'Программа подбирает предложения'}</h2><StatusPill tone={run.status === 'failed' ? 'negative' : completed ? negative || uncertain ? 'warning' : 'neutral' : 'neutral'}>{status(run.status)}</StatusPill></div><p>{when(run.created_at)} · {risk(run.config.risk_profile)} подход · номер сценария {run.config.seed}</p></div><div className="run-heading-meta"><span className="run-elapsed"><Clock3 size={16} aria-hidden="true" /> {active ? 'Прошло' : 'Длительность'} {elapsed(run.created_at, endTime)}</span><span className="run-id" title={run.id}>Запуск {run.id.slice(0, 8)}</span></div></div>
    <div className="run-presentation-actions">{completed && <Link className="button button-secondary" to={`/runs/${encodeURIComponent(run.id)}/report`}><Printer size={17} aria-hidden="true" /> Отчёт для PDF</Link>}<Link className="button button-subtle" to={`/runs?compare=${encodeURIComponent(run.id)}`}>Сравнить с другим запуском <ArrowRight size={16} aria-hidden="true" /></Link></div>
    <div className="run-reading-guide"><Info size={20} aria-hidden="true" /><div><strong>{completed ? 'Как прочитать результат' : run.status === 'failed' ? 'Что можно сделать дальше' : 'Что сейчас происходит'}</strong><p>{completed ? <>Начните с <a href="#run-analysis">разбора результата</a>: он подскажет, что стоит проверить. Затем посмотрите <a href="#campaign-plan">кому и что предлагается</a>. Внизу — объяснения пробных проверок и скачивание файлов.</> : run.status === 'failed' ? 'Расчёт остановился. Ниже можно посмотреть уже проведённые проверки и начать новый подбор. Готового результата у этого запуска нет.' : 'Программа сравнивает тарифные предложения на искусственных данных. По готовности здесь появится план: кому предложить какой тариф, как связаться и какой эффект ожидается.'}</p></div></div>
    {query.error && <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Обновление данных приостановлено — показан последний ответ" />}
    {run.warnings.length > 0 && <details className="run-notices-panel"><summary>Замечания к данным и расчёту · {number(run.warnings.length)}</summary><div className="run-notices run-anchor" id="run-notices" aria-label="Предупреждения по запуску">{run.warnings.map((notice, index) => { const explanation = explainNotice(notice); return <div className={`run-notice run-notice-${notice.severity}`} key={`${notice.code}-${index}`}><CircleAlert size={18} aria-hidden="true" /><div><strong>{explanation.title}</strong><p>{explanation.text}{notice.affected_count != null && <span> Затронуто записей: {number(notice.affected_count)}.</span>}</p><TechnicalDetails>{explanation.raw}</TechnicalDetails></div></div> })}</div></details>}
    {run.status === 'failed' && <Card className="failure-card"><CircleAlert size={24} aria-hidden="true" /><div><h3>План не завершён</h3><p>{explainPhaseMessage('failed', run.failure?.message || '').text} Доступные проверки и история действий сохранены.</p>{run.failure && <TechnicalDetails summary="Технические сведения об ошибке">{`${run.failure.code}\n${run.failure.message}`}</TechnicalDetails>}<Link to="/runs/new" className="button button-secondary">Повторить расчёт как новый запуск <ArrowRight size={16} aria-hidden="true" /></Link><p className="run-retry-help">Откроются настройки нового подбора. Этот запуск останется в истории.</p></div></Card>}
    {active && <Card className="progress-card"><div className="progress-top"><span className="eyebrow">ТЕКУЩИЙ ЭТАП · {phaseLabel[run.phase]}</span><span className="live-dot" aria-hidden="true" /></div><h3 aria-live="polite" aria-atomic="true">{explainPhaseMessage(run.phase, run.phase_message).text}</h3><p>Расчёт продолжается при переходе между страницами. Вернуться к нему можно через раздел «Запуски».</p><div className="progress-stats"><div><strong>{number(run.resources.pilots_used)} <small>из максимум {number(run.resources.pilots_limit)}</small></strong><span>Проведено пробных проверок</span></div><div><strong>{money(run.resources.budget.used_by_pilots)}</strong><span>Расходы на проверки</span></div><div><strong>{number(run.resources.contacts.used_by_pilots)}</strong><span>Попытки связи в проверках</span></div></div><p className="run-inline-help"><Info size={16} aria-hidden="true" /> Количество проверок показывает использованный лимит. Программа может остановиться раньше, если дополнительных проверок уже не требуется.</p></Card>}
    {completed && <>
      <nav className="run-section-nav" aria-label="Разделы результата"><a href="#run-analysis"><Info size={16} aria-hidden="true" /> Разбор результата</a><a href="#campaign-plan"><ListChecks size={16} aria-hidden="true" /> План кампаний <span>{number(run.campaigns.length)}</span></a><a href="#run-research">Что проверили и почему</a><a href="#run-notes">Название и заметки</a><a href="#campaign-what-if">Проверить исключения</a><a href="#run-export"><Download size={16} aria-hidden="true" /> Скачать файлы</a></nav>
      <RunAnalysis run={run} onOpenCampaign={openCampaign} />
      {negative && <Card className="negative-card"><CircleAlert size={22} aria-hidden="true" /><div><h3>Прогноз всего запуска отрицательный</h3><p>Прогноз всего запуска, включая уже проведённые пилоты, отрицательный. Это не означает, что каждое предложение невыгодно: в итог входят и расходы на проверки. Посмотрите разбор выше и вклад отдельных предложений в таблице.</p></div></Card>}
      {!negative && uncertain && <div className="run-notice run-notice-warning"><Info size={18} aria-hidden="true" /><p><strong>Результат остаётся неопределённым.</strong> Расчётный диапазон включает ноль: уверенный рост не подтверждён. Изучите пробные проверки и обоснования перед сравнением вариантов.</p></div>}
      {!run.forecast && <div className="run-notice run-notice-warning"><Info size={18} aria-hidden="true" /><p><strong>Прогноз эффекта недоступен.</strong> Сохранённые кампании доступны ниже; оценить ожидаемую выгоду по этому отчёту пока нельзя.</p></div>}
      <div className="result-grid run-anchor" id="run-forecast">
        <Card className="forecast-card"><CardHeader eyebrow="ПРОГНОЗ ПРОГРАММЫ" title="Сколько может добавить этот план" /><div className={`result-main ${negative ? 'negative' : ''}`}>{money(run.forecast?.expected_net_gain)}</div><p>Ожидаемая дополнительная выручка после расходов на связь, включая пробные проверки. Это предварительная оценка; «у.е.» означает условные денежные единицы.</p>{run.forecast?.net_gain_interval ? <div className="interval"><span>Расчётный диапазон ({percentage(run.forecast.net_gain_interval.level)})</span><strong>{money(run.forecast.net_gain_interval.low)} — {money(run.forecast.net_gain_interval.high)}</strong><p>Диапазон отражает неопределённость оценки. Более широкий диапазон означает больший разброс возможного эффекта.</p><details className="run-help-details"><summary>Как рассчитан диапазон</summary><p>Это диапазон возможного эффекта с учётом неопределённости. Он не является обещанием дохода.</p><TechnicalDetails>{run.forecast.net_gain_interval.method}</TechnicalDetails></details></div> : <p className="fine-print">Диапазон неопределённости не рассчитан.</p>}</Card>
        <Card className="local-card"><CardHeader eyebrow="ЛОКАЛЬНАЯ ПРОВЕРКА" title="Что получилось в учебной среде" /><div className={`result-main compact ${run.local_evaluation && run.local_evaluation.net_arpu_gain < 0 ? 'negative' : ''}`}>{money(run.local_evaluation?.net_arpu_gain)}</div><p>Готовый план проверен на искусственных данных. Это результат учебного расчёта, который не гарантирует такой же доход в реальной работе.</p><div className="local-details"><span>Расходы на связь <b>{money(run.local_evaluation?.communication_cost)}</b></span><span>Контакты <b>{number(run.local_evaluation?.total_contacts)}</b></span><span>Разных абонентов <b>{number(run.local_evaluation?.unique_customers)}</b></span></div><details className="run-help-details"><summary>Почему результат отличается от прогноза?</summary><p>Программа составляет прогноз по небольшим проверкам, а затем готовый план отдельно проверяется в учебной среде. Поэтому цифры могут различаться. Одно сравнение не показывает точность программы на всех будущих данных.</p></details></Card>
      </div>
      <div className="run-anchor" id="run-resources"><Card className="budget-card"><CardHeader eyebrow="РАСПРЕДЕЛЕНИЕ РЕСУРСОВ" title="Сколько денег и контактов потребуется" aside={<span className="result-count">Лимит {money(budget.limit)}</span>} />
        <div className="budget-bar" role="img" aria-label={`Из бюджета ${money(budget.limit)}: пилоты ${money(spentPilots)}, финальный план ${money(spentFinal)}, остаток ${money(remaining)}`}><span className="budget-pilots" style={{ width: budgetWidth(spentPilots) }} /><span className="budget-final" style={{ width: budgetWidth(spentFinal) }} /><span className="budget-left" style={{ width: budgetWidth(remaining) }} /></div>
        <div className="budget-legend"><span><i className="key-pilots" aria-hidden="true" /> Пробные проверки <b>{money(spentPilots)}</b></span><span><i className="key-final" aria-hidden="true" /> Финальный план <b>{money(spentFinal)}</b></span><span><i className="key-left" aria-hidden="true" /> Остаток <b>{money(remaining)}</b></span></div>
        <div className="run-resource-grid"><div><span>Попытки связи в проверках</span><strong>{number(run.resources.contacts.used_by_pilots)}</strong></div><div><span>Попытки связи по плану</span><strong>{number(run.resources.contacts.planned_final)}</strong></div><div><span>Общий лимит контактов</span><strong>{number(run.resources.contacts.limit)}</strong></div><div><span>Ожидается разных абонентов</span><strong>{number(run.forecast?.expected_unique_reach)}</strong></div></div>
        <details className="run-help-details"><summary>Чем контакты отличаются от охвата?</summary><p>Контакты — все попытки связи. Если одному абоненту предложены две кампании, это два контакта и один уникальный человек. Пилоты тоже расходуют контакты и бюджет.</p>{run.forecast?.overlap_method && <TechnicalDetails summary="Метод учёта повторных контактов">{run.forecast.overlap_method}</TechnicalDetails>}</details>
      </Card></div>
      <div id="campaign-plan" className="run-anchor"><Card className="table-card"><CardHeader eyebrow="ФИНАЛЬНОЕ РЕШЕНИЕ" title="План кампаний" aside={<span className="result-count">Кампаний: {number(run.campaigns.length)}</span>} /><p className="table-explainer">Начните с аудитории и предложения. Нажмите стрелку в строке, чтобы узнать, почему выбрано предложение и какие проверки это подтверждают.</p><div className="table-controls"><label className="select-field"><span>Сортировка</span><select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="order">Порядок исполнения</option><option value="gain">Оценённый вклад</option><option value="contacts">Контакты</option></select></label><span className="plan-order-help">№ — порядок исполнения. Сортировка его не меняет.</span></div>
        {sorted.length ? <><div className="mobile-campaigns">{sorted.map(campaign => <article className="mobile-campaign" key={campaign.id}><div className="mobile-campaign-head"><span className="order-cell">#{campaign.execution_order}</span><strong>{audience(campaign.spec)}</strong><button type="button" className="icon-button" aria-haspopup="dialog" aria-label={`Подробности кампании ${campaign.execution_order}`} onClick={() => openCampaign(campaign.id)}><ChevronRight size={18} aria-hidden="true" /></button></div><p>{tariff(campaign.spec.target_tariff)} · {channel(campaign.spec.channel)} · {evidence[campaign.evidence]}</p><div className="mobile-campaign-facts"><span>Контакты <b>{number(campaign.audience_count)}</b></span><span>Стоимость <b>{money(campaign.communication_cost)}</b></span><span>Вклад <b className={campaign.expected_incremental_net_gain != null && campaign.expected_incremental_net_gain < 0 ? 'negative-text' : ''}>{money(campaign.expected_incremental_net_gain)}</b></span></div></article>)}</div>
          <div className="table-scroll plan-table-scroll" role="region" aria-label="Финальный план кампаний" tabIndex={0}><table><thead><tr><th scope="col">№</th><th scope="col">Кому предложить</th><th scope="col">Что и как предложить</th><th scope="col" className="number-cell">Контакты</th><th scope="col" className="number-cell">Стоимость</th><th scope="col" className="number-cell">Вклад в результат</th><th scope="col">Основание выбора</th><th scope="col" aria-label="Подробности" /></tr></thead><tbody>{sorted.map(campaign => <tr key={campaign.id}><td className="order-cell">{campaign.execution_order}</td><td><strong>{audience(campaign.spec)}</strong><small className="table-subline">{evidence[campaign.evidence]}</small></td><td>{tariff(campaign.spec.target_tariff)}<small className="table-subline">{channel(campaign.spec.channel)}</small></td><td className="number-cell">{number(campaign.audience_count)}</td><td className="number-cell">{money(campaign.communication_cost)}</td><td className={`number-cell ${campaign.expected_incremental_net_gain != null && campaign.expected_incremental_net_gain < 0 ? 'negative-text' : ''}`}>{money(campaign.expected_incremental_net_gain)}</td><td className="reason-cell">{campaign.evidence === 'pilot_supported' ? 'Учтены результаты пробных проверок.' : campaign.evidence === 'prior_only' ? 'Предварительная оценка по исходным данным.' : 'Резервный вариант для допустимого плана.'}</td><td><button type="button" className="icon-button" aria-haspopup="dialog" aria-label={`Подробности кампании ${campaign.execution_order}`} onClick={() => openCampaign(campaign.id)}><ChevronRight size={19} aria-hidden="true" /></button></td></tr>)}</tbody></table></div>
          <details className="run-help-details plan-help"><summary>Как читать вклад и обоснование кампании</summary><p><strong>Вклад в результат</strong> — ожидаемая дополнительная выручка за вычетом расходов при добавлении кампании после предыдущих кампаний и пилотов. Это часть общего прогноза; прибавлять её к нему повторно не нужно.</p><dl className="evidence-glossary"><div><dt>Что значит «Есть пробные проверки»</dt><dd>{evidenceHelp.pilot_supported}</dd></div><div><dt>Что значит «Предварительная оценка»</dt><dd>{evidenceHelp.prior_only}</dd></div><div><dt>Что значит «Резервный вариант»</dt><dd>{evidenceHelp.fallback}</dd></div></dl></details></> : <EmptyState title="Кампаний пока нет" text="Сохранённый план не содержит кампаний." />}
      </Card></div>
    </>}
    <div id="run-notes" className="run-anchor"><RunNotebook key={`notes-${run.id}`} runId={run.id} /></div>
    {completed && <CampaignWhatIf key={`experiment-${run.id}`} run={run} />}
    <ResearchActivity key={run.id} run={run} />
    <div id="run-export" className="run-anchor"><Card className="export-card"><div><p className="eyebrow">СОХРАНЁННЫЙ РЕЗУЛЬТАТ</p><h2>Файлы этого запуска</h2><p><strong>План CSV</strong> — таблица: кому предложить тариф и как связаться. <strong>Отчёт JSON</strong> — данные для подробной проверки результата.</p><p>Скачивание использует сохранённый результат и не запускает расчёт повторно. Файл плана можно открыть как таблицу. Подробный отчёт сохраняет весь ход расчёта.</p>{!completed && <small id="export-unavailable">{run.status === 'failed' ? 'Экспорт недоступен: запуск не завершился сохранением готового плана.' : 'Экспорт станет доступен после завершения и сохранения плана.'}</small>}</div><div className="export-actions"><button type="button" className="button button-primary" disabled={!completed || exporting !== null} aria-describedby={!completed ? 'export-unavailable' : undefined} onClick={() => void download('csv')}><Download size={17} aria-hidden="true" /> {exporting === 'csv' ? 'Загрузка CSV…' : 'Скачать план CSV'}</button><button type="button" className="button button-secondary" disabled={!completed || exporting !== null} aria-describedby={!completed ? 'export-unavailable' : undefined} onClick={() => void download('json')}><FileJson2 size={17} aria-hidden="true" /> {exporting === 'json' ? 'Загрузка JSON…' : 'Скачать отчёт JSON'}</button></div></Card><p className="export-feedback" role="status">{exportMessage}</p></div>
    {exportError != null && <ErrorPanel error={exportError.error} onRetry={() => void download(exportError.kind)} title={`Не удалось скачать ${exportError.kind.toUpperCase()}`} />}
    {query.error && <button type="button" className="button button-secondary reconnect" onClick={() => void query.refetch()}><RefreshCw size={16} aria-hidden="true" /> Восстановить соединение</button>}
    <CampaignDrawer campaign={chosen} run={run} onClose={closeDrawer} />
  </div>
}
