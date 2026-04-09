import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import logoImg from "../assets/logo.png"
import "./Login.css"

/* ── Icons ──────────────────────────────────────────────────────────── */
const IconUser = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
  </svg>
)
const IconMail = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/>
  </svg>
)
const IconLock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
)
const IconEye = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>
  </svg>
)
const IconEyeOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
)
const IconAlert = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
)

const API = import.meta.env.VITE_API_URL || "http://localhost:8000"
const WAVE_HEIGHTS = [8, 14, 20, 16, 24, 18, 12, 22, 10]

export default function Login() {
  const navigate = useNavigate()
  const [tab, setTab]         = useState("login")   // "login" | "register"
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState("")
  const [showPw, setShowPw]   = useState(false)

  const [form, setForm] = useState({ username: "", email: "", password: "" })

  useEffect(() => {
    document.body.classList.add("login-body")
    // If already logged in, redirect
    const token = localStorage.getItem("studio_token")
    if (token) navigate("/studio", { replace: true })
    return () => document.body.classList.remove("login-body")
  }, [navigate])

  const set = (key) => (e) => {
    setForm(f => ({ ...f, [key]: e.target.value }))
    setError("")
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const endpoint = tab === "login" ? "/api/auth/login" : "/api/auth/register"
      const body = tab === "login"
        ? { username: form.username, password: form.password }
        : { username: form.username, email: form.email, password: form.password }

      const res = await fetch(`${API}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.detail || "Error de autenticación")
        return
      }
      localStorage.setItem("studio_token", data.access_token)
      localStorage.setItem("studio_user", JSON.stringify(data.user))
      navigate("/studio", { replace: true })
    } catch {
      setError("No se pudo conectar con el servidor")
    } finally {
      setLoading(false)
    }
  }

  const switchTab = (t) => {
    setTab(t); setError("")
    setForm({ username: "", email: "", password: "" })
  }

  return (
    <>
      {/* Background */}
      <div className="lg-bg" aria-hidden="true">
        <div className="lg-orb lg-orb-1" />
        <div className="lg-orb lg-orb-2" />
        <div className="lg-orb lg-orb-3" />
        <div className="lg-grid" />
        <div className="lg-noise" />
      </div>

      <div className="lg-wrap">
        <div className="lg-card">

          {/* Header */}
          <div className="lg-header">
            <div className="lg-logo-wrap">
              <div className="lg-logo-glow" />
              <img src={logoImg} className="lg-logo" alt="Studio Logo" />
            </div>
            <div className="lg-brand">
              <span className="lg-brand-name">Ingeniería de la Manifestación</span>
              <span className="lg-brand-title">Test <span>Studio</span></span>
              <span className="lg-brand-sub">
                {tab === "login" ? "Bienvenido de vuelta" : "Crea tu cuenta"}
              </span>
            </div>
          </div>

          {/* Tab switcher */}
          <div className="lg-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "login"}
              className={`lg-tab${tab === "login" ? " active" : ""}`}
              onClick={() => switchTab("login")}
            >
              Iniciar sesión
            </button>
            <button
              role="tab"
              aria-selected={tab === "register"}
              className={`lg-tab${tab === "register" ? " active" : ""}`}
              onClick={() => switchTab("register")}
            >
              Registrarse
            </button>
          </div>

          {/* Form */}
          <form className="lg-form" onSubmit={handleSubmit} noValidate>
            {/* Username */}
            <div className="lg-field">
              <label className="lg-label" htmlFor="lg-username">Usuario</label>
              <div className={`lg-input-wrap${error ? " error" : ""}`}>
                <span className="lg-input-icon"><IconUser /></span>
                <input
                  id="lg-username"
                  type="text"
                  className="lg-input"
                  placeholder="tu_usuario"
                  value={form.username}
                  onChange={set("username")}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>
            </div>

            {/* Email (register only) */}
            {tab === "register" && (
              <div className="lg-field">
                <label className="lg-label" htmlFor="lg-email">Correo electrónico</label>
                <div className={`lg-input-wrap${error ? " error" : ""}`}>
                  <span className="lg-input-icon"><IconMail /></span>
                  <input
                    id="lg-email"
                    type="email"
                    className="lg-input"
                    placeholder="correo@ejemplo.com"
                    value={form.email}
                    onChange={set("email")}
                    autoComplete="email"
                    required
                  />
                </div>
              </div>
            )}

            {/* Password */}
            <div className="lg-field">
              <label className="lg-label" htmlFor="lg-password">Contraseña</label>
              <div className={`lg-input-wrap${error ? " error" : ""}`}>
                <span className="lg-input-icon"><IconLock /></span>
                <input
                  id="lg-password"
                  type={showPw ? "text" : "password"}
                  className="lg-input"
                  placeholder={tab === "register" ? "Mínimo 6 caracteres" : "••••••••"}
                  value={form.password}
                  onChange={set("password")}
                  autoComplete={tab === "login" ? "current-password" : "new-password"}
                  required
                />
                <button
                  type="button"
                  className="lg-pw-toggle"
                  onClick={() => setShowPw(p => !p)}
                  aria-label={showPw ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  {showPw ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="lg-error" role="alert">
                <IconAlert /> {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              className="lg-btn"
              disabled={loading || !form.username || !form.password || (tab === "register" && !form.email)}
            >
              <span className="lg-btn-content">
                {loading && <span className="lg-spinner" />}
                {loading
                  ? (tab === "login" ? "Entrando…" : "Creando cuenta…")
                  : (tab === "login" ? "Entrar al Studio" : "Crear cuenta")
                }
              </span>
            </button>
          </form>

          {/* Decorative wave */}
          <div className="lg-wave" aria-hidden="true">
            {WAVE_HEIGHTS.map((h, i) => (
              <span key={i} className="lg-wave-bar" style={{ height: `${h}px` }} />
            ))}
          </div>

          {/* Footer */}
          <p className="lg-footer">
            Powered by <span>Ingeniería de la Manifestación</span> — v3.0
          </p>
        </div>
      </div>
    </>
  )
}
