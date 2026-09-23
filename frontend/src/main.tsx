import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Shell } from './app/Shell'
import { OverviewPage } from './features/overview/OverviewPage'
import { AudiencePage } from './features/audience/AudiencePage'
import { NewRunPage } from './features/runs/NewRunPage'
import { RunPage } from './features/runs/RunPage'
import { RunsPage } from './features/runs/RunsPage'
import './styles.css'

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2000, refetchOnWindowFocus: true } } })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={client}><BrowserRouter><Routes>
    <Route element={<Shell />}>
      <Route index element={<OverviewPage />} />
      <Route path="audience" element={<AudiencePage />} />
      <Route path="runs" element={<RunsPage />} />
      <Route path="runs/new" element={<NewRunPage />} />
      <Route path="runs/:id" element={<RunPage />} />
      <Route path="*" element={<div className="card"><h2>Страница не найдена</h2><a href="/">Вернуться на обзор</a></div>} />
    </Route>
  </Routes></BrowserRouter></QueryClientProvider></React.StrictMode>,
)
