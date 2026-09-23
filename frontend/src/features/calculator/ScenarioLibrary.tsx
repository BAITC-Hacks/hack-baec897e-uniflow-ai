import { useState } from 'react'
import { BookmarkPlus, Link2, Trash2 } from 'lucide-react'
import type { Overview } from '../../lib/api/types'
import { channel, number, segment, tariff } from '../../lib/format'
import {
  createScenarioUrl, MAX_SAVED_SCENARIOS, readSavedScenarios, scenarioCompatibility, writeSavedScenarios,
  type SavedScenario, type ScenarioParameters,
} from './calculatorScenarioStore'

const storage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
}

export function ScenarioLibrary({ parameters, overview, onLoad }: {
  parameters: ScenarioParameters | null
  overview: Overview
  onLoad: (parameters: ScenarioParameters) => void
}) {
  const [saved, setSaved] = useState(() => readSavedScenarios(storage))
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shared, setShared] = useState<{ url: string; parameters: string } | null>(null)
  const visibleShare = shared?.parameters === JSON.stringify(parameters) ? shared.url : null

  function persist(change: (current: SavedScenario[]) => SavedScenario[], success: string) {
    const current = readSavedScenarios(storage)
    if (current.error) { setError(current.error); setStatus(''); return false }
    const items = change(current.items)
    const failure = writeSavedScenarios(storage, items)
    if (failure) { setError(failure); setStatus(''); return false }
    setSaved({ items, error: null }); setError(null); setStatus(success)
    return true
  }

  function save() {
    if (!parameters || !name.trim()) return
    const current = readSavedScenarios(storage)
    if (current.items.length >= MAX_SAVED_SCENARIOS) { setError(`Можно хранить до ${MAX_SAVED_SCENARIOS} сценариев. Удалите ненужный, чтобы добавить новый.`); setStatus(''); return }
    const item: SavedScenario = { id: crypto.randomUUID(), name: name.trim(), note: note.trim(), createdAt: new Date().toISOString(), parameters }
    if (persist(items => [item, ...items], `Сценарий «${item.name}» сохранён в этом браузере.`)) { setName(''); setNote('') }
  }

  function prepareLink() {
    if (!parameters) return
    setShared({ url: createScenarioUrl(parameters, window.location.href), parameters: JSON.stringify(parameters) })
    setStatus('Ссылка готова. Она содержит все условия расчёта, но не название и заметку.'); setError(null)
  }

  async function copyLink() {
    if (!visibleShare) return
    try {
      await navigator.clipboard.writeText(visibleShare)
      setStatus('Ссылка скопирована. Получателю нужны доступ к приложению и тот же набор данных.'); setError(null)
    } catch {
      setError('Не удалось скопировать автоматически. Выделите ссылку в поле ниже и скопируйте вручную.'); setStatus('')
    }
  }

  return <section className="card scenario-library" id="scenario-library" aria-labelledby="scenario-library-title">
    <div className="section-intro"><p className="eyebrow">ВАШИ ВАРИАНТЫ</p><h2 id="scenario-library-title">Сохранить и вернуться к сценарию</h2><p>Назовите вариант, добавьте заметку и сравните его с другой идеей позже. Сценарии хранятся только в этом браузере; очистка данных сайта удалит их. Ссылка переносит условия расчёта на устройство с тем же набором данных.</p></div>
    <form className="scenario-save-form" onSubmit={event => { event.preventDefault(); save() }}>
      <div><label htmlFor="scenario-name">Название сценария</label><input id="scenario-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Например, небольшой бюджет" /></div>
      <div><label htmlFor="scenario-note">Заметка <span>необязательно</span></label><textarea id="scenario-note" value={note} maxLength={600} onChange={event => setNote(event.target.value)} placeholder="Что хотите проверить этим вариантом" rows={2} /></div>
      <div className="scenario-library-actions"><button className="button button-primary" type="submit" disabled={!parameters || !name.trim()}><BookmarkPlus size={17} aria-hidden="true" /> Сохранить сценарий</button><button className="button button-secondary" type="button" disabled={!parameters} onClick={prepareLink}><Link2 size={17} aria-hidden="true" /> Получить ссылку</button></div>
    </form>
    {!parameters && <p className="calculator-chart-caption">Чтобы сохранить или передать условия, сначала исправьте значения калькулятора и шага чувствительности.</p>}
    {(error || saved.error) && <p className="scenario-library-error" role="alert">{error || saved.error}</p>}
    {status && <p className="scenario-library-status" role="status">{status}</p>}
    {visibleShare && <div className="scenario-share"><label htmlFor="scenario-share-url">Ссылка с параметрами</label><input id="scenario-share-url" readOnly value={visibleShare} onFocus={event => event.target.select()} /><button type="button" className="button button-secondary" onClick={() => void copyLink()}>Скопировать ссылку</button><p>Название и заметка остаются у вас. Сама ссылка не загружает данные на сторонние сервисы. Результат пересчитается по доступным данным приложения.</p></div>}
    <div className="scenario-saved-heading"><h3>Сохранённые сценарии</h3><span>{saved.items.length} из {MAX_SAVED_SCENARIOS}</span></div>
    {saved.items.length === 0 && !saved.error ? <p className="calculator-chart-caption">Здесь появятся ваши варианты. Начните с названия и кнопки «Сохранить сценарий».</p> : <ul className="scenario-saved-list">{saved.items.map(item => {
      const mismatch = scenarioCompatibility(item.parameters, overview)
      return <li key={item.id}><div><h4>{item.name}</h4><p>{item.parameters.group ? `${tariff(item.parameters.group.tariff)} · ${segment(item.parameters.group.arpu)}` : 'Вся доступная аудитория'} · {channel(item.parameters.channel)} · {number(item.parameters.contacts)} чел.</p>{item.note && <p className="scenario-note">{item.note}</p>}<small>{new Date(item.createdAt).toLocaleString('ru-RU')} · {item.parameters.mode === 'demo' ? 'Демо' : 'Локальная симуляция'}</small>{mismatch && <p className="scenario-library-error">{mismatch}</p>}</div><div className="scenario-saved-buttons"><button className="button button-secondary" type="button" disabled={!!mismatch} aria-label={`Загрузить сценарий ${item.name}`} onClick={() => { onLoad(item.parameters); setStatus(`Сценарий «${item.name}» загружен. Результат пересчитан по текущим данным.`); setError(null); document.getElementById('scenario-group')?.focus() }}>Загрузить</button><button type="button" className="icon-button" aria-label={`Удалить сценарий ${item.name}`} title="Удалить из этого браузера" onClick={() => persist(items => items.filter(savedItem => savedItem.id !== item.id), `Сценарий «${item.name}» удалён.`)}><Trash2 size={17} aria-hidden="true" /></button></div></li>
    })}</ul>}
  </section>
}
