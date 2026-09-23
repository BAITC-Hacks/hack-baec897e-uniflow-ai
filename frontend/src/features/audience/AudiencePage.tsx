import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, Info, Search, ShieldCheck, Users, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api/client'
import { money, number, percentage, segment, tariff } from '../../lib/format'
import { explainExclusionReason, explainNotice } from '../../lib/explanations'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'
import './exploration.css'

type SortKey = 'customer_count' | 'average_predicted_arpu' | 'current_tariff'
const sortKeys: SortKey[] = ['customer_count', 'average_predicted_arpu', 'current_tariff']
const knownSegments = ['HIGH', 'MID', 'LOW']
const segmentLabel = (code: string | null) => code === null || knownSegments.includes(code) ? segment(code) : `Сегмент ${code}`

export function AudiencePage() {
  const query = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api.overview(signal) })
  const [params, setParams] = useSearchParams()
  const search = params.get('q') || ''
  const segmentFilter = params.get('segment') || 'all'
  const eligibility = ['eligible', 'excluded'].includes(params.get('eligibility') || '') ? params.get('eligibility')! : 'all'
  const sort = sortKeys.includes(params.get('sort') as SortKey) ? params.get('sort') as SortKey : 'customer_count'
  const descending = params.get('order') !== 'asc'
  const updateFilters = (values: Record<string, string>) => setParams(previous => {
    const next = new URLSearchParams(previous)
    next.delete('page')
    Object.entries(values).forEach(([key, value]) => { if (value) next.set(key, value); else next.delete(key) })
    return next
  }, { replace: true })
  const resetFilters = () => updateFilters({ q: '', segment: '', eligibility: '', sort: '', order: '' })

  if (query.isPending && !query.isError) return <div className="page-stack"><Card><Skeleton rows={5} /></Card><Card><Skeleton rows={8} /></Card></div>
  if (!query.data) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Аудитория недоступна" />

  const { dataset, segments } = query.data
  const extraSegments = [...new Set(segments.map(row => row.arpu_segment).filter((code): code is string => code !== null && !knownSegments.includes(code)))]
  const distribution = [...knownSegments, ...extraSegments, null].map(code => ({
    code, count: segments.filter(row => row.arpu_segment === code).reduce((sum, row) => sum + row.customer_count, 0),
  }))
  const totalInGroups = distribution.reduce((sum, item) => sum + item.count, 0)
  const maximum = Math.max(1, ...distribution.map(item => item.count))
  const normalizedSearch = search.trim().toLocaleLowerCase('ru')
  const rows = segments.filter(row =>
    (segmentFilter === 'all' || (row.arpu_segment ?? 'missing') === segmentFilter)
    && (eligibility === 'all' || row.eligible === (eligibility === 'eligible'))
    && `${row.current_tariff ?? 'Не указан'} ${tariff(row.current_tariff)}`.toLocaleLowerCase('ru').includes(normalizedSearch),
  ).sort((a, b) => {
    const compare = sort === 'current_tariff'
      ? (a.current_tariff ?? 'Не указан').localeCompare(b.current_tariff ?? 'Не указан', 'ru', { numeric: true })
      : a[sort] - b[sort]
    return descending ? -compare : compare
  })
  const visibleCustomers = rows.reduce((sum, row) => sum + row.customer_count, 0)
  const pageSize = 15
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const requestedPage = Number(params.get('page') || '1')
  const currentPage = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pageCount) : 1
  const pageStart = (currentPage - 1) * pageSize
  const pageRows = rows.slice(pageStart, pageStart + pageSize)
  const hasChanges = Boolean(search || segmentFilter !== 'all' || eligibility !== 'all' || sort !== 'customer_count' || !descending)
  const toggleSort = (key: SortKey) => updateFilters({ sort: key, order: sort === key ? descending ? 'asc' : 'desc' : key === 'current_tariff' ? 'asc' : 'desc' })
  const sortState = (key: SortKey) => sort === key ? descending ? 'descending' as const : 'ascending' as const : 'none' as const
  const sortIcon = (key: SortKey) => sort !== key ? <ArrowUpDown size={13} aria-hidden="true" /> : descending ? <ArrowDown size={13} aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />

  return <div className="page-stack exploration-page">
    <div className="section-intro with-action">
      <div><p className="eyebrow">01 / ИЗУЧИТЬ АУДИТОРИЮ</p><h2>Кого можно включить в план</h2><p>Аудитория — абоненты, для которых программа подбирает новые тарифы. Здесь можно посмотреть их текущие тарифы, выручку и записи, которым не хватает данных.</p></div>
      <Link to="/runs/new" className="button button-secondary">К подбору кампаний <ArrowRight size={17} aria-hidden="true" /></Link>
    </div>
    {query.error && <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Не удалось обновить аудиторию — показаны последние данные" />}

    <div className="audience-top exploration-audience-top">
      <Card><CardHeader eyebrow="СОСТАВ АУДИТОРИИ" title="Уровни выручки" aside={<span className="exploration-total"><Users size={16} aria-hidden="true" />{number(totalInGroups)} клиентов</span>} />
        <p className="exploration-caption">Нажмите на уровень, чтобы показать его группы в таблице. Повторное нажатие снимает этот фильтр.</p>
        <div className="exploration-distribution" aria-label="Фильтр по составу аудитории">
          {distribution.map(({ code, count }) => <button key={code ?? 'missing'} type="button" className="exploration-distribution-row" aria-pressed={segmentFilter === (code ?? 'missing')} onClick={() => updateFilters({ segment: segmentFilter === (code ?? 'missing') ? '' : code ?? 'missing' })}>
            <span className="exploration-distribution-label">{segmentLabel(code)}{code === null && <small>Нет исходного значения</small>}</span>
            <span className="bar-track" aria-hidden="true"><span className={`bar-fill bar-${code ?? 'missing'}`} style={{ width: `${count / maximum * 100}%` }} /></span>
            <span className="exploration-distribution-value"><strong>{number(count)}</strong><small>{totalInGroups ? percentage(count / totalInGroups) : '—'}</small></span>
          </button>)}
        </div>
        <p className="exploration-caption">Доли рассчитаны от всех клиентов в группах, включая записи с пропусками. Поиск и фильтры меняют только таблицу.</p>
      </Card>
      <Card className="exploration-quality"><CardHeader eyebrow="КАЧЕСТВО ДАННЫХ" title="Готовность к подбору" aside={<ShieldCheck size={21} aria-hidden="true" />} />
        <div className="exploration-quality-number">{number(dataset.eligible_customer_count)}<span>из {number(dataset.customer_count)} профилей допущены</span></div>
        <div className="exploration-quality-track" role="img" aria-label={`Допущено ${number(dataset.eligible_customer_count)} из ${number(dataset.customer_count)} профилей`}><span style={{ width: `${dataset.customer_count ? Math.min(100, dataset.eligible_customer_count / dataset.customer_count * 100) : 0}%` }} /></div>
        <StatusPill tone={dataset.excluded_customer_count > 0 ? 'warning' : 'positive'}>{dataset.excluded_customer_count > 0 ? `${number(dataset.excluded_customer_count)} профилей исключены` : 'Нет исключённых профилей'}</StatusPill>
        {dataset.excluded_customer_count > 0 && <><p className="exploration-caption">{explainExclusionReason(dataset.exclusion_reason).text}</p><button className="text-link" type="button" onClick={() => updateFilters({ q: '', segment: '', eligibility: 'excluded' })}>Показать исключённые группы <ArrowRight size={15} aria-hidden="true" /></button></>}
        {dataset.notices.length > 0 && <details className="exploration-notices"><summary>Замечания к данным · {dataset.notices.length}</summary><ul>{dataset.notices.map((notice, index) => <li key={`${notice.code}-${index}`}><span>{explainNotice(notice).text}</span>{notice.affected_count !== null && <small>Затронуто профилей: {number(notice.affected_count)}</small>}</li>)}</ul></details>}
      </Card>
    </div>

    <Card className="table-card exploration-table"><CardHeader eyebrow="ТАРИФ × УРОВЕНЬ ВЫРУЧКИ" title="Группы аудитории" aside={<span className="result-count" role="status">{number(rows.length)} из {number(segments.length)} групп</span>} />
      <p className="exploration-table-description">Одна строка — абоненты с одинаковым текущим тарифом и уровнем выручки. Например, «Тариф 11» — понятное имя кода tariff_11 из исходных данных.</p>
      <div className="exploration-controls">
        <label className="exploration-field exploration-search"><span>Поиск по тарифу</span><span className="exploration-input-wrap"><Search size={17} aria-hidden="true" /><input type="search" value={search} onChange={event => updateFilters({ q: event.target.value })} placeholder="Например, Тариф 11 или 11" /></span></label>
        <label className="exploration-field"><span id="audience-segment-label">Уровень выручки</span><select aria-labelledby="audience-segment-label" value={segmentFilter} onChange={event => updateFilters({ segment: event.target.value === 'all' ? '' : event.target.value })}><option value="all">Все уровни</option>{[...knownSegments, ...extraSegments].map(code => <option key={code} value={code}>{segmentLabel(code)}</option>)}<option value="missing">Не указан</option>{segmentFilter !== 'all' && segmentFilter !== 'missing' && ![...knownSegments, ...extraSegments].includes(segmentFilter) && <option value={segmentFilter}>{segmentFilter}</option>}</select></label>
        <label className="exploration-field"><span id="audience-eligibility-label">Допуск к подбору</span><select aria-labelledby="audience-eligibility-label" value={eligibility} onChange={event => updateFilters({ eligibility: event.target.value === 'all' ? '' : event.target.value })}><option value="all">Все группы</option><option value="eligible">Допущенные</option><option value="excluded">Исключённые</option></select></label>
        {hasChanges && <button type="button" className="button button-subtle exploration-reset" onClick={resetFilters}><X size={15} aria-hidden="true" /> Сбросить</button>}
      </div>
      <div className="exploration-results"><span><strong>{number(visibleCustomers)}</strong> клиентов во всех найденных группах</span><span>Нажмите на заголовок столбца для сортировки</span></div>
      {rows.length === 0 ? <EmptyState title={segments.length === 0 ? 'Аудитория пока не загружена' : 'Подходящих групп нет'} text={segments.length === 0 ? 'Проверьте источник данных и обновите аудиторию. Когда группы появятся, здесь будут их размеры и допуск к подбору.' : 'Попробуйте другое название тарифа или снимите ограничения по уровню выручки и допуску.'} action={hasChanges ? <button type="button" className="button button-secondary" onClick={resetFilters}>Сбросить фильтры</button> : <button type="button" className="button button-secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Обновить аудиторию</button>} /> : <>
        <p className="table-hint">Прокрутите таблицу вправо, чтобы увидеть все показатели →</p>
        <div className="table-scroll" role="region" aria-label="Таблица сегментов" tabIndex={0}><table><caption className="sr-only">Группы аудитории: тариф, уровень выручки, число клиентов, средняя ожидаемая выручка и допуск</caption><thead><tr>
          <th scope="col" aria-sort={sortState('current_tariff')}><button type="button" onClick={() => toggleSort('current_tariff')}>Текущий тариф {sortIcon('current_tariff')}</button></th>
          <th scope="col">Уровень выручки</th>
          <th scope="col" className="number-cell" aria-sort={sortState('customer_count')}><button type="button" onClick={() => toggleSort('customer_count')}>Клиенты {sortIcon('customer_count')}</button></th>
          <th scope="col" className="number-cell" aria-sort={sortState('average_predicted_arpu')}><button type="button" onClick={() => toggleSort('average_predicted_arpu')}>Выручка на абонента {sortIcon('average_predicted_arpu')}</button></th>
          <th scope="col">Допуск</th>
        </tr></thead><tbody>{pageRows.map((row, index) => <tr key={`${row.current_tariff ?? 'null'}-${row.arpu_segment ?? 'null'}-${index}`}>
          <td><strong>{tariff(row.current_tariff)}</strong>{row.current_tariff === null && <small className="table-subline">Тариф отсутствует в источнике</small>}</td>
          <td>{segmentLabel(row.arpu_segment)}</td>
          <td className="number-cell">{number(row.customer_count)}</td><td className="number-cell">{money(row.average_predicted_arpu)}</td>
          <td><StatusPill tone={row.eligible ? 'positive' : 'warning'}>{row.eligible ? 'Допущена' : 'Исключена'}</StatusPill></td>
        </tr>)}</tbody></table></div>
        <nav className="exploration-pagination" aria-label="Страницы групп аудитории"><span role="status">Группы {number(pageStart + 1)}–{number(Math.min(pageStart + pageSize, rows.length))} из {number(rows.length)}</span><div><button type="button" className="button button-subtle" aria-label="Предыдущая страница групп" disabled={currentPage === 1} onClick={() => updateFilters({ page: currentPage === 2 ? '' : String(currentPage - 1) })}><ArrowLeft size={15} aria-hidden="true" />Назад</button><span>{currentPage} / {pageCount}</span><button type="button" className="button button-subtle" aria-label="Следующая страница групп" disabled={currentPage === pageCount} onClick={() => updateFilters({ page: String(currentPage + 1) })}>Далее<ArrowRight size={15} aria-hidden="true" /></button></div></nav>
      </>}
      <div className="exploration-table-footer"><Info size={16} aria-hidden="true" /><span>Фильтры помогают изучить данные. Подбор кампаний использует всю допущенную аудиторию.</span></div>
    </Card>

    <details className="exploration-help"><summary><Info size={18} aria-hidden="true" /> Как читать показатели аудитории</summary><div className="exploration-help-grid">
      <div><h3>Выручка на абонента (ARPU)</h3><p>Сколько в среднем может принести один абонент на своём текущем тарифе. Это прогноз без новых предложений, в условных единицах (у.е.). Нажмите на заголовок столбца, чтобы сравнить группы по этому показателю.</p></div>
      <div><h3>Что такое уровень выручки</h3><p>Абоненты разделены на группы с высокой, средней и низкой выручкой. Названия взяты из исходных данных и не пересчитываются по прогнозу. Поэтому уровень и средний прогноз могут отличаться.</p></div>
      <div><h3>Что значит «Не указан»</h3><p>В исходных данных нет тарифа или сегмента. Такие записи видны отдельно; их допуск определяет проверка данных на сервере.</p></div>
      <div><h3>Можно ли изменить состав аудитории?</h3><p>Поиск и фильтры меняют только отображение таблицы. Удалить или добавить абонентов здесь нельзя: программа использует все допущенные записи из загруженных данных.</p></div>
    </div></details>
  </div>
}
