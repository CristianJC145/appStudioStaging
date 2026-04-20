import { useState, useEffect } from "react"
import { BrowserRouter, Routes, Route, useNavigate, useLocation, Navigate } from "react-router-dom"
import Landing from "./pages/Landing"
import StudioLanding from "./pages/StudioLanding"
import Login from "./pages/Login"
import LandingHome      from "./pages/landing/Home"
import LandingNosotros  from "./pages/landing/Nosotros"
import LandingCanal     from "./pages/landing/Canal"
import LandingContenido from "./pages/landing/Contenido"
import LandingComunidad from "./pages/landing/Comunidad"
import ModuleHub from "./components/ModuleHub"
import GuionesModule    from "./modules/guiones"
import BuclesModule     from "./modules/bucles"
import GeneradorModule  from "./modules/generador"
import AudioSyncModule  from "./modules/audiosync"
import AdminPanel from "./pages/AdminPanel"
import modules from "./modules/registry"
import logoImg from "./assets/logo.png"
import { ConfirmProvider } from "./components/ConfirmModal"
import "./App.css"

const API = import.meta.env.VITE_API_URL || "http://localhost:8000"

/* ── Inline SVG icons ────────────────────────────────────────── */
const IconGrid = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
    <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
  </svg>
)
const IconWave = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M2 12h2.5M19.5 12H22M6.5 7v10M10 4v16M13.5 7v10M17 4v16"/>
  </svg>
)
const IconImage = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
    <path d="m21 15-5-5L5 21"/>
  </svg>
)
const IconLoop = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
  </svg>
)
const IconMonitor = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
  </svg>
)
const IconChevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M9 18l6-6-6-6"/>
  </svg>
)
const IconMenu = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M3 12h18M3 6h18M3 18h18"/>
  </svg>
)
const IconCollapse = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M11 19l-7-7 7-7M21 19l-7-7 7-7"/>
  </svg>
)
const IconExpand = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M13 5l7 7-7 7M3 5l7 7-7 7"/>
  </svg>
)

const IconShield = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
)

const IconPen = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
  </svg>
)

const IconSync = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>
    <line x1="12" y1="3" x2="12" y2="9"/><line x1="12" y1="15" x2="12" y2="21"/>
  </svg>
)

const MODULE_ICONS = {
  guiones:    IconWave,
  miniaturas: IconMonitor,
  bucles:     IconLoop,
  imagenes:   IconImage,
  generador:  IconPen,
  audiosync:  IconSync,
}

/* ── Module disabled screen ──────────────────────────────────── */
function ModuleDisabled({ name }) {
  const navigate = useNavigate()
  return (
    <div className="mod-disabled">
      <div className="mod-disabled-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h2 className="mod-disabled-title">Módulo desactivado</h2>
      <p className="mod-disabled-desc">
        <strong>{name}</strong> ha sido desactivado por el administrador.<br/>Contacta al equipo si crees que es un error.
      </p>
      <button className="mod-disabled-btn" onClick={() => navigate("/studio")}>
        Volver al Dashboard
      </button>
    </div>
  )
}

/* ── Module gate: blocks disabled modules ────────────────────── */
function ModuleGate({ id, name, states, children }) {
  // While states haven't loaded yet (empty object) allow access to avoid flashing
  const hasLoaded = Object.keys(states).length > 0
  const disabled  = hasLoaded && states[id] === false
  return disabled ? <ModuleDisabled name={name} /> : children
}

/* ── Auth guard ──────────────────────────────────────────────── */
function RequireAuth({ children }) {
  const token = localStorage.getItem("studio_token")
  return token ? children : <Navigate to="/login" replace />
}

/* ── Shell ───────────────────────────────────────────────────── */
function Shell() {
  const navigate   = useNavigate()
  const location   = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const storedUser  = localStorage.getItem("studio_user")
  const currentUser = storedUser ? JSON.parse(storedUser) : null
  const isAdmin     = currentUser?.role === "admin"

  const [moduleStates, setModuleStates] = useState({})

  useEffect(() => {
    document.body.classList.add("dashboard-body")
    return () => document.body.classList.remove("dashboard-body")
  }, [])

  // Fetch module enabled/disabled states — also poll every 60 s so changes propagate
  const fetchModuleStates = () => {
    const token = localStorage.getItem("studio_token")
    fetch(`${API}/api/admin/modules`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : {})
      .then(data => setModuleStates(data))
      .catch(() => {})
  }
  useEffect(() => {
    fetchModuleStates()
    const id = setInterval(fetchModuleStates, 60_000)
    // Refresh immediately when the tab regains focus
    const onFocus = () => fetchModuleStates()
    window.addEventListener("focus", onFocus)
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat every 30 s so backend can count active users
  useEffect(() => {
    const token = localStorage.getItem("studio_token")
    const ping = () => fetch(`${API}/api/admin/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
    ping()
    const id = setInterval(ping, 30_000)
    return () => clearInterval(id)
  }, [])

  const isHub       = location.pathname === "/studio" || location.pathname === "/studio/"
  const isAdminPage = location.pathname.startsWith("/studio/admin")
  const activeMod   = modules.find(m => location.pathname.startsWith(m.path))

  const isModEnabled = (id) => moduleStates[id] !== false

  const breadcrumbs = [
    { label: "Dashboard", path: "/studio" },
    ...(isAdminPage  ? [{ label: "Administración", path: "/studio/admin" }] : []),
    ...(activeMod    ? [{ label: activeMod.name,   path: activeMod.path  }] : []),
  ]

  const goTo = (path) => { navigate(path); setMobileOpen(false) }

  return (
    <div className={`dashboard${collapsed ? " sb-collapsed" : ""}${mobileOpen ? " sb-mobile-open" : ""}`}>

      {/* ══ TOPBAR ══════════════════════════════════════ */}
      <header className="topbar">
        <div className="topbar-left">
          <button className="topbar-menu-btn" onClick={() => setMobileOpen(p => !p)} aria-label="Menú">
            <IconMenu />
          </button>
          <nav className="breadcrumb" aria-label="Navegación">
            {breadcrumbs.map((c, i) => (
              <span key={c.path} className="bc-item">
                {i > 0 && <span className="bc-sep"><IconChevron /></span>}
                {i < breadcrumbs.length - 1
                  ? <button className="bc-link" onClick={() => goTo(c.path)}>{c.label}</button>
                  : <span className="bc-current">{c.label}</span>
                }
              </span>
            ))}
          </nav>
        </div>
        <div className="topbar-right">
          <span className="topbar-badge">v3.0</span>
          <div className="topbar-status">
            <span className="topbar-dot" />
            <span className="topbar-status-label">En línea</span>
          </div>
          {currentUser && (
            <div className="topbar-user">
              <div className="topbar-user-avatar">
                {currentUser.username.charAt(0).toUpperCase()}
              </div>
              <div className="topbar-user-info">
                <span className="topbar-user-name">{currentUser.username}</span>
                {isAdmin && <span className="topbar-admin-badge">Admin</span>}
              </div>
            </div>
          )}
        </div>
      </header>

      {/* ══ SIDEBAR ═════════════════════════════════════ */}
      <aside className="sidebar">
        {/* Brand */}
        <div className="sb-brand" onClick={() => goTo("/studio")} role="button" tabIndex={0} onKeyDown={e => e.key === "Enter" && goTo("/studio")}>
          <img src={logoImg} className="sb-logo" alt="Logo" />
          <div className="sb-brand-text">
            <span className="sb-brand-name">INGENIERIA</span>
            <span className="sb-brand-sub">Studio</span>
          </div>
        </div>

        {/* Nav */}
        <div className="sb-section-label">Navegación</div>
        <nav className="sb-nav">
          <button className={`sb-item${isHub ? " active" : ""}`} onClick={() => goTo("/studio")} title="Dashboard">
            <span className="sb-item-icon"><IconGrid /></span>
            <span className="sb-item-label">Dashboard</span>
          </button>

          <div className="sb-section-label sb-section-label--modules">Módulos</div>

          {modules.map(mod => {
            const Icon     = MODULE_ICONS[mod.id] || IconGrid
            const isActive = location.pathname.startsWith(mod.path)
            const isSoon   = mod.status === "coming-soon"
            const disabled = !isModEnabled(mod.id)
            return (
              <button
                key={mod.id}
                className={`sb-item${isActive ? " active" : ""}${isSoon ? " sb-item--soon" : ""}${disabled ? " sb-item--disabled" : ""}`}
                onClick={() => !isSoon && !disabled && goTo(mod.path)}
                title={disabled ? `${mod.name} — Desactivado` : isSoon ? `${mod.name} — Próximamente` : mod.name}
                aria-disabled={isSoon || disabled}
              >
                <span className="sb-item-icon"><Icon /></span>
                <span className="sb-item-label">{mod.name}</span>
                {isSoon   && <span className="sb-soon-badge">Soon</span>}
                {disabled && <span className="sb-soon-badge sb-off-badge">Off</span>}
              </button>
            )
          })}

          {isAdmin && (
            <>
              <div className="sb-section-label sb-section-label--modules">Admin</div>
              <button
                className={`sb-item${isAdminPage ? " active" : ""}`}
                onClick={() => goTo("/studio/admin")}
                title="Panel de administración"
              >
                <span className="sb-item-icon"><IconShield /></span>
                <span className="sb-item-label">Administración</span>
              </button>
            </>
          )}
        </nav>

        {/* Collapse toggle */}
        <button className="sb-collapse-btn" onClick={() => setCollapsed(p => !p)} aria-label="Colapsar sidebar">
          {collapsed ? <IconExpand /> : <IconCollapse />}
          <span className="sb-item-label">Colapsar</span>
        </button>

        {/* Logout */}
        <button
          className="sb-logout-btn"
          onClick={() => { localStorage.removeItem("studio_token"); localStorage.removeItem("studio_user"); navigate("/login") }}
          title="Cerrar sesión"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          <span className="sb-item-label">Cerrar sesión</span>
        </button>

        {/* Footer */}
        <div className="sb-footer">
          <span className="sb-footer-text">Ingeniería de la Manifestación</span>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && <div className="sb-overlay" onClick={() => setMobileOpen(false)} />}

      {/* ══ CONTENT ═════════════════════════════════════ */}
      <main className="dash-content">
        <Routes>
          <Route index                  element={<ModuleHub moduleStates={moduleStates} />} />
          <Route path="guiones/*"       element={<ModuleGate id="guiones"   name="Automatización de Audios"    states={moduleStates}><GuionesModule   /></ModuleGate>} />
          <Route path="bucles/*"        element={<ModuleGate id="bucles"    name="Bucles de Video"             states={moduleStates}><BuclesModule    /></ModuleGate>} />
          <Route path="generador/*"     element={<ModuleGate id="generador" name="Generador de Guiones IA"     states={moduleStates}><GeneradorModule /></ModuleGate>} />
          <Route path="audiosync/*"     element={<ModuleGate id="audiosync" name="AudioSync"                   states={moduleStates}><AudioSyncModule /></ModuleGate>} />
          <Route path="admin"           element={isAdmin ? <AdminPanel /> : <Navigate to="/studio" replace />} />
        </Routes>
      </main>

    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ConfirmProvider>
        <Routes>
          <Route path="/" element={<StudioLanding />} />
          <Route path="/portafolio" element={<Landing />}>
            <Route index                    element={<LandingHome />}      />
            <Route path="nosotros"          element={<LandingNosotros />}  />
            <Route path="canal"             element={<LandingCanal />}     />
            <Route path="contenido"         element={<LandingContenido />} />
            <Route path="comunidad"         element={<LandingComunidad />} />
          </Route>
          <Route path="/login" element={<Login />} />
          <Route path="/studio/*" element={<RequireAuth><Shell /></RequireAuth>} />
        </Routes>
      </ConfirmProvider>
    </BrowserRouter>
  )
}

