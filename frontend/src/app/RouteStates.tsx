import { Component, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ListChecks } from 'lucide-react'

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="card fatal-error" role="alert"><p className="eyebrow">ORBITDUO · CAMPAIGN STUDIO</p><h1>Не удалось показать страницу</h1><p>Обновите приложение, чтобы попробовать снова. Сохранённые на сервере запуски останутся в истории.</p><button className="button button-primary" onClick={() => window.location.reload()}>Обновить страницу</button></main>
    return this.props.children
  }
}

export function NotFoundPage() {
  return <section className="card not-found"><span className="not-found-code">404</span><p className="eyebrow">НЕМНОГО СБИЛИСЬ С МАРШРУТА</p><h2>Страница не найдена</h2><p>Возможно, в адресе опечатка. Откройте обзор или найдите сохранённый результат в истории запусков.</p><div className="not-found-actions"><Link className="button button-primary" to="/"><ArrowLeft size={17} aria-hidden="true" />Вернуться на обзор</Link><Link className="button button-secondary" to="/runs"><ListChecks size={17} aria-hidden="true" />История запусков</Link></div></section>
}
