import { useEffect, useRef, useState } from 'react'
import { FlaskConical, RefreshCw, RotateCcw } from 'lucide-react'
import type { RunSnapshot } from '../../lib/api/types'
import { calculateWhatIf, type WhatIfResult } from '../../lib/api/whatIf'
import { ErrorPanel, StatusPill } from '../../components/ui/common'
import { channel, money, number, tariff } from '../../lib/format'
import './campaign-what-if.css'

export function CampaignWhatIf({ run }: { run: RunSnapshot }) {
  if (run.status !== 'completed') return null
  return <WhatIfForm key={run.id} run={run} />
}

function WhatIfForm({ run }: { run: RunSnapshot }) {
  const [excluded, setExcluded] = useState<string[]>([])
  const [result, setResult] = useState<WhatIfResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const available = run.mode === 'local_simulation' && run.local_evaluation !== null
  function change(id: string) {
    setExcluded(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id])
    setResult(null)
    setError(null)
  }
  async function calculate() {
    const request = new AbortController()
    controller.current = request
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const next = await calculateWhatIf(run.id, excluded, request.signal)
      if (!request.signal.aborted) setResult(next)
    } catch (cause) {
      if (!request.signal.aborted) setError(cause)
    } finally {
      if (!request.signal.aborted) setPending(false)
    }
  }
  return <section id="campaign-what-if" className="card campaign-what-if run-anchor" aria-labelledby="what-if-title">
    <div className="what-if-heading"><span className="what-if-icon"><FlaskConical size={23} aria-hidden="true" /></span><div><p className="eyebrow">ПРОВЕРКА ВАРИАНТА</p><h2 id="what-if-title">Что будет, если убрать предложение?</h2></div><StatusPill tone="neutral">Учебный эксперимент</StatusPill></div>
    <p className="what-if-intro">Отключите одно или несколько предложений и сравните результат. Программа заново учтёт пересечения аудитории, порядок предложений и ограничения расходов. Уже проведённые пробные проверки останутся в расчёте.</p>
    {!available ? <p className="what-if-note">В демонстрационном примере эта проверка недоступна. Для неё нужен завершённый подбор на сервере с подключённой учебной средой.</p> : <>
      <fieldset disabled={pending} className="what-if-options"><legend>Какие предложения оставить в варианте</legend>
        {[...run.campaigns].sort((left, right) => left.execution_order - right.execution_order).map(campaign => <label key={campaign.id} className={excluded.includes(campaign.id) ? 'what-if-option what-if-excluded' : 'what-if-option'}>
          <input type="checkbox" checked={!excluded.includes(campaign.id)} onChange={() => change(campaign.id)} />
          <span><strong>№{campaign.execution_order} · {tariff(campaign.spec.target_tariff)}</strong><small>{channel(campaign.spec.channel)} · исходный охват: {number(campaign.audience_count)}</small></span>
          <span className="what-if-selection">{excluded.includes(campaign.id) ? 'Исключено' : 'Включено'}</span>
        </label>)}
      </fieldset>
      <div className="what-if-controls"><button type="button" className="button button-primary" disabled={pending || excluded.length === 0} onClick={calculate}><RefreshCw size={17} aria-hidden="true" />{pending ? 'Пересчитываем вариант…' : 'Пересчитать вариант'}</button>
        <button type="button" className="button button-subtle" disabled={pending || excluded.length === 0} onClick={() => { setExcluded([]); setResult(null); setError(null) }}><RotateCcw size={16} aria-hidden="true" />Вернуть все</button></div>
      {pending && <p role="status">Повторяем сохранённые пробные проверки и пересчитываем аудиторию. Обычно это занимает несколько секунд.</p>}
      {!result && !pending && !error && <p className="what-if-note">{excluded.length ? `Исключено предложений: ${excluded.length}. Нажмите «Пересчитать», чтобы увидеть новый результат.` : 'Снимите галочку с предложения, которое хотите проверить. Исходный план и файлы отчёта сохранятся без изменений.'}</p>}
      {error != null && <ErrorPanel error={error} title="Не удалось проверить вариант" onRetry={calculate} />}
      {result && <div className="what-if-result" aria-live="polite">
        <div className={`what-if-difference ${result.net_gain_difference < 0 ? 'negative' : result.net_gain_difference > 0 ? 'positive' : ''}`}><span>Изменение эффекта после расходов</span><strong>{result.net_gain_difference > 0 ? '+' : ''}{money(result.net_gain_difference)}</strong><p>{result.net_gain_difference > 0 ? 'В учебной проверке вариант оказался лучше исходного плана.' : result.net_gain_difference < 0 ? 'В учебной проверке исключение предложений снизило результат.' : 'В учебной проверке итоговый эффект не изменился.'}</p></div>
        <div className="what-if-comparison">
          <div><h3>Исходный план</h3><dl><dt>Эффект после расходов</dt><dd>{money(result.original.net_gain)}</dd><dt>Расходы на связь</dt><dd>{money(result.original.communication_cost)}</dd><dt>Контакты, включая повторные</dt><dd>{number(result.original.total_contacts)}</dd><dt>Уникальные абоненты</dt><dd>{number(result.original.unique_customers)}</dd></dl></div>
          <div><h3>Новый вариант</h3><dl><dt>Эффект после расходов</dt><dd>{money(result.alternative.net_gain)}</dd><dt>Расходы на связь</dt><dd>{money(result.alternative.communication_cost)}</dd><dt>Контакты, включая повторные</dt><dd>{number(result.alternative.total_contacts)}</dd><dt>Уникальные абоненты</dt><dd>{number(result.alternative.unique_customers)}</dd></dl></div>
        </div>
        <p className="what-if-note">Остаток бюджета: <strong>{money(result.alternative.remaining_budget)}</strong>. Доступно контактов: <strong>{number(result.alternative.remaining_contacts)}</strong>. В обеих колонках учтены расходы и эффект пробных проверок.</p>
        {!result.valid_final_plan && <p className="what-if-warning">Это вариант для изучения, а не готовый план: для итогового плана нужно хотя бы одно предложение с непустой аудиторией.</p>}
        <details className="what-if-method"><summary>Как рассчитано сравнение</summary><p>{result.explanation}</p><p>После исключения ранних предложений у последующих может увеличиться охват: освободившиеся ресурсы учитываются при новом расчёте. Новые предложения не добавляются.</p></details>
      </div>}
    </>}
    <p className="what-if-disclaimer">Сравниваются результаты одной учебной модели, а не прогнозы агента. Это не фактическая прибыль и не обещание дохода.</p>
  </section>
}
