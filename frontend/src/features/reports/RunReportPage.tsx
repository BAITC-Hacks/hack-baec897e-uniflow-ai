import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api/client'
import { channel, filterLabel, money, number, percentage, risk, segment, tariff, when } from '../../lib/format'
import { explainNotice } from '../../lib/explanations'
import { analyzeRun } from '../../lib/runAnalysis'
import { getRunNote } from '../../lib/runNotes'
import { Card, ErrorPanel, Skeleton } from '../../components/ui/common'
import type { RunSnapshot } from '../../lib/api/types'
import './run-report.css'

const evidence = { pilot_supported: 'Есть пробные проверки', prior_only: 'Предварительная оценка', fallback: 'Резервный вариант' }

export function RunReport({ run, name = '', note = '' }: { run: RunSnapshot; name?: string; note?: string }) {
  const analysis = analyzeRun(run)
  const campaigns = [...run.campaigns].sort((a, b) => a.execution_order - b.execution_order)
  const maxContribution = Math.max(1, ...campaigns.map(item => Math.abs(item.expected_incremental_net_gain ?? 0)))
  return <article className="report-paper" aria-label="Отчёт по тарифным предложениям">
    <header className="report-heading"><div><span className="report-brand">OrbitDuo</span><p>ПОДБОР ТАРИФНЫХ ПРЕДЛОЖЕНИЙ</p></div><span className="report-environment">{run.mode === 'demo' ? 'Демонстрационный пример' : 'Учебная симуляция'}</span></header>
    <h1>{name || 'План тарифных предложений'}</h1>
    <p className="report-subtitle">{when(run.created_at)} · {risk(run.config.risk_profile)} подход · Сценарий № {number(run.config.seed)}</p>
    <div className="report-conclusion"><span>ГЛАВНЫЙ ВЫВОД</span><h2>{analysis.headline}</h2><p>{analysis.summary}</p></div>
    <div className="report-metrics"><div><span>Прогноз программы</span><strong>{money(run.forecast?.expected_net_gain)}</strong><small>Включает проверки и итоговые предложения</small></div><div><span>Проверка в учебной среде</span><strong>{money(run.local_evaluation?.net_arpu_gain)}</strong><small>Отдельный результат на синтетической модели</small></div><div><span>Разных абонентов в проверке</span><strong>{number(run.local_evaluation?.unique_customers)}</strong><small>Повторные контакты не увеличивают охват</small></div></div>
    <p className="report-caption">Обе денежные оценки показывают дополнительную выручку за вычетом расходов на связь. Они не отражают полную прибыль бизнеса и не гарантируют доход в реальной работе. Все суммы — в условных единицах (у.е.).</p>
    <section className="report-section"><h2>Ресурсы и неопределённость</h2><dl className="report-facts"><div><dt>Бюджет на связь</dt><dd>{money(run.resources.budget.limit)}</dd></div><div><dt>Расходы на пробные проверки</dt><dd>{money(run.resources.budget.used_by_pilots)}</dd></div><div><dt>Расходы на итоговый план</dt><dd>{money(run.resources.budget.planned_final)}</dd></div><div><dt>Остаток после плана</dt><dd>{money(run.resources.budget.remaining_after_plan)}</dd></div><div><dt>Лимит контактов</dt><dd>{number(run.resources.contacts.limit)}</dd></div><div><dt>Контакты: проверки / итоговый план</dt><dd>{number(run.resources.contacts.used_by_pilots)} / {number(run.resources.contacts.planned_final)}</dd></div><div><dt>Пробных проверок / предложений</dt><dd>{number(run.pilots.length)} / {number(campaigns.length)}</dd></div><div><dt>Диапазон прогноза</dt><dd>{run.forecast?.net_gain_interval ? `${money(run.forecast.net_gain_interval.low)} — ${money(run.forecast.net_gain_interval.high)} (${percentage(run.forecast.net_gain_interval.level)})` : 'Не рассчитан'}</dd></div></dl></section>
    <section className="report-section"><h2>Кому и что предлагается</h2><p>Порядок строк — порядок исполнения. Оценки вкладов учитывают предыдущие предложения и пилоты; их нельзя повторно прибавлять к общему прогнозу.</p><div className="report-table-wrap"><table className="report-table"><thead><tr><th>№</th><th>Аудитория и предложение</th><th>Контакты / расходы</th><th>Вклад / подтверждение</th></tr></thead><tbody>{campaigns.map(item => <tr key={item.id}><td>{item.execution_order}</td><td><strong>{item.spec.filter_arpu_segment?.split(';').map(value => segment(value.trim())).join(', ') || 'Все уровни выручки'}</strong><span>{item.spec.filter_current_tariff?.split(';').map(value => tariff(value.trim())).join(', ') || 'Все текущие тарифы'} → {tariff(item.spec.target_tariff)}</span><span>{channel(item.spec.channel)}</span>{item.spec.filter_data_segment && <span>Интернет: {filterLabel(item.spec.filter_data_segment, 'data')}</span>}{item.spec.filter_call_segment && <span>Звонки: {filterLabel(item.spec.filter_call_segment, 'calls')}</span>}</td><td><strong>{number(item.audience_count)}</strong><span>{money(item.communication_cost)}</span></td><td><strong>{money(item.expected_incremental_net_gain)}</strong><span>{evidence[item.evidence]}</span></td></tr>)}</tbody></table></div>{campaigns.length === 0 && <p>В этом отчёте нет сохранённых итоговых предложений.</p>}</section>
    {campaigns.length > 0 && <section className="report-section report-chart"><h2>Ожидаемый вклад предложений</h2><p>Длина полосы показывает величину вклада. Знак и сумма указаны рядом; отрицательные значения выделены отдельно.</p>{campaigns.map(item => <div className={`report-chart-row ${(item.expected_incremental_net_gain ?? 0) < 0 ? 'negative' : ''}`} key={item.id}><span>№ {item.execution_order}</span><div className="report-bar-track" aria-hidden="true"><i style={{ width: `${Math.abs(item.expected_incremental_net_gain ?? 0) / maxContribution * 100}%` }} /></div><strong>{money(item.expected_incremental_net_gain)}</strong></div>)}</section>}
    <section className="report-section"><h2>Что проверить перед следующим решением</h2><ol className="report-recommendations">{analysis.recommendations.slice(0, 3).map(item => <li key={item.id}><h3>{item.title}</h3><p>{item.evidence}</p><p>{item.nextStep}</p></li>)}</ol></section>
    {run.warnings.length > 0 && <section className="report-section"><h2>Замечания к данным и расчёту</h2><ul className="report-warnings">{run.warnings.map((item, index) => { const explanation = explainNotice(item); return <li key={`${item.code}-${index}`}><strong>{explanation.title}.</strong> {explanation.text}{item.affected_count != null && <> Затронуто записей: {number(item.affected_count)}.</>}</li> })}</ul></section>}
    {note && <section className="report-section report-user-note"><h2>Заметка автора</h2><p>{note}</p></section>}
    <footer className="report-footer"><p>Сохранённый запуск: {run.id}</p><p>Набор данных: {run.dataset_id} · Создан: {when(run.created_at)} · Завершён: {when(run.completed_at)}</p><p>Отчёт воспроизводит исходный сохранённый план. Эксперименты с исключением кампаний и сценарии калькулятора в него не включены.</p></footer>
  </article>
}

export function RunReportPage() {
  const { id = '' } = useParams()
  const notebook = getRunNote(id)
  const query = useQuery({ queryKey: ['run', id], queryFn: ({ signal }) => api.run(id, signal), enabled: !!id })
  useEffect(() => { document.title = `Отчёт OrbitDuo · ${id.slice(0, 8)}` }, [id])
  return <main className="report-page"><div className="report-toolbar"><Link to={`/runs/${encodeURIComponent(id)}`} className="text-link"><ArrowLeft size={16} aria-hidden="true" /> К результату</Link><div><strong>Отчёт для презентации</strong><p>Нажмите «Печать / PDF» и выберите «Сохранить как PDF» в окне печати браузера.</p></div><button type="button" className="button button-primary" disabled={query.data?.status !== 'completed' || query.isError} onClick={() => window.print()}><Printer size={17} aria-hidden="true" /> Печать / PDF</button></div>
    {query.isPending ? <Card><Skeleton rows={8} /></Card> : query.error || !query.data ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Не удалось открыть отчёт" /> : query.data.status !== 'completed' ? <Card><h1>Отчёт пока недоступен</h1><p>Дождитесь завершения расчёта. Отчёт формируется из сохранённого готового плана.</p></Card> : <RunReport run={query.data} name={notebook.name} note={notebook.note} />}
  </main>
}
