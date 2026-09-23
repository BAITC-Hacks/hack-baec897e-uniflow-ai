import { useMemo, useSyncExternalStore } from 'react'

export interface RunNote { name: string; note: string; favorite: boolean }
export const RUN_NOTES_KEY = 'orbitduo-run-notes-v1'
const changeEvent = 'orbitduo-run-notes-change'
const unavailable = '!storage-unavailable'
const emptyNote: RunNote = { name: '', note: '', favorite: false }
const emptyNotes = () => Object.create(null) as Record<string, RunNote>

function readRaw() {
  try { return window.localStorage.getItem(RUN_NOTES_KEY) || '' } catch { return unavailable }
}

function parse(raw: string): { notes: Record<string, RunNote>; error: string | null } {
  if (!raw) return { notes: emptyNotes(), error: null }
  if (raw === unavailable) return { notes: emptyNotes(), error: 'Браузер запретил доступ к заметкам. Разрешите локальное хранение, чтобы сохранять названия и избранное.' }
  try {
    const stored: unknown = JSON.parse(raw)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('format')
    const notes: Record<string, RunNote> = Object.create(null) as Record<string, RunNote>
    for (const [id, value] of Object.entries(stored)) {
      if (!value || typeof value !== 'object' || typeof value.name !== 'string' || typeof value.note !== 'string' || typeof value.favorite !== 'boolean') throw new Error('format')
      notes[id] = { name: value.name.slice(0, 80), note: value.note.slice(0, 2000), favorite: value.favorite }
    }
    return { notes, error: null }
  } catch { return { notes: emptyNotes(), error: 'Не удалось прочитать сохранённые заметки. Данные расчётов доступны; заметки в браузере повреждены и не будут перезаписаны.' } }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === RUN_NOTES_KEY || event.key === null) onChange() }
  window.addEventListener('storage', onStorage)
  window.addEventListener(changeEvent, onChange)
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(changeEvent, onChange) }
}

export function useRunNotes() {
  const raw = useSyncExternalStore(subscribe, readRaw, () => '')
  return useMemo(() => parse(raw), [raw])
}

export function getRunNote(runId: string): RunNote {
  return parse(readRaw()).notes[runId] || { ...emptyNote }
}

export function saveRunNote(runId: string, value: RunNote): { ok: boolean; error?: string } {
  const current = parse(readRaw())
  if (current.error) return { ok: false, error: current.error }
  if (!runId || runId.length > 200) return { ok: false, error: 'Не удалось определить расчёт для сохранения.' }
  const next = Object.assign(Object.create(null) as Record<string, RunNote>, current.notes)
  const normalized = { name: value.name.trim().slice(0, 80), note: value.note.trim().slice(0, 2000), favorite: value.favorite }
  if (!normalized.name && !normalized.note && !normalized.favorite) delete next[runId]
  else next[runId] = normalized
  try {
    window.localStorage.setItem(RUN_NOTES_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(changeEvent))
    return { ok: true }
  } catch { return { ok: false, error: 'Заметки не сохранены: хранилище браузера недоступно или заполнено. Текст остался в форме; скопируйте его перед закрытием.' } }
}
