import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getRunNote, RUN_NOTES_KEY, saveRunNote, useRunNotes } from '../src/lib/runNotes'
import { RunNotebook } from '../src/features/runs/RunNotebook'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

it('merges notes without changing another run and normalizes lengths', () => {
  expect(saveRunNote('one', { name: '  Презентация  ', note: ' Перепроверить отклик ', favorite: true }).ok).toBe(true)
  expect(saveRunNote('two', { name: 'x'.repeat(100), note: 'y'.repeat(2100), favorite: false }).ok).toBe(true)
  expect(getRunNote('one')).toEqual({ name: 'Презентация', note: 'Перепроверить отклик', favorite: true })
  expect(getRunNote('two').name).toHaveLength(80)
  expect(getRunNote('two').note).toHaveLength(2000)
  expect(getRunNote('missing')).toEqual({ name: '', note: '', favorite: false })
})

it('removes blank metadata while preserving the other records', () => {
  saveRunNote('one', { name: 'Первый', note: '', favorite: false })
  saveRunNote('two', { name: 'Второй', note: '', favorite: true })
  saveRunNote('one', { name: ' ', note: '', favorite: false })
  expect(JSON.parse(localStorage.getItem(RUN_NOTES_KEY)!)).toEqual({ two: { name: 'Второй', note: '', favorite: true } })
})

it.each(['{ broken', '[]', '{"one":{"name":17,"note":"","favorite":false}}'])('does not overwrite corrupted storage: %s', raw => {
  localStorage.setItem(RUN_NOTES_KEY, raw)
  expect(getRunNote('one')).toEqual({ name: '', note: '', favorite: false })
  expect(saveRunNote('one', { name: 'Новый', note: '', favorite: false })).toMatchObject({ ok: false })
  expect(localStorage.getItem(RUN_NOTES_KEY)).toBe(raw)
})

it('handles denied reads without crashing', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
  expect(getRunNote('one')).toEqual({ name: '', note: '', favorite: false })
  render(<RunNotebook runId="one" />)
  expect(screen.getByRole('alert')).toHaveTextContent('Браузер запретил доступ')
  expect(screen.getByRole('button', { name: 'Сохранить заметки' })).toBeDisabled()
})

it('synchronizes subscribers within the page and when another tab changes storage', () => {
  function Reader() { const { notes } = useRunNotes(); return <div>{notes.one?.name || 'Пусто'}</div> }
  render(<Reader />)
  act(() => { saveRunNote('one', { name: 'Первое имя', note: '', favorite: false }) })
  expect(screen.getByText('Первое имя')).toBeVisible()
  act(() => {
    localStorage.setItem(RUN_NOTES_KEY, JSON.stringify({ one: { name: 'Другая вкладка', note: '', favorite: true } }))
    window.dispatchEvent(new StorageEvent('storage', { key: RUN_NOTES_KEY }))
  })
  expect(screen.getByText('Другая вкладка')).toBeVisible()
})

it('saves a name, note and favorite only after explicit submission', async () => {
  const user = userEvent.setup()
  render(<RunNotebook runId="one" />)
  await user.type(screen.getByRole('textbox', { name: 'Название расчёта' }), 'Для жюри')
  await user.type(screen.getByRole('textbox', { name: 'Что важно запомнить' }), 'Сравнить с осторожным')
  await user.click(screen.getByRole('checkbox', { name: 'В избранном' }))
  expect(getRunNote('one').name).toBe('')
  await user.click(screen.getByRole('button', { name: 'Сохранить заметки' }))
  expect(getRunNote('one')).toEqual({ name: 'Для жюри', note: 'Сравнить с осторожным', favorite: true })
  expect(screen.getByRole('status')).toHaveTextContent('Сохранено в этом браузере')
})

it('keeps the draft and shows an error when a write fails', async () => {
  const user = userEvent.setup()
  render(<RunNotebook runId="one" />)
  await user.type(screen.getByRole('textbox', { name: 'Название расчёта' }), 'Не потерять')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  await user.click(screen.getByRole('button', { name: 'Сохранить заметки' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Заметки не сохранены')
  expect(screen.getByRole('textbox', { name: 'Название расчёта' })).toHaveValue('Не потерять')
  expect(getRunNote('one').name).toBe('')
})
