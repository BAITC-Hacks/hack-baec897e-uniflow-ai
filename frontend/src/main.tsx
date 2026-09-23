import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { AppErrorBoundary } from './app/RouteStates'
import { AppRoutes } from './app/AppRoutes'
import { routeModules } from './app/routeModules'
import { demoMode } from './lib/api/client'
import './styles.css'
import './studio.css'

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2000, refetchOnWindowFocus: true, networkMode: 'always' } } })

function mount() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><AppErrorBoundary><QueryClientProvider client={client}>
      <BrowserRouter><AppRoutes /></BrowserRouter>
    </QueryClientProvider></AppErrorBoundary></React.StrictMode>,
  )
}

// Cache demo screens before interaction so navigation still works without a network.
// Connected builds load each screen only when needed.
if (demoMode) {
  void Promise.all(Object.values(routeModules).map(load => load())).then(mount, mount)
} else {
  mount()
}
