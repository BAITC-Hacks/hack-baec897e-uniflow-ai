import { money, percentage } from '../../lib/format'
import type { ScenarioInput } from '../../lib/scenarioCalculator'
import { calculateSensitivity } from './calculatorScenarioStore'

export function SensitivityScenarios({ input, spread, onChange }: { input: ScenarioInput; spread: string; onChange: (value: string) => void }) {
  const value = spread.trim() ? Number(spread) : NaN
  const scenarios = calculateSensitivity(input, value)
  return <section className="card sensitivity-scenarios" aria-labelledby="sensitivity-title">
    <div className="section-intro"><p className="eyebrow">ПРОВЕРКА ПРЕДПОЛОЖЕНИЙ</p><h2 id="sensitivity-title">Три сценария результата</h2><p>Меняем только вероятность перехода на выбранный шаг вниз и вверх, в пределах 0–100%. Аудитория, канал, бюджет и изменение выручки остаются прежними. «Осторожный» даёт меньший эффект, «оптимистичный» — больший.</p></div>
    <div className="sensitivity-step"><label htmlFor="scenario-spread">Шаг вероятности, п.п.</label><input id="scenario-spread" type="number" min={0} max={100} step="any" value={spread} onChange={event => onChange(event.target.value)} aria-invalid={!scenarios} aria-describedby="scenario-spread-hint" /><p id="scenario-spread-hint">По умолчанию ±5 процентных пунктов: при базовых 10% проверяем 5% и 15%. Это выбранные допущения, а не вероятность наступления сценария.</p></div>
    {!scenarios ? <p className="scenario-library-error" role="alert">Введите шаг от 0 до 100 процентных пунктов.</p> : <div className="sensitivity-grid">{[
      { key: 'cautious', label: 'Осторожный', data: scenarios.cautious },
      { key: 'base', label: 'Базовый', data: scenarios.base },
      { key: 'optimistic', label: 'Оптимистичный', data: scenarios.optimistic },
    ].map(({ key, label, data }) => <article key={key} className={`sensitivity-variant ${key}`}><h3>{label}</h3><strong className={data.result.netGain < 0 ? 'negative-text' : ''} data-testid={`sensitivity-${key}`}>{money(data.result.netGain)}</strong><p>Вероятность перехода: <b>{percentage(data.conversionRate)}</b></p><small>С учётом канала: {percentage(data.result.effectiveConversion)}</small></article>)}</div>}
    <p className="calculator-chart-caption">Это анализ чувствительности по формуле, а не доверительный интервал прогноза. При снижении выручки больше переходов ухудшает результат, поэтому осторожный сценарий может иметь более высокий отклик. При нулевом изменении выручки или насыщении канала оценки могут совпадать.</p>
  </section>
}
