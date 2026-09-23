import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, SlidersHorizontal } from 'lucide-react'
import { api } from '../../lib/api/client'
import { money, number, segment } from '../../lib/format'
import { Card, CardHeader, EmptyState, ErrorPanel, Skeleton, StatusPill } from '../../components/ui/common'

type SortKey = 'customer_count' | 'average_predicted_arpu' | 'current_tariff'
const segmentOrder = ['HIGH', 'MID', 'LOW', null] as const

export function AudiencePage() {
  const query = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api.overview(signal) })
  const [search, setSearch] = useState('')
  const [segmentFilter, setSegmentFilter] = useState('all')
  const [sort, setSort] = useState<SortKey>('customer_count')
  const [descending, setDescending] = useState(true)
  const rows = useMemo(() => {
    const all = query.data?.segments || []
    return all.filter(row => (segmentFilter === 'all' || (row.arpu_segment || 'missing') === segmentFilter) && (row.current_tariff || 'Не указан').toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')))
      .sort((a, b) => {
        const compare = sort === 'current_tariff' ? (a.current_tariff || '').localeCompare(b.current_tariff || '', 'ru', { numeric: true }) : a[sort] - b[sort]
        return descending ? -compare : compare
      })
  }, [query.data, search, segmentFilter, sort, descending])
  if (query.isPending && !query.isError) return <div className="page-stack"><Card><Skeleton rows={5} /></Card><Card><Skeleton rows={8} /></Card></div>
  if (query.error || !query.data) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} title="Аудитория недоступна" />
  const { dataset, segments } = query.data
  const distribution = segmentOrder.map(code => ({ code, count: segments.filter(row => row.arpu_segment === code).reduce((sum, row) => sum + row.customer_count, 0) }))
  const maximum = Math.max(1, ...distribution.map(item => item.count))
  const toggleSort = (key: SortKey) => { if (sort === key) setDescending(!descending); else { setSort(key); setDescending(key !== 'current_tariff') } }
  return <div className="page-stack"><div className="section-intro"><p className="eyebrow">СИНТЕТИЧЕСКАЯ АУДИТОРИЯ</p><h2>Кого можно включить в план</h2><p>Группы собраны по текущему тарифу и исходному ARPU-сегменту. Значения сегментов не пересчитываются по прогнозу.</p></div>
    <div className="audience-top">
      <Card><CardHeader eyebrow="СТРУКТУРА" title="Состав по уровню выручки" /><div className="bars" role="img" aria-label="Распределение аудитории по ARPU-сегментам">{distribution.map(({ code, count }) => <div className="bar-row" key={code || 'missing'}><span>{segment(code)} <small>{code || 'null'}</small></span><div className="bar-track"><div className={`bar-fill bar-${code || 'missing'}`} style={{ width: `${count / maximum * 100}%` }} /></div><strong>{number(count)}</strong></div>)}</div><p className="fine-print">Размер группы включает записи с пропущенным тарифом. Точные сочетания доступны в таблице.</p></Card>
      <Card className="quality-detail"><CardHeader eyebrow="КАЧЕСТВО ДАННЫХ" title="Допуск к подбору" /><div className="quality-number">{number(dataset.eligible_customer_count)} <small>из {number(dataset.customer_count)} профилей</small></div><p>{dataset.exclusion_reason}</p><StatusPill tone="warning">{number(dataset.excluded_customer_count)} исключены</StatusPill><p className="fine-print">Пустые тарифы и сегменты показаны в таблице как «Не указан». Это исходные пропуски.</p></Card>
    </div>
    <Card className="table-card"><CardHeader eyebrow="СЕГМЕНТЫ" title="Группы аудитории" aside={<span className="result-count">{number(rows.length)} из {number(segments.length)} групп</span>} />
      <div className="table-controls"><label className="search-field"><Search size={17} aria-hidden="true" /><span className="sr-only">Поиск по тарифу</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти тариф" /></label><label className="select-field"><SlidersHorizontal size={17} aria-hidden="true" /><span className="sr-only">Сегмент выручки</span><select value={segmentFilter} onChange={event => setSegmentFilter(event.target.value)}><option value="all">Все уровни выручки</option><option value="HIGH">Высокая</option><option value="MID">Средняя</option><option value="LOW">Низкая</option><option value="missing">Не указан</option></select></label></div>
      {rows.length === 0 ? <EmptyState title={segments.length === 0 ? 'Сегментов пока нет' : 'Группы не найдены'} text={segments.length === 0 ? 'Проверьте источник синтетических данных и обновите страницу.' : 'Измените поиск или фильтр, чтобы увидеть другие сегменты.'} /> : <><p className="table-hint">Прокрутите таблицу вправо, чтобы увидеть все показатели →</p><div className="table-scroll" role="region" aria-label="Таблица сегментов" tabIndex={0}><table><thead><tr><th><button onClick={() => toggleSort('current_tariff')}>Текущий тариф {sort === 'current_tariff' ? descending ? '↓' : '↑' : ''}</button></th><th>Уровень выручки</th><th className="number-cell"><button onClick={() => toggleSort('customer_count')}>Клиенты {sort === 'customer_count' ? descending ? '↓' : '↑' : ''}</button></th><th className="number-cell"><button onClick={() => toggleSort('average_predicted_arpu')}>Средний прогноз ARPU {sort === 'average_predicted_arpu' ? descending ? '↓' : '↑' : ''}</button></th><th>Допуск</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.current_tariff || 'null'}-${row.arpu_segment || 'null'}-${index}`}><td><strong>{row.current_tariff || 'Не указан'}</strong></td><td>{segment(row.arpu_segment)} <span className="code-tag">{row.arpu_segment || 'null'}</span></td><td className="number-cell">{number(row.customer_count)}</td><td className="number-cell">{money(row.average_predicted_arpu)}</td><td><StatusPill tone={row.eligible ? 'positive' : 'warning'}>{row.eligible ? 'Допущена' : 'Исключена'}</StatusPill></td></tr>)}</tbody></table></div></>}
    </Card>
  </div>
}
