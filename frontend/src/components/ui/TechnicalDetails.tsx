import type { ReactNode } from 'react'

export function TechnicalDetails({ children, summary = 'Исходная запись расчёта' }: { children: ReactNode; summary?: string }) {
  return <details className="technical-details"><summary>{summary}</summary><p>Служебные данные для сверки с отчётом. Это записи программы, их не нужно вводить или выполнять.</p><pre>{children}</pre></details>
}
