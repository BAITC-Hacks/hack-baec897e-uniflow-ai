import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { OverviewPage } from '../features/overview/OverviewPage'
import { NotFoundPage } from './RouteStates'
import { Shell } from './Shell'
import { routeModules } from './routeModules'

const AudiencePage = lazy(routeModules.audience)
const CalculatorPage = lazy(routeModules.calculator)
const NewRunPage = lazy(routeModules.newRun)
const RunPage = lazy(routeModules.run)
const RunsPage = lazy(routeModules.runs)
const RunReportPage = lazy(routeModules.report)
const CompareRunsPage = lazy(routeModules.compare)

export function AppRoutes() {
  return <Suspense fallback={<div className="page-content" role="status">Загружаем раздел…</div>}>
    <Routes>
      <Route path="runs/:id/report" element={<RunReportPage />} />
      <Route element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="audience" element={<AudiencePage />} />
        <Route path="calculator" element={<CalculatorPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/new" element={<NewRunPage />} />
        <Route path="runs/compare" element={<CompareRunsPage />} />
        <Route path="runs/:id" element={<RunPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  </Suspense>
}
