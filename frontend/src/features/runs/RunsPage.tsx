import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowLeft, ArrowRight, Clock3, FileCheck2, GitCompareArrows, Info, Plus, RefreshCw, Search, Star, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api/client'
import type { RunSummary } from '../../lib/api/types'
import { money, number, risk, status, when } from '../../lib/format'
import { getRunNote, saveRunNote, useRunNotes } from '../../lib/runNotes'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'
import '../audience/exploration.css'
import './run-organization.css'

const isActive = (run: RunSummary) => run.status === 'queued' || run.status === 'running'
const runTone = (run: RunSummary) => run.status === 'failed' ? 'negative' as const : run.status === 'completed' && run.forecast_net_gain != null && run.forecast_net_gain <= 0 ? 'warning' as const : 'neutral' as const

export function RunsPage() {
  const [params, setParams] = useSearchParams()
  const { notes, error: notesError } = useRunNotes()
  const [selected, setSelected] = useState<string[]>(() => { const id = params.get('compare'); return id && /^[a-zA-Z0-9_-]{1,120}$/.test(id) ? [id] : [] })
  const [favoriteError, setFavoriteError] = useState<string | null>(null)
  const favoritesOnly = params.get('favorites') === '1'
  const search = params.get('q') || ''
  const statusFilter = ['active', 'completed', 'failed'].includes(params.get('status') || '') ? params.get('status')! : 'all'
  const riskFilter = ['balanced', 'conservative'].includes(params.get('risk') || '') ? params.get('risk')! : 'all'
  const sort = params.get('order') === 'oldest' ? 'oldest' : 'newest'
  const query = useQuery({ queryKey: ['runs', 100], queryFn: ({ signal }) => api.runs(100, signal), refetchInterval: q => q.state.data?.items.some(isActive) ? 2000 : false })
  const updateFilters = (values: Record<string, string>) => setParams(previous => {
    const next = new URLSearchParams(previous)
    next.delete('page')
    Object.entries(values).forEach(([key, value]) => { if (value) next.set(key, value); else next.delete(key) })
    return next
  }, { replace: true })
  const resetFilters = () => updateFilters({ q: '', status: '', risk: '', order: '', favorites: '' })

  if (query.isPending && !query.isError) return <div className="page-stack"><Card><Skeleton rows={3} /></Card><Card><Skeleton rows={6} /></Card></div>
  if (query.error && !query.data) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="История недоступна" />

  const runs = query.data?.items || []
  const activeRun = runs.find(isActive)
  const completedCount = runs.filter(run => run.status === 'completed').length
  const normalizedSearch = search.trim().toLocaleLowerCase('ru')
  const rows = runs.filter(run =>
    (statusFilter === 'all' || (statusFilter === 'active' ? isActive(run) : run.status === statusFilter))
    && (riskFilter === 'all' || run.config.risk_profile === riskFilter)
    && (!favoritesOnly || notes[run.id]?.favorite)
    && `${run.id} ${when(run.created_at)} ${run.config.seed} ${notes[run.id]?.name || ''} ${notes[run.id]?.note || ''}`.toLocaleLowerCase('ru').includes(normalizedSearch),
  ).sort((a, b) => (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * (sort === 'newest' ? -1 : 1))
  const pageSize = 15
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const requestedPage = Number(params.get('page') || '1')
  const currentPage = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pageCount) : 1
  const pageStart = (currentPage - 1) * pageSize
  const pageRows = rows.slice(pageStart, pageStart + pageSize)
  const hasChanges = Boolean(search || statusFilter !== 'all' || riskFilter !== 'all' || sort !== 'newest' || favoritesOnly)

  return <div className="page-stack exploration-page">
    <div className="section-intro with-action"><div><p className="eyebrow">СОХРАНЁННЫЕ РАСЧЁТЫ</p><h2>История запусков</h2><p>Один запуск — один расчёт тарифных предложений. Здесь можно вернуться к плану, прочитать его разбор и сравнить результаты разных подходов.</p></div><Link to={activeRun ? `/runs/${encodeURIComponent(activeRun.id)}` : '/runs/new'} className="button button-primary">{activeRun ? <Clock3 size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}{activeRun ? 'К текущему расчёту' : 'Новый подбор'}</Link></div>
    {query.error && <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Связь с историей прервалась — показаны последние данные" />}
    {(notesError || favoriteError) && <p className="run-note-error" role="alert">{notesError || favoriteError}</p>}
    {activeRun && <div className="exploration-active-run"><Clock3 size={21} aria-hidden="true" /><div><strong>{query.error ? 'Последний известный статус: расчёт выполняется' : 'Подбор кампаний продолжается'}</strong><p>Программа ещё проверяет предложения. Откройте расчёт, чтобы посмотреть текущий этап, результаты проверок и расходы.</p></div><Link to={`/runs/${encodeURIComponent(activeRun.id)}`} className="text-link">Открыть расчёт <ArrowRight size={16} aria-hidden="true" /></Link></div>}

    <div className="exploration-metric-guide" aria-label="Как различать оценки результата">
      <div><span className="exploration-source-number">01</span><div><strong>Прогноз эффекта</strong><p>Сколько дополнительной выручки ожидается после вычета расходов на связь, включая пробные проверки. Минус означает, что ожидаемая выручка не покрывает эти расходы.</p></div></div>
      <div><span className="exploration-source-number">02</span><div><strong>Проверка в симуляции</strong><p>Результат отдельной компьютерной проверки плана на учебных данных. Сравните его с прогнозом; большой разрыв стоит изучить в разборе. Это не реальный доход.</p></div></div>
    </div>

    <Card className="table-card exploration-table"><CardHeader eyebrow="ПОСЛЕДНИЕ 100 ЗАПУСКОВ" title="Расчёты" aside={<button type="button" className="button button-subtle exploration-refresh" disabled={query.isFetching} onClick={() => void query.refetch()} aria-label="Обновить историю"><RefreshCw size={15} aria-hidden="true" />{query.isFetching ? 'Обновляем…' : 'Обновить'}</button>} />
      {runs.length === 0 ? <EmptyState title="Здесь появится ваш первый план" text="Нажмите «Подобрать кампании» и оставьте настройки для первого расчёта. Программа проверит тарифные предложения и сохранит план с объяснениями. Сообщения абонентам не отправляются." action={<Link to="/runs/new" className="button button-primary">Подобрать кампании <ArrowRight size={17} aria-hidden="true" /></Link>} /> : <>
        <div className="exploration-controls">
          <label className="exploration-field exploration-search"><span>Найти запуск</span><span className="exploration-input-wrap"><Search size={17} aria-hidden="true" /><input type="search" value={search} onChange={event => updateFilters({ q: event.target.value })} placeholder="Название, заметка, дата или код" /></span></label>
          <label className="exploration-field"><span id="runs-status-label">Статус</span><select aria-labelledby="runs-status-label" value={statusFilter} onChange={event => updateFilters({ status: event.target.value === 'all' ? '' : event.target.value })}><option value="all">Все статусы</option><option value="active">В процессе</option><option value="completed">План готов</option><option value="failed">С ошибкой</option></select></label>
          <label className="exploration-field"><span id="runs-risk-label">Подход к риску</span><select aria-labelledby="runs-risk-label" value={riskFilter} onChange={event => updateFilters({ risk: event.target.value === 'all' ? '' : event.target.value })}><option value="all">Оба подхода</option><option value="balanced">Сбалансированный</option><option value="conservative">Осторожный</option></select></label>
          <label className="exploration-field"><span id="runs-order-label">Порядок</span><select aria-labelledby="runs-order-label" value={sort} onChange={event => updateFilters({ order: event.target.value === 'newest' ? '' : event.target.value })}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option></select></label>
          {hasChanges && <button type="button" className="button button-subtle exploration-reset" onClick={resetFilters}><X size={15} aria-hidden="true" /> Сбросить</button>}
        </div>
        <div className="run-history-tools"><button type="button" className={`button ${favoritesOnly ? 'button-primary' : 'button-subtle'}`} aria-pressed={favoritesOnly} onClick={() => updateFilters({ favorites: favoritesOnly ? '' : '1' })}><Star size={17} aria-hidden="true" />Только избранное</button><span>Названия, заметки и избранное хранятся в этом браузере.</span></div>
        <div className="run-compare-toolbar"><div><GitCompareArrows size={22} aria-hidden="true" /><div><strong>Отметьте 2–3 расчёта для сравнения</strong><p role="status">Выбрано: {selected.length} из 3. Выбор сохраняется при смене фильтров и страниц.</p></div></div><div>{selected.length >= 2 ? <Link className="button button-primary" to={`/runs/compare?ids=${selected.map(encodeURIComponent).join(',')}`}>Сравнить ({selected.length}) <ArrowRight size={17} aria-hidden="true" /></Link> : <button className="button button-primary" disabled>Сравнить ({selected.length})</button>}{selected.length > 0 && <button type="button" className="button button-subtle" onClick={() => setSelected([])}>Снять выбор</button>}</div></div>
        <div className="exploration-results"><span role="status">Найдено <strong>{number(rows.length)}</strong> из {number(runs.length)} запусков</span><span><FileCheck2 size={14} aria-hidden="true" />Готовых планов в истории: {number(completedCount)}</span></div>
        {rows.length === 0 ? <EmptyState title="Запуски не найдены" text="Попробуйте другую дату, код расчёта или номер сценария. Нажмите «Сбросить фильтры», чтобы снова увидеть все сохранённые расчёты." action={<button type="button" className="button button-secondary" onClick={resetFilters}>Сбросить фильтры</button>} /> : <>
          <p className="table-hint">Прокрутите таблицу вправо, чтобы увидеть оценки и открыть запуск →</p>
          <div className="table-scroll" role="region" aria-label="История запусков" tabIndex={0}><table className="exploration-runs-table"><caption className="sr-only">Сохранённые расчёты: дата, подход к риску, статус, прогноз эффекта и проверка в симуляции</caption><thead><tr><th scope="col">Сравнить</th><th scope="col" aria-sort={sort === 'newest' ? 'descending' : 'ascending'}>Дата и время</th><th scope="col">Подход к риску</th><th scope="col">Статус</th><th scope="col" className="number-cell exploration-forecast-col">Прогноз эффекта</th><th scope="col" className="number-cell">Проверка в симуляции</th><th scope="col"><span className="sr-only">Открыть запуск</span></th></tr></thead><tbody>{pageRows.map(run => <tr key={run.id}>
            <td><input className="run-compare-checkbox" type="checkbox" aria-label={`Сравнить расчёт ${notes[run.id]?.name || run.id}`} checked={selected.includes(run.id)} disabled={!selected.includes(run.id) && selected.length >= 3} onChange={() => setSelected(previous => previous.includes(run.id) ? previous.filter(id => id !== run.id) : previous.length < 3 ? [...previous, run.id] : previous)} /></td>
            <td><div className="run-history-name">{notes[run.id]?.name && <strong>{notes[run.id].name}</strong>}<button type="button" className="run-star-button" aria-label={`${notes[run.id]?.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}: ${notes[run.id]?.name || run.id}`} aria-pressed={Boolean(notes[run.id]?.favorite)} disabled={Boolean(notesError)} onClick={() => { const previous = getRunNote(run.id); const result = saveRunNote(run.id, { ...previous, favorite: !previous.favorite }); setFavoriteError(result.ok ? null : result.error!) }}><Star size={17} aria-hidden="true" fill={notes[run.id]?.favorite ? 'currentColor' : 'none'} /></button></div><strong><time dateTime={run.created_at}>{when(run.created_at)}</time></strong>{notes[run.id]?.note && <small className="table-subline run-history-note">{notes[run.id].note}</small>}<small className="table-subline exploration-run-id">Код расчёта: {run.id}</small></td>
            <td>{risk(run.config.risk_profile)}<small className="table-subline">Сценарий № {number(run.config.seed)}</small></td>
            <td><StatusPill tone={runTone(run)}>{status(run.status)}</StatusPill>{run.status === 'failed' && <small className="table-subline">Откройте причину ошибки</small>}{run.status === 'completed' && run.forecast_net_gain != null && run.forecast_net_gain <= 0 && <small className="exploration-negative-note">{run.forecast_net_gain < 0 ? 'Прогноз ниже нуля' : 'Нет ожидаемого прироста'}</small>}</td>
            <td className={`number-cell exploration-forecast-col ${run.forecast_net_gain != null && run.forecast_net_gain < 0 ? 'exploration-negative-value' : ''}`}>{money(run.forecast_net_gain)}{run.forecast_net_gain === null && <small className="table-subline">{isActive(run) ? 'Расчёт ещё идёт' : 'Оценка не сохранена'}</small>}</td>
            <td className={`number-cell ${run.local_net_gain != null && run.local_net_gain < 0 ? 'exploration-negative-value' : ''}`}>{money(run.local_net_gain)}{run.local_net_gain === null && <small className="table-subline">{isActive(run) ? 'После завершения плана' : 'Проверка не завершена'}</small>}</td>
            <td><Link to={`/runs/${encodeURIComponent(run.id)}`} className="exploration-open-run" aria-label={`Открыть запуск от ${when(run.created_at)}, ${run.id}`}>{run.status === 'completed' ? 'Открыть план' : run.status === 'failed' ? 'Подробнее' : 'Смотреть ход'}<ArrowRight size={16} aria-hidden="true" /></Link></td>
          </tr>)}</tbody></table></div>
          <nav className="exploration-pagination" aria-label="Страницы истории"><span role="status">Запуски {number(pageStart + 1)}–{number(Math.min(pageStart + pageSize, rows.length))} из {number(rows.length)}</span><div><button type="button" className="button button-subtle" aria-label="Предыдущая страница запусков" disabled={currentPage === 1} onClick={() => updateFilters({ page: currentPage === 2 ? '' : String(currentPage - 1) })}><ArrowLeft size={15} aria-hidden="true" />Назад</button><span>{currentPage} / {pageCount}</span><button type="button" className="button button-subtle" aria-label="Следующая страница запусков" disabled={currentPage === pageCount} onClick={() => updateFilters({ page: String(currentPage + 1) })}>Далее<ArrowRight size={15} aria-hidden="true" /></button></div></nav>
        </>}
        <div className="exploration-table-footer"><Info size={16} aria-hidden="true" /><span>Откройте готовый план, чтобы прочитать разбор и скачать таблицу или отчёт. «План готов» означает, что расчёт завершён. Чтобы оценить пользу предложений, сравните прогноз, проверку и предупреждения.</span></div>
      </>}
    </Card>
    <details className="exploration-help"><summary><Info size={18} aria-hidden="true" /> Как использовать историю и повторять расчёты</summary><div className="exploration-help-grid">
      <div><h3>Откройте сохранённый результат</h3><p>Нажмите «Открыть план». В нём сохранены выбранные предложения, разбор, журнал проверок и файлы для скачивания. Просмотр не запускает новый расчёт.</p></div>
      <div><h3>Сравните подходы к риску</h3><p>Сбалансированный подход учитывает выгоду и точность прогноза. Осторожный меньше доверяет неточным оценкам. Для сравнения нажмите «Новый подбор» и выберите другой подход. Бюджет остаётся фиксированным; оба результата сохранятся.</p></div>
      <div><h3>Что такое номер сценария?</h3><p>Это число, задающее условия учебной симуляции; в настройках оно называется seed. Для сравнения подходов используйте одинаковые исходные данные, номер сценария и версию программы. Код расчёта под датой обозначает конкретную сохранённую запись.</p></div>
    </div></details>
  </div>
}
