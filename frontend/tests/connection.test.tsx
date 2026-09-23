import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { Shell } from '../src/app/Shell'
import { api, ApiError } from '../src/lib/api/client'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows a lost connection even while the previous healthy response is cached', async () => {
  vi.spyOn(api, 'health')
    .mockResolvedValueOnce({ status: 'ok', api_version: '1', mode: 'local_simulation' })
    .mockRejectedValue(new ApiError('NETWORK_ERROR', 'Connection lost'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><Shell /></MemoryRouter></QueryClientProvider>)
  await screen.findByText('Подключено')
  await client.refetchQueries({ queryKey: ['health'] })
  await screen.findByText('Нет связи')
  expect(screen.queryByText('Подключено')).not.toBeInTheDocument()
})
