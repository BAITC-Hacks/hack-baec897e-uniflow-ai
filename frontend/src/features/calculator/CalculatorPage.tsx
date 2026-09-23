import { useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Calculator, Info, RotateCcw, SlidersHorizontal, TrendingUp } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api/client'
import type { Channel, Overview } from '../../lib/api/types'
import { channel, money, number, percentage, segment, tariff } from '../../lib/format'
import { calculateScenario, type ScenarioInput } from '../../lib/scenarioCalculator'
import { Card, ErrorPanel, Skeleton } from '../../components/ui/common'
import './calculator.css'

const parse = (value: string) => value.trim() === '' ? NaN : Number(value)

function SliderField({ id, label, value, onChange, min, max, step = 1, unit, hint }: {
  id: string; label: string; value: string; onChange: (value: string) => void
  min: number; max: number; step?: number; unit: string; hint: string
}) {
  const numeric = parse(value)
  const invalid = !Number.isFinite(numeric) || numeric < min || numeric > max || (id === 'scenario-count' && !Number.isInteger(numeric))
  const sliderValue = Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : min
  const fill = max > min ? (sliderValue - min) / (max - min) * 100 : 0
  return <div className="calculator-slider">
    <div className="calculator-slider-heading"><label htmlFor={id}>{label}</label><div className="calculator-value-wrap"><input id={id} type="number" inputMode="decimal" min={min} max={max} step={step} value={value} onChange={event => onChange(event.target.value)} aria-invalid={invalid} aria-describedby={`${id}-hint${invalid ? ` ${id}-error` : ''}`} /><span className="calculator-unit">{unit}</span></div></div>
    <input className="calculator-range" type="range" aria-label={`${label}: ползунок`} aria-describedby={`${id}-hint`} min={min} max={max || 1} step={step} disabled={max === min} value={sliderValue} onChange={event => onChange(event.target.value)} style={{ '--range-progress': `${fill}%` } as CSSProperties} />
    <div className="calculator-range-labels" aria-hidden="true"><span>{number(min)} {unit}</span><span>{number(max)} {unit}</span></div>
    <p id={`${id}-hint`}>{hint}</p>
    {invalid && <p id={`${id}-error`} className="negative-text">{id === 'scenario-count' ? 'Введите целое число' : 'Введите число'} от {number(min)} до {number(max)}.</p>}
  </div>
}

function SensitivityChart({ input }: { input: ScenarioInput }) {
  const probabilities = [...new Set([
    ...Array.from({ length: 41 }, (_, index) => index / 40),
    input.conversionRate,
    Math.min(1, input.conversionMultiplier > 0 ? 1 / input.conversionMultiplier : 1),
  ])].sort((a, b) => a - b)
  const values = probabilities.map(conversionRate => calculateScenario({ ...input, conversionRate }).netGain)
  const finalValue = values[values.length - 1]
  const low = Math.min(0, ...values)
  const high = Math.max(0, ...values)
  const spread = high - low || 1
  const x = (probability: number) => 22 + probability * 316
  const y = (gain: number) => 122 - (gain - low) / spread * 96
  const current = calculateScenario(input)
  const points = values.map((value, index) => `${x(probabilities[index])},${y(value)}`).join(' ')
  const zero = y(0)
  return <div className="calculator-chart">
    <h3>Если отклик изменится</h3>
    <p>Как меняется эффект при другой вероятности перехода. Остальные условия те же.</p>
    <svg viewBox="0 0 360 155" role="img" aria-label={`Эффект при вероятности перехода от 0 до 100 процентов: от ${money(values[0])} до ${money(finalValue)}. Текущая оценка ${money(current.netGain)}.`}>
      <line x1="22" x2="338" y1={zero} y2={zero} stroke="currentColor" opacity="0.25" strokeDasharray="4 4" />
      <polygon points={`22,${zero} ${points} 338,${zero}`} fill="currentColor" opacity="0.08" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <line x1={x(input.conversionRate)} x2={x(input.conversionRate)} y1="20" y2="125" stroke="currentColor" opacity="0.2" />
      <circle cx={x(input.conversionRate)} cy={y(current.netGain)} r="5" fill="currentColor" stroke="white" strokeWidth="2" />
      <text x="22" y="146">0%</text><text x="180" y="146" textAnchor="middle">50%</text><text x="338" y="146" textAnchor="end">100%</text>
    </svg>
    <div className="calculator-range-labels"><span>При 0%: {money(values[0])}</span><span>При 100%: {money(finalValue)}</span></div>
    <p className="calculator-chart-caption">Точка — ваш сценарий. Пунктир — нулевой эффект. График показывает зависимость по формуле, а не диапазон достоверности прогноза.</p>
  </div>
}

function ScenarioWorkbench({ overview }: { overview: Overview }) {
  const groups = overview.segments.filter(item => item.eligible && item.customer_count > 0)
  const [groupKey, setGroupKey] = useState('all')
  const [selectedChannel, setSelectedChannel] = useState<Channel>(overview.channels[0]?.code || 'push')
  const initialCount = String(Math.min(1000, overview.limits.customers_per_campaign, overview.limits.contacts, groups.reduce((sum, group) => sum + group.customer_count, 0)))
  const [count, setCount] = useState(initialCount)
  const [budget, setBudget] = useState(String(overview.limits.budget))
  const [conversion, setConversion] = useState('10')
  const [lift, setLift] = useState('10')
  const selectedGroups = groupKey === 'all' ? groups : groups.filter((_, index) => String(index) === groupKey)
  const audienceSize = selectedGroups.reduce((sum, group) => sum + group.customer_count, 0)
  const revenue = selectedGroups.reduce((sum, group) => sum + group.baseline_revenue, 0)
  const averageRevenue = audienceSize > 0 ? revenue / audienceSize : 0
  const selected = overview.channels.find(item => item.code === selectedChannel)
  const maxContacts = Math.min(overview.limits.customers_per_campaign, overview.limits.contacts, audienceSize)
  const input: ScenarioInput = {
    requestedContacts: parse(count), audienceSize, averageRevenue,
    conversionRate: parse(conversion) / 100, revenueLift: parse(lift) / 100,
    budget: parse(budget), costPerContact: selected?.cost_per_contact ?? NaN,
    conversionMultiplier: selected?.conversion_multiplier ?? NaN,
    contactLimit: overview.limits.contacts, campaignLimit: overview.limits.customers_per_campaign,
  }
  const result = calculateScenario(input)
  const uiError = input.budget > overview.limits.budget ? 'Бюджет сценария превышает лимит набора данных.' : input.requestedContacts > maxContacts ? 'Число абонентов превышает доступную аудиторию или лимит одной кампании.' : null
  const valid = result.valid && !uiError && audienceSize > 0
  const state = result.netGain > 0 ? 'positive' : result.netGain < 0 ? 'negative' : 'neutral'
  const reset = () => { setGroupKey('all'); setSelectedChannel(overview.channels[0]?.code || 'push'); setCount(initialCount); setBudget(String(overview.limits.budget)); setConversion('10'); setLift('10') }
  function changeGroup(value: string) {
    setGroupKey(value)
    const available = value === 'all' ? groups.reduce((sum, group) => sum + group.customer_count, 0) : groups[Number(value)]?.customer_count || 0
    setCount(String(Math.min(Number.isFinite(parse(count)) ? parse(count) : 1000, available, overview.limits.customers_per_campaign, overview.limits.contacts)))
  }

  return <>
    <div className="calculator-assumptions"><Info size={20} aria-hidden="true" /><p><strong>Попробуйте «что будет, если».</strong> Аудитория и цены связи взяты из данных. Вероятность перехода и изменение выручки — ваши предположения; стартовые 10% приведены для примера. Ползунки сразу пересчитывают результат без запуска подбора.</p></div>
    <a className="calculator-live-preview" href="#scenario-result"><span>Предварительный эффект</span><strong className={state}>{valid ? money(result.netGain) : 'Проверьте значения'}</strong><small>К деталям ↓</small></a>
    <div className="calculator-layout">
      <Card className="calculator-controls">
        <div className="calculator-control-header"><SlidersHorizontal size={22} aria-hidden="true" /><div><h3>Условия одного предложения</h3><p>Двигайте ползунки или вводите точные значения.</p></div><button type="button" className="icon-button" onClick={reset} aria-label="Сбросить калькулятор" title="Вернуть пример"><RotateCcw size={18} aria-hidden="true" /></button></div>
        <div className="calculator-field"><label htmlFor="scenario-group">Кому предложить</label><select id="scenario-group" value={groupKey} onChange={event => changeGroup(event.target.value)}><option value="all">Вся доступная аудитория</option>{groups.map((group, index) => <option key={`${group.current_tariff}-${group.arpu_segment}-${index}`} value={String(index)}>{tariff(group.current_tariff)} · {segment(group.arpu_segment)} · {number(group.customer_count)} чел.</option>)}</select><p>В группе {number(audienceSize)} абонентов. Средняя исходная выручка — <strong>{money(averageRevenue)}</strong> на человека за расчётный период. Используем среднее группы; конкретные люди могут отличаться.</p></div>
        <div className="calculator-field"><label htmlFor="scenario-channel">Как связаться</label><select id="scenario-channel" value={selectedChannel} onChange={event => setSelectedChannel(event.target.value as Channel)}>{overview.channels.map(item => <option key={item.code} value={item.code}>{channel(item.code)} · {money(item.cost_per_contact)} за контакт</option>)}</select><p>Одна попытка связи с каждым абонентом. Влияние этого канала на вероятность перехода: ×{selected?.conversion_multiplier.toLocaleString('ru-RU')}.</p></div>
        <SliderField id="scenario-count" label="Сколько абонентов охватить" value={count} onChange={setCount} min={0} max={maxContacts} unit="чел." hint={`До ${number(maxContacts)} человек: учитываем размер группы и лимиты. Если денег не хватит, ниже покажем доступное число контактов.`} />
        <SliderField id="scenario-budget" label="Бюджет на связь" value={budget} onChange={setBudget} min={0} max={overview.limits.budget} unit="у.е." hint="Это потолок расходов для вашего сценария. Он не меняет бюджет автоматического подбора. Неиспользованные деньги остаются в запасе." />
        <SliderField id="scenario-conversion" label="Вероятность перехода" value={conversion} onChange={setConversion} min={0} max={100} unit="%" hint="Ваше предположение до учёта канала. Умножаем на влияние способа связи, но итоговая вероятность не может превышать 100%." />
        <SliderField id="scenario-lift" label="Изменение выручки после перехода" value={lift} onChange={setLift} min={-100} max={100} unit="%" hint="На сколько изменится выручка от согласившегося абонента относительно текущей. Отрицательное значение означает снижение. Это предположение, а не разница в цене тарифов." />
      </Card>
      <section className="card calculator-result" id="scenario-result" aria-label="Результат предварительного расчёта">
        <p className="calculator-result-label"><TrendingUp size={18} aria-hidden="true" /> ПРЕДВАРИТЕЛЬНЫЙ ЭФФЕКТ</p>
        <div role="status" aria-live="polite" aria-atomic="true">{valid ? <><div className={`calculator-total ${state}`} data-testid="scenario-net">{money(result.netGain)}</div><p className="calculator-result-caption">Дополнительная выручка после расходов на связь при заданных вами условиях.</p></> : <div className="calculator-empty"><h3>{audienceSize === 0 ? 'Нет доступной аудитории' : 'Проверьте значения'}</h3><p>{audienceSize === 0 ? 'Для предварительной оценки нужны подходящие данные об абонентах.' : uiError || result.error}</p></div>}</div>
        {valid && <>
          <dl className="calculator-breakdown"><div><dt>Контактов в сценарии</dt><dd data-testid="scenario-contacts">{number(result.contacts)}</dd></div><div><dt>Вероятность с учётом канала</dt><dd>{percentage(result.effectiveConversion)}</dd></div><div><dt>Ожидается переходов <small>расчётное среднее</small></dt><dd>{result.expectedConversions.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</dd></div><div><dt>Изменение выручки до расходов</dt><dd data-testid="scenario-gross">{money(result.grossGain)}</dd></div><div><dt>Расходы на связь</dt><dd data-testid="scenario-cost">{money(result.communicationCost)}</dd></div><div><dt>Остаток бюджета</dt><dd>{money(result.remainingBudget)}</dd></div></dl>
          {result.contacts < result.requestedContacts && <p className="calculator-limits">Бюджета хватает на {number(result.contacts)} из {number(result.requestedContacts)} выбранных абонентов. Оценка выше рассчитана только для доступных контактов.</p>}
          <div className={`calculator-verdict ${result.contacts === 0 ? 'neutral' : state}`}><strong>{result.contacts === 0 ? 'В этом сценарии нет контактов' : result.netGain > 0 ? 'При этих условиях эффект положительный' : result.netGain < 0 ? 'При этих условиях эффект отрицательный' : 'При этих условиях эффект равен нулю'}</strong><p>{result.breakEvenMessage}</p>{result.breakEvenConversion !== null && result.breakEvenConversion > 0 && <p>Порог базовой вероятности перехода: <strong>{result.breakEvenConversion.toLocaleString('ru-RU', { style: 'percent', maximumFractionDigits: 2 })}</strong>. Сравните его с вашим предположением.</p>}</div>
          <SensitivityChart input={input} />
        </>}
        <p className="calculator-chart-caption">Это оценка одного предложения за период исходных данных. Она не включает пилоты, повторные контакты, пересечения аудиторий и прочие расходы бизнеса. Полную прибыль по ней определить нельзя.</p>
      </section>
    </div>
    {valid && <section aria-labelledby="channel-comparison-heading"><div className="section-intro"><p className="eyebrow">СРАВНИТЕ ВАРИАНТЫ</p><h2 id="channel-comparison-heading">А если выбрать другой способ связи?</h2><p>Те же предположения и бюджет. Доступное число контактов зависит от цены. Нажмите вариант, чтобы применить его к калькулятору.</p></div><div className="calculator-channel-grid">{overview.channels.map(item => {
      const comparison = calculateScenario({ ...input, costPerContact: item.cost_per_contact, conversionMultiplier: item.conversion_multiplier })
      return <button type="button" key={item.code} className={`calculator-channel ${selectedChannel === item.code ? 'selected' : ''}`} disabled={!comparison.valid} aria-pressed={selectedChannel === item.code} onClick={() => setSelectedChannel(item.code)}><span>{channel(item.code)}</span><strong className={comparison.netGain < 0 ? 'negative-text' : ''}>{comparison.valid ? money(comparison.netGain) : 'Нет оценки'}</strong><small>{comparison.valid ? `${number(comparison.contacts)} контактов · расход ${money(comparison.communicationCost)}` : comparison.error}</small></button>
    })}</div></section>}
    <details className="calculator-formula"><summary>Как получилась эта сумма и чему можно доверять?</summary><div><p><strong>Эффект = контакты × средняя выручка × изменение выручки × вероятность с учётом канала − расходы на связь.</strong></p><p>Расходы на связь = контакты × цена одной попытки. Вероятность с учётом канала = ваше предположение × влияние канала, максимум 100%. Количество контактов ограничено аудиторией, бюджетом и лимитами одной кампании.</p><p>Средняя выручка вычисляется только по доступным группам. Калькулятор не знает, кто действительно перейдёт на другой тариф. Он не подбирает целевой тариф и не оценивает его скрытый эффект: для этого нужен полноценный подбор с пробными проверками.</p><p>Все суммы — в условных единицах. Подсчёт выполняется без округления промежуточных значений; на экране денежные суммы округлены. График и сравнение каналов отражают одни и те же предположения, а не доказательство лучшего предложения.</p></div></details>
    <Card className="calculator-next"><div><p className="eyebrow">СЛЕДУЮЩИЙ ШАГ</p><h2>Проверьте идеи автоматическим подбором</h2><p>Программа сама выберет аудитории и тарифы, проведёт пробные проверки и соберёт план. Значения калькулятора служат для знакомства и не передаются в настройки подбора.</p></div><Link to="/runs/new" className="button button-primary">Перейти к подбору <ArrowRight size={17} aria-hidden="true" /></Link></Card>
  </>
}

export function CalculatorPromo() {
  return <div className="calculator-promo"><Calculator size={26} aria-hidden="true" /><div><strong>Сначала прикиньте эффект</strong><p>Изменяйте аудиторию, бюджет и отклик — предварительная оценка обновится сразу.</p></div><Link className="text-link" to="/calculator">Открыть калькулятор <ArrowRight size={17} aria-hidden="true" /></Link></div>
}

export function CalculatorPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api.overview(signal) })
  return <div className="page-stack calculator-page"><div className="section-intro calculator-intro"><p className="eyebrow">ПЕРЕД ПОДБОРОМ</p><h2>Калькулятор эффекта</h2><p>Посмотрите, как аудитория, отклик и расходы влияют на результат одного предложения.</p><span className="calculator-badge"><Calculator size={15} aria-hidden="true" /> Мгновенный расчёт по вашим условиям</span></div>
    {overview.isPending && <Card><Skeleton rows={6} /></Card>}
    {overview.error && <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} title={overview.data ? 'Показаны последние доступные данные' : 'Не удалось загрузить данные для калькулятора'} />}
    {overview.data && <ScenarioWorkbench key={overview.data.dataset.id} overview={overview.data} />}
  </div>
}
