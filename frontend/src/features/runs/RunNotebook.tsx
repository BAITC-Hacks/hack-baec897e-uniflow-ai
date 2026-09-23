import { useState } from 'react'
import { Bookmark, Check, Save, Star } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/common'
import { getRunNote, saveRunNote, useRunNotes, type RunNote } from '../../lib/runNotes'
import './run-organization.css'

export function RunNotebook({ runId }: { runId: string }) {
  return <NotebookEditor key={runId} runId={runId} />
}

function NotebookEditor({ runId }: { runId: string }) {
  const { notes, error } = useRunNotes()
  const saved = notes[runId] || getRunNote(runId)
  const [draft, setDraft] = useState<RunNote | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const values = draft || saved
  const changed = values.name !== saved.name || values.note !== saved.note || values.favorite !== saved.favorite
  const change = (patch: Partial<RunNote>) => { setDraft({ ...values, ...patch }); setMessage(null) }
  return <Card className="run-notebook">
    <CardHeader eyebrow="ЛИЧНЫЕ ЗАМЕТКИ" title={saved.name || 'Дайте расчёту понятное название'} aside={<Bookmark size={22} aria-hidden="true" />} />
    <p className="run-notebook-hint">Название, заметка и избранное сохраняются только в этом браузере. Они не меняют расчёт и не передаются по ссылке.</p>
    <form onSubmit={event => {
      event.preventDefault()
      const result = saveRunNote(runId, values)
      setMessage({ ok: result.ok, text: result.ok ? 'Сохранено в этом браузере.' : result.error! })
      if (result.ok) setDraft(null)
    }}>
      <div className="run-notebook-fields"><label><span>Название расчёта</span><input maxLength={80} value={values.name} onChange={event => change({ name: event.target.value })} placeholder="Например: осторожный вариант для презентации" /></label><label className="run-favorite-label"><input type="checkbox" checked={values.favorite} onChange={event => change({ favorite: event.target.checked })} /><Star size={18} aria-hidden="true" />В избранном</label></div>
      <label className="run-note-field"><span>Что важно запомнить</span><textarea rows={3} maxLength={2000} value={values.note} onChange={event => change({ note: event.target.value })} placeholder="Что проверяли, почему выбрали этот вариант и к чему вернуться позже…" /></label>
      <div className="run-notebook-actions"><button className="button button-secondary" type="submit" disabled={!changed || Boolean(error)}><Save size={17} aria-hidden="true" />Сохранить заметки</button>{changed && <button className="button button-subtle" type="button" onClick={() => { setDraft(null); setMessage(null) }}>Отменить изменения</button>}{!message && changed && <span>Есть несохранённые изменения</span>}</div>
      {error && <p className="run-note-error" role="alert">{error}</p>}
      {message && <p className={message.ok ? 'run-note-success' : 'run-note-error'} role={message.ok ? 'status' : 'alert'}>{message.ok && <Check size={16} aria-hidden="true" />}{message.text}</p>}
    </form>
  </Card>
}
