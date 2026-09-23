import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { NewRunPage } from '../src/features/runs/NewRunPage'
import { api, ApiError } from '../src/lib/api/client'
import overview from '../src/mocks/overview.json'
import type { Overview, RunSnapshot } from '../src/lib/api/types'

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear() })

function renderNewRun() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter><NewRunPage /></MemoryRouter></QueryClientProvider>)
}

it('keeps an empty seed invalid instead of silently changing it to zero', async () => {
  vi.spyOn(api, 'overview').mockResolvedValue(overview as Overview)
  const create = vi.spyOn(api, 'createRun')
  renderNewRun()
  const button = await screen.findByRole('button', { name: 'Подобрать кампании' })
  const user = userEvent.setup()
  await user.click(screen.getByText('Номер сценария (необязательно)'))
  const seed = screen.getByLabelText('Seed локальной симуляции')
  await user.clear(seed)
  expect(seed).toHaveValue(null)
  expect(seed).toHaveAttribute('aria-invalid', 'true')
  expect(button).toBeDisabled()
  expect(create).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Вернуть 42' }))
  expect(seed).toHaveValue(42)
  expect(button).toBeEnabled()
})

it('locks settings while a request is pending and prevents duplicate clicks', async () => {
  vi.spyOn(api, 'overview').mockResolvedValue(overview as Overview)
  const create = vi.spyOn(api, 'createRun').mockImplementation(() => new Promise(() => {}))
  renderNewRun()
  const button = await screen.findByRole('button', { name: 'Подобрать кампании' })
  const user = userEvent.setup()
  await user.dblClick(button)
  expect(create).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Создаём запуск…' })).toBeDisabled()
  for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
})

it('retries with the same key and completes even when session storage is unavailable', async () => {
  vi.spyOn(api, 'overview').mockResolvedValue(overview as Overview)
  const create = vi.spyOn(api, 'createRun')
    .mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 'Connection lost'))
    .mockResolvedValueOnce({ id: 'completed-run' } as RunSnapshot)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/runs/new']}><Routes>
    <Route path="/runs/new" element={<NewRunPage />} />
    <Route path="/runs/:id" element={<p>Saved run opened</p>} />
  </Routes></MemoryRouter></QueryClientProvider>)
  const button = await screen.findByRole('button', { name: 'Подобрать кампании' })
  const user = userEvent.setup()
  await user.click(button)
  await screen.findByText('Connection lost')
  expect(button).toBeEnabled()
  await user.click(button)
  await screen.findByText('Saved run opened')
  expect(create).toHaveBeenCalledTimes(2)
  expect(create.mock.calls[0][1]).toEqual(create.mock.calls[1][1])
})
