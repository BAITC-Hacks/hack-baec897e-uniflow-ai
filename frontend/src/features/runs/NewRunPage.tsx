import { useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, FileText, Info, Shield, Sparkles, Users } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../../lib/api/client'
import type { RiskProfile, RunConfig } from '../../lib/api/types'
import { money, number } from '../../lib/format'
import { Card, ErrorPanel, Skeleton } from '../../components/ui/common'
import { CalculatorPromo } from '../calculator/CalculatorPromo'
import './run-experience.css'

const pendingKey = 'orbitduo-pending-create-v1'

export function NewRunPage() {
  const navigate = useNavigate()
  const overview = useQuery({ queryKey: ['overview'], queryFn: ({ signal }) => api.overview(signal) })
  const [risk, setRisk] = useState<RiskProfile>('balanced')
  const [seed, setSeed] = useState('42')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const submitting = useRef(false)
  const pendingRequest = useRef<{ signature: string; key: string } | null>(null)
  const validSeed = seed.trim() !== '' && Number.isInteger(Number(seed)) && Number(seed) >= 0 && Number(seed) <= 2147483647

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || !validSeed || !overview.data || overview.data.dataset.eligible_customer_count === 0) return
    submitting.current = true
    setPending(true); setError(null); setActiveId(null)
    const config: RunConfig = { seed: Number(seed), risk_profile: risk }
    const signature = JSON.stringify(config)
    let saved = pendingRequest.current
    try {
      saved ??= JSON.parse(sessionStorage.getItem(pendingKey) || 'null') as typeof saved
    } catch { /* The in-memory key still protects retries when browser storage is unavailable. */ }
    const key = saved?.signature === signature && typeof saved.key === 'string' && saved.key ? saved.key : crypto.randomUUID()
    pendingRequest.current = { signature, key }
    try { sessionStorage.setItem(pendingKey, JSON.stringify(pendingRequest.current)) } catch { /* Browser storage can be disabled. */ }
    try {
      const run = await api.createRun(config, key)
      pendingRequest.current = null
      try { sessionStorage.removeItem(pendingKey) } catch { /* A successful API response does not depend on storage cleanup. */ }
      navigate(`/runs/${run.id}`)
    } catch (caught) {
      setError(caught)
      if (caught instanceof ApiError && caught.code === 'RUN_ALREADY_ACTIVE' && typeof caught.details.active_run_id === 'string') setActiveId(caught.details.active_run_id)
    } finally { submitting.current = false; setPending(false) }
  }

  if (overview.isPending && !overview.isError) return <Card><Skeleton rows={6} /></Card>
  if (overview.error || !overview.data) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} />
  const limits = overview.data.limits
  const noAudience = overview.data.dataset.eligible_customer_count === 0
  return <div className="page-stack setup-page">
    <div className="section-intro"><Link to="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> К обзору</Link><p className="eyebrow">НОВЫЙ РАСЧЁТ</p><h2>Подберите тарифные предложения</h2><p>Для первого раза оставьте настройки ниже и нажмите «Подобрать кампании». Программа сама выберет группы абонентов, тарифы и способы связи.</p></div>
    <ol className="run-journey" aria-label="Как устроен подбор"><li className="current" aria-current="step"><span>01</span><div><strong>Настройте подбор</strong><small>Выберите подход к риску</small></div></li><li><span>02</span><div><strong>Следите за проверкой</strong><small>Пробные предложения и выводы</small></div></li><li><span>03</span><div><strong>Изучите и скачайте план</strong><small>Что предложить и зачем</small></div></li></ol>
    <CalculatorPromo />
    <div className="setup-layout">
      <form onSubmit={submit} className="run-form" aria-label="Настройки подбора кампаний" aria-busy={pending}>
        <Card><div className="form-heading"><div className="form-icon"><Sparkles size={21} aria-hidden="true" /></div><div><p className="eyebrow">ШАГ 1</p><h3 id="risk-heading">Как оценивать риск</h3><p id="risk-help">Риск — возможность получить меньший эффект, чем обещает прогноз. Выберите, насколько осторожным должен быть подбор.</p></div></div>
          <fieldset className="risk-fieldset" disabled={pending} aria-labelledby="risk-heading" aria-describedby="risk-help"><div className="risk-options">
            <label className={`risk-option ${risk === 'balanced' ? 'selected' : ''}`}><input type="radio" name="risk" value="balanced" checked={risk === 'balanced'} onChange={() => setRisk('balanced')} /><span><strong>Сбалансированный</strong><span className="risk-recommendation">Для первого знакомства</span><small>Учитывает и ожидаемую выгоду, и точность оценки. Подходит, чтобы получить первый план и затем сравнить его с осторожным.</small></span></label>
            <label className={`risk-option ${risk === 'conservative' ? 'selected' : ''}`}><input type="radio" name="risk" value="conservative" checked={risk === 'conservative'} onChange={() => setRisk('conservative')} /><span><strong>Осторожный</strong><span className="risk-recommendation neutral">Больше внимания риску</span><small>Меньше доверяет предложениям с неточным прогнозом. Предпочитает более надёжную оценку даже при меньшей ожидаемой выгоде.</small></span></label>
          </div></fieldset>
          <p className="run-inline-help"><Info size={16} aria-hidden="true" /> Оба подхода используют одни лимиты. Осторожный режим не гарантирует положительный результат.</p>
        </Card>
        <Card><div className="form-heading"><div className="form-icon muted"><Shield size={20} aria-hidden="true" /></div><div><p className="eyebrow">ШАГ 2 · ПРОВЕРЬТЕ УСЛОВИЯ</p><h3>Фиксированные лимиты</h3><p>Бюджет и ограничения заданы для этого набора данных. Изменить их в интерфейсе нельзя.</p></div></div>
          <div className="fixed-limits"><div><span>Общий бюджет</span><strong>{money(limits.budget)}</strong><small>Проверки + готовый план</small></div><div><span>Попытки связи</span><strong>{number(limits.contacts)}</strong><small>Включая повторные</small></div><div><span>Пробные проверки</span><strong>до {number(limits.pilots)}</strong><small>На небольших группах</small></div><div><span>Кампании в плане</span><strong>до {number(limits.final_campaigns)}</strong><small>До {number(limits.customers_per_campaign)} человек в каждой</small></div></div>
          <p className="run-inline-help">Пилот — пробная проверка предложения на {number(limits.pilot_size_min)}–{number(limits.pilot_size_max)} учебных абонентах. Его расходы входят в общий бюджет. Кампания — одно предложение выбранной группе через один способ связи.</p>
          <details className="seed-details"><summary>Номер сценария (необязательно)</summary><div><label htmlFor="seed">Seed локальной симуляции</label><div className="seed-input-row"><input id="seed" type="number" min="0" max="2147483647" step="1" value={seed} onChange={event => setSeed(event.target.value)} disabled={pending} required aria-invalid={!validSeed} aria-describedby={`seed-help${validSeed ? '' : ' seed-error'}`} /><button type="button" className="button button-subtle" disabled={pending || seed === '42'} onClick={() => setSeed('42')}>Вернуть 42</button></div><p id="seed-help">Seed — номер учебного сценария. Оставьте 42 для первого расчёта. Чтобы сравнить подходы к риску в одинаковых условиях, используйте одинаковые данные, номер сценария и версию программы.</p>{!validSeed && <p id="seed-error" className="seed-error" role="alert">Введите целое число от 0 до 2 147 483 647.</p>}</div></details>
        </Card>
        {noAudience && <div className="error-panel" role="status"><Info size={19} aria-hidden="true" /><div><strong>Нет доступной аудитории</strong><p>Программе не хватает подходящих данных об абонентах. Откройте аудиторию и посмотрите причины исключения записей.</p><Link to="/audience" className="text-link">Проверить аудиторию <ArrowRight size={16} aria-hidden="true" /></Link></div></div>}
        {error != null && <ErrorPanel error={error} title={activeId ? 'Другой запуск уже выполняется' : 'Не удалось создать запуск'} />}
        {activeId && <Link to={`/runs/${activeId}`} className="button button-secondary">Открыть активный запуск <ArrowRight size={17} aria-hidden="true" /></Link>}
        {error != null && !activeId && <p className="run-inline-help">Повторите отправку с теми же настройками: если сервер уже создал запуск, откроется он же.</p>}
        <div className="setup-submit"><div><strong>Всё готово к подбору</strong><p>{risk === 'balanced' ? 'Сбалансированный' : 'Осторожный'} подход · {number(overview.data.dataset.eligible_customer_count)} доступных абонентов</p></div><button type="submit" className="button button-primary" disabled={pending || noAudience || !validSeed || !!activeId}>{pending ? 'Создаём запуск…' : 'Подобрать кампании'} <ArrowRight size={18} aria-hidden="true" /></button><p className="setup-submit-note" role="status">{pending ? 'Отправляем настройки. Страница расчёта откроется автоматически.' : 'После запуска вы увидите проверки, решения и расход ресурсов.'}</p></div>
      </form>
      <aside className="setup-aside" aria-label="Помощь с запуском">
        <Card className="setup-guide"><div className="setup-guide-icon"><FileText size={23} aria-hidden="true" /></div><p className="eyebrow">ЧТО ВЫ ПОЛУЧИТЕ</p><h3>План и разбор результата</h3><ul><li><Check size={17} aria-hidden="true" /><span>Кому предложить тариф и как связаться.</span></li><li><Check size={17} aria-hidden="true" /><span>Сколько денег и попыток связи потребуется.</span></li><li><Check size={17} aria-hidden="true" /><span>Какой эффект ожидается и что стоит проверить.</span></li><li><Check size={17} aria-hidden="true" /><span>Таблицу плана (CSV) и подробный отчёт (JSON).</span></li></ul><div className="setup-audience"><Users size={18} aria-hidden="true" /><div><strong>{number(overview.data.dataset.eligible_customer_count)} абонентов</strong><span>доступно для подбора</span></div></div><Link to="/audience" className="text-link">Посмотреть аудиторию <ArrowRight size={15} aria-hidden="true" /></Link></Card>
        <div className="setup-reassurance"><Shield size={18} aria-hidden="true" /><div><strong>{overview.data.mode === 'demo' ? 'Учебный пример' : 'Проверка в симуляции'}</strong><p>Симуляция — компьютерная проверка на учебных данных. Реальные сообщения абонентам не отправляются.</p></div></div>
        <details className="run-help-details"><summary>Как изменить или улучшить готовый план?</summary><p>Готовый результат сохраняется без изменений. На его странице можно проверить исключение кампаний отдельным экспериментом или начать новый подбор с другим подходом к риску. Для сравнения оставьте тот же номер сценария; оба результата сохранятся в «Запусках».</p></details>
        <details className="run-help-details"><summary>Нужно ли ждать на этой странице?</summary><p>После создания запуск сохраняется. Вы можете перейти в другой раздел и вернуться к нему через «Запуски». Повторно нажимать кнопку подбора для просмотра результата не нужно.</p></details>
      </aside>
    </div>
  </div>
}
