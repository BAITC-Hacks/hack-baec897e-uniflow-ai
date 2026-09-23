import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, BarChart3, Calculator, ChevronRight, CircleHelp, LayoutDashboard, ListChecks, Wifi, WifiOff } from 'lucide-react'
import { api, demoMode } from '../lib/api/client'
import { HelpButton, HelpProvider } from '../components/ui/HelpCenter'

const navigation = [
  { to: '/', label: 'Обзор', icon: LayoutDashboard, end: true },
  { to: '/audience', label: 'Аудитория', icon: BarChart3, end: false },
  { to: '/calculator', label: 'Калькулятор', icon: Calculator, end: false },
  { to: '/runs', label: 'Запуски', icon: ListChecks, end: false },
]

function pageTitle(path: string) {
  if (path === '/') return 'Обзор'
  if (path === '/audience') return 'Аудитория'
  if (path === '/calculator') return 'Калькулятор'
  if (path === '/runs/new') return 'Новый подбор'
  if (path.startsWith('/runs/')) return 'Результат запуска'
  if (path === '/runs') return 'Запуски'
  return 'Подбор предложений'
}

export function Shell() {
  const location = useLocation()
  const content = useRef<HTMLElement>(null)
  const previousPath = useRef(location.pathname)
  useEffect(() => {
    document.title = `${pageTitle(location.pathname)} · OrbitDuo`
    if (previousPath.current !== location.pathname) {
      window.scrollTo({ top: 0, behavior: 'instant' })
      content.current?.focus({ preventScroll: true })
      previousPath.current = location.pathname
    }
  }, [location.pathname])
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => api.health(signal), refetchInterval: 15000, retry: false })
  const connected = health.data?.status === 'ok' && !health.isError
  const mode = demoMode ? 'Демо · синтетические данные' : 'Локальная симуляция · синтетические данные'
  return <HelpProvider><a className="skip-link" href="#main-content">Перейти к содержимому</a><div className="app-shell">
    <aside className="sidebar">
      <NavLink to="/" className="brand" aria-label="OrbitDuo — обзор">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span><strong>OrbitDuo</strong><small>ПОДБОР ПРЕДЛОЖЕНИЙ</small></span>
      </NavLink>
      <div className="side-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav aria-label="Основная навигация" className="side-nav">{navigation.map(({ to, label, icon: Icon, end }) =>
        <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><Icon size={19} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav>
      <div className="side-workflow"><p className="side-caption">ОТ ДАННЫХ К РЕШЕНИЮ</p><div><span>01</span> Изучите аудиторию</div><div><span>02</span> Настройте подбор</div><div><span>03</span> Сохраните план</div></div>
      <div className="sidebar-support"><CircleHelp size={22} aria-hidden="true" /><strong>Первый раз в студии?</strong><p>Разберитесь в показателях и пройдите весь путь до плана.</p><HelpButton className="sidebar-help">Открыть справку <ArrowUpRight size={15} aria-hidden="true" /></HelpButton></div>
      <div className="sidebar-bottom"><span className="case-tag">КЕЙС BEELINE</span><p>Подбор тарифных предложений.<br />Данные синтетические.</p><span className="sidebar-version">OrbitDuo / Учебная среда</span></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div><p className="mobile-brand">OrbitDuo <span>Подбор предложений</span></p><div className="breadcrumb"><span>Рабочее пространство</span><ChevronRight size={13} aria-hidden="true" /><h1>{pageTitle(location.pathname)}</h1></div></div><div className="header-signals"><span className="mode-chip"><span className="mode-dot" />{mode}</span><span className={`connection ${connected ? 'online' : 'offline'}`} role="status" aria-label={connected ? 'Сервер доступен' : health.isPending ? 'Подключение к серверу' : 'Сервер недоступен'} title={connected ? 'Сервер доступен' : health.isPending ? 'Подключение к серверу' : 'Сервер недоступен'}>{connected ? <Wifi size={16} /> : <WifiOff size={16} />}<span>{connected ? 'Подключено' : health.isPending ? 'Подключение…' : 'Нет связи'}</span></span><HelpButton className="header-help">Справка</HelpButton></div></header>
      <main ref={content} id="main-content" tabIndex={-1} className="page-content"><Outlet /></main>
      <footer className="footer"><span>OrbitDuo <b>Подбор предложений</b> · Кейс Beeline</span><HelpButton>Подсказки и значения показателей</HelpButton></footer>
    </div>
    <nav className="mobile-nav" aria-label="Основная навигация">{navigation.map(({ to, label, icon: Icon, end }) =>
      <NavLink key={to} to={to} end={end} className={({ isActive }) => `mobile-nav-link ${isActive ? 'active' : ''}`}><Icon size={20} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav>
  </div></HelpProvider>
}
