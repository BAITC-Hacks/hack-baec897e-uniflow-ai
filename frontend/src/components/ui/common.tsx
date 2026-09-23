import type { ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { ApiError } from '../../lib/api/client'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section> }
export function CardHeader({ eyebrow, title, aside }: { eyebrow?: string; title: string; aside?: ReactNode }) {
  return <div className="card-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{aside}</div>
}
export function StatusPill({ tone, children }: { tone: 'neutral' | 'positive' | 'warning' | 'negative'; children: ReactNode }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>
}
export function ErrorPanel({ error, onRetry, title = 'Не удалось получить данные' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = error instanceof ApiError ? error.message : 'Попробуйте ещё раз.'
  return <div className="error-panel" role="alert"><AlertCircle size={20} aria-hidden="true" /><div><strong>{title}</strong><p>{message}</p>{error instanceof ApiError && error.requestId && <small>Код запроса: {error.requestId}</small>}</div>{onRetry && <button className="button button-subtle" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" /> Повторить</button>}</div>
}
export function Skeleton({ rows = 3 }: { rows?: number }) { return <div className="skeleton-stack" aria-label="Загрузка данных">{Array.from({ length: rows }, (_, i) => <div className="skeleton" key={i} style={{ width: `${100 - i * 12}%` }} />)}</div> }
export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-symbol" aria-hidden="true">∅</div><h3>{title}</h3><p>{text}</p>{action}</div> }
