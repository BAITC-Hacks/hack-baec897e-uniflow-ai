import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, CircleHelp, LayoutDashboard, ListChecks, Wifi, WifiOff } from 'lucide-react'
import { api, demoMode } from '../lib/api/client'

const navigation = [
  { to: '/', label: 'Обзор', icon: LayoutDashboard, end: true },
  { to: '/audience', label: 'Аудитория', icon: BarChart3, end: false },
  { to: '/runs', label: 'Запуски', icon: ListChecks, end: false },
]

function pageTitle(path: string) {
  if (path === '/') return 'Обзор'
  if (path === '/audience') return 'Аудитория'
  if (path === '/runs/new') return 'Новый подбор'
  if (path.startsWith('/runs/')) return 'Результат запуска'
  if (path === '/runs') return 'Запуски'
  return 'Campaign Studio'
}

export function Shell() {
  const location = useLocation()
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => api.health(signal), refetchInterval: 15000, retry: false })
  const connected = health.data?.status === 'ok'
  const mode = demoMode ? 'Демо · синтетические данные' : 'Локальная симуляция · синтетические данные'
  return <div className="app-shell">
    <aside className="sidebar">
      <NavLink to="/" className="brand" aria-label="UniFlow Campaign Studio — обзор">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span><strong>UniFlow</strong><small>CAMPAIGN STUDIO</small></span>
      </NavLink>
      <div className="side-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav aria-label="Основная навигация" className="side-nav">{navigation.map(({ to, label, icon: Icon, end }) =>
        <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><Icon size={19} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-bottom"><span className="case-tag">BEELINE CASE</span><p>Инструмент для исследования тарифных кампаний на синтетических данных.</p></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div><p className="mobile-brand">UniFlow <span>Campaign Studio</span></p><h1>{pageTitle(location.pathname)}</h1></div><div className="header-signals"><span className="mode-chip">{mode}</span><span className={`connection ${connected ? 'online' : 'offline'}`} title={connected ? 'API доступен' : 'API недоступен'}>{connected ? <Wifi size={16} /> : <WifiOff size={16} />}<span>{connected ? 'Подключено' : health.isPending ? 'Подключение…' : 'Нет связи'}</span></span></div></header>
      <main className="page-content"><Outlet /></main>
      <footer className="footer"><CircleHelp size={15} aria-hidden="true" /> Пилот — небольшая проверка предложения. ARPU — средняя выручка на абонента. Контакты включают повторные попытки.</footer>
    </div>
    <nav className="mobile-nav" aria-label="Основная навигация">{navigation.map(({ to, label, icon: Icon, end }) =>
      <NavLink key={to} to={to} end={end} className={({ isActive }) => `mobile-nav-link ${isActive ? 'active' : ''}`}><Icon size={20} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav>
  </div>
}
