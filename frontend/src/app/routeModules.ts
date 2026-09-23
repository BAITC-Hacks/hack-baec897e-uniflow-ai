export const routeModules = {
  audience: () => import('../features/audience/AudiencePage').then(module => ({ default: module.AudiencePage })),
  calculator: () => import('../features/calculator/CalculatorPage').then(module => ({ default: module.CalculatorPage })),
  newRun: () => import('../features/runs/NewRunPage').then(module => ({ default: module.NewRunPage })),
  run: () => import('../features/runs/RunPage').then(module => ({ default: module.RunPage })),
  runs: () => import('../features/runs/RunsPage').then(module => ({ default: module.RunsPage })),
  report: () => import('../features/reports/RunReportPage').then(module => ({ default: module.RunReportPage })),
  compare: () => import('../features/runs/CompareRunsPage').then(module => ({ default: module.CompareRunsPage })),
}
