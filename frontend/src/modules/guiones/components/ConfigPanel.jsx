import { useState, useEffect } from "react"
import { createPortal } from "react-dom"

function Slider({ label, value, onChange, min, max, step = 0.01, tooltip }) {
  return (
    <div className="field">
      <label title={tooltip}>{label}</label>
      <div className="slider-row">
        <input
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
        />
        <span className="slider-val">{value}</span>
      </div>
    </div>
  )
}

function NumInput({ label, value, onChange, min, max, step = 1 }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        value={value}
        min={min} max={max} step={step}
        onChange={e => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

function Toggle({ label, value, onChange }) {
  return (
    <div className="toggle-row" style={{ marginBottom: 12 }}>
      <span className="toggle-label">{label}</span>
      <label className="toggle">
        <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
        <span className="toggle-track" />
      </label>
    </div>
  )
}

function Section({ title, children, open, onToggle }) {
  return (
    <div className="config-section">
      <div className="config-section-header" onClick={onToggle}>
        <span className="config-section-title">{title}</span>
        <span className={`config-chevron ${open ? "open" : ""}`}>▼</span>
      </div>
      {open && <div className="config-section-body">{children}</div>}
    </div>
  )
}


/* ── Calibration modal ──────────────────────────────────────── */
const CALIB_LABELS = {
  break_coma:          "Pausa Coma",
  break_punto:         "Pausa Punto",
  break_suspensivos:   "Pausa …",
  break_dos_puntos:    "Pausa :",
  break_punto_coma:    "Pausa ;",
  break_exclamacion:   "Pausa !",
  break_interrogacion: "Pausa ?",
  break_guion:         "Pausa —",
  break_parrafo:       "Pausa Párrafo",
  intro_voice_speed:   "Velocidad Intro",
  medit_voice_speed:   "Velocidad Meditación",
  afirm_voice_speed:   "Velocidad Afirmaciones",
  intro_tempo_factor:  "Tempo Intro",
  medit_tempo_factor:  "Tempo Meditación",
  afirm_tempo_factor:  "Tempo Afirmaciones",
}

const SPEEDS_REFERENCIA = [0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.15, 1.20]

const SECCIONES = [
  { id: "intro",        label: "Intro",        desc: "Narración inicial, ritmo dinámico",    icon: "▶", color: "cyan"   },
  { id: "meditacion",   label: "Meditación",   desc: "Cuerpo central, ritmo pausado",        icon: "◈", color: "purple" },
  { id: "afirmaciones", label: "Afirmaciones", desc: "Cierre profundo, ritmo lento",         icon: "✦", color: "gold"   },
]

function CalibracionModal({ onClose, onApply, config = {} }) {
  const API = import.meta.env.VITE_API_URL

  const [estado, setEstado] = useState("seccion") // seccion | idle | analizando | listo | error
  const [seccion, setSeccion]               = useState(null)
  const [resultado, setResultado]           = useState(null)
  const [errorMsg, setErrorMsg]             = useState("")
  const [fileName, setFileName]             = useState("")
  const [seleccionados, setSeleccionados]   = useState({})

  // Estado de referencias de calibración
  const [refStatus, setRefStatus]   = useState(null)   // null | {calibrated, points_count, generated_at}
  const [generando, setGenerando]   = useState(false)
  const [genError, setGenError]     = useState("")

  const voiceOk = !!(config.voice_id && config.api_key)

  useEffect(() => {
    if (!voiceOk) return
    fetch(`${API}/api/calibrar-voz/referencias?voice_id=${encodeURIComponent(config.voice_id)}&model_id=${encodeURIComponent(config.model_id || "")}`)
      .then(r => r.json())
      .then(setRefStatus)
      .catch(() => {})
  }, [config.voice_id, config.model_id])

  const generarReferencias = async () => {
    setGenerando(true)
    setGenError("")
    try {
      const res = await fetch(`${API}/api/calibrar-voz/referencias`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key:       config.api_key,
          voice_id:      config.voice_id,
          model_id:      config.model_id      || "eleven_multilingual_v2",
          language_code: config.language_code || "es",
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || "Error al generar")
      setRefStatus({ calibrated: true, points_count: data.points.length, generated_at: new Date().toISOString() })
    } catch (err) {
      setGenError(err.message)
    }
    setGenerando(false)
  }

  const seleccionarSeccion = (id) => {
    setSeccion(id)
    setEstado("idle")
    setResultado(null)
    setErrorMsg("")
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 30 * 1024 * 1024) {
      setErrorMsg("El archivo supera el límite de 30 MB. Usa un audio más corto.")
      setEstado("error")
      return
    }
    setFileName(file.name)
    setEstado("analizando")
    setErrorMsg("")
    try {
      const audio_b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload  = () => resolve(reader.result.split(",")[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })

      const res = await fetch(`${API}/api/calibrar-voz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_b64,
          filename: file.name,
          seccion,
          voice_id: config.voice_id || "",
          model_id: config.model_id || "",
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || "Error al analizar")
      setResultado(data)
      const todos = {}
      Object.keys(data.sugerencias).forEach(k => { todos[k] = true })
      setSeleccionados(todos)
      setEstado("listo")
    } catch (err) {
      setErrorMsg(err.message)
      setEstado("error")
    }
  }

  const toggleKey = (k) => setSeleccionados(s => ({ ...s, [k]: !s[k] }))

  const aplicar = () => {
    const paramsAplicar = {}
    Object.entries(seleccionados).forEach(([k, v]) => {
      if (v && resultado?.sugerencias?.[k] !== undefined)
        paramsAplicar[k] = resultado.sugerencias[k]
    })
    onApply(paramsAplicar)
    onClose()
  }

  const seccionInfo = SECCIONES.find(s => s.id === seccion)
  const paso = estado === "seccion" ? 1 : estado === "listo" ? 3 : 2

  // Separar sugerencias en grupos para los resultados
  const speedTempoEntries = resultado ? Object.entries(resultado.sugerencias).filter(([k]) => k.includes("speed") || k.includes("tempo")) : []
  const breakEntries      = resultado ? Object.entries(resultado.sugerencias).filter(([k]) => k.includes("break")) : []

  return createPortal(
    <div className="calib-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="calib-modal">

        {/* ── Header ── */}
        <div className="calib-header">
          <div className="calib-header-left">
            <div className="calib-steps">
              {[1,2,3].map(n => (
                <span key={n} className={`calib-step ${n === paso ? "active" : n < paso ? "done" : ""}`}>{n < paso ? "✓" : n}</span>
              ))}
            </div>
            <div>
              <span className="calib-eyebrow">Asistente de calibración</span>
              <h3 className="calib-title">
                {seccionInfo ? `${seccionInfo.icon} ${seccionInfo.label}` : "Calibrar voz"}
              </h3>
            </div>
          </div>
          <button className="calib-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* ── Cuerpo scrollable ── */}
        <div className="calib-body">

          {/* ── Paso 1: elegir sección ── */}
          {estado === "seccion" && (
            <div className="calib-step-content">
              {voiceOk && (
                <div className={`calib-ref-bar ${refStatus?.calibrated ? "calib-ref-bar--ok" : "calib-ref-bar--warn"}`}>
                  {generando ? (
                    <><div className="calib-ref-spinner" /><span>Generando referencias… (~30 s)</span></>
                  ) : refStatus?.calibrated ? (
                    <>
                      <span className="calib-ref-icon">✓</span>
                      <span><strong>{refStatus.points_count} puntos</strong> — sincronización exacta</span>
                      <button className="calib-ref-btn" onClick={generarReferencias} style={{ marginLeft: "auto" }}>↺ Recalibrar</button>
                    </>
                  ) : refStatus?.needs_regen ? (
                    <>
                      <span className="calib-ref-icon">⚠</span>
                      <span>Referencias desactualizadas — regenerar para precisión exacta</span>
                      <button className="calib-ref-btn" onClick={generarReferencias}>↺ Actualizar</button>
                    </>
                  ) : (
                    <>
                      <span className="calib-ref-icon">⚠</span>
                      <span>Sin referencias — resultado aproximado</span>
                      <button className="calib-ref-btn" onClick={generarReferencias}>Generar</button>
                    </>
                  )}
                  {genError && <span className="calib-ref-error">{genError}</span>}
                </div>
              )}

              <p className="calib-pick-label">¿Qué sección quieres calibrar?</p>

              <div className="calib-section-grid">
                {SECCIONES.map(s => (
                  <button key={s.id} className={`calib-section-card calib-section-card--${s.color}`} onClick={() => seleccionarSeccion(s.id)}>
                    <span className="calib-section-icon">{s.icon}</span>
                    <span className="calib-section-name">{s.label}</span>
                    <span className="calib-section-desc">{s.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Paso 2: subir audio ── */}
          {(estado === "idle" || estado === "error") && (
            <div className="calib-step-content">
              <div className={`calib-sec-pill calib-sec-pill--${seccionInfo?.color}`}>
                <span>{seccionInfo?.icon}</span>
                <span>{seccionInfo?.label}</span>
                <button onClick={() => setEstado("seccion")}>Cambiar</button>
              </div>

              <div className="calib-dropzone">
                <div className="calib-dropzone-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                  </svg>
                </div>
                <p className="calib-dropzone-title">Sube un audio de <strong>{seccionInfo?.label}</strong></p>
                <p className="calib-dropzone-sub">El sistema detectará velocidad, tempo y patrones de silencio</p>
                <label className="calib-file-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
                  </svg>
                  Seleccionar archivo
                  <input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" onChange={handleFile} hidden />
                </label>
                <p className="calib-formats">MP3 · WAV · M4A · OGG · FLAC · AAC · máx. 30 MB</p>
                {estado === "error" && <p className="calib-error">{errorMsg}</p>}
              </div>
            </div>
          )}

          {/* ── Analizando ── */}
          {estado === "analizando" && (
            <div className="calib-loading">
              <div className="calib-loading-ring">
                <div className="calib-spinner" />
              </div>
              <p className="calib-loading-title">Analizando audio…</p>
              <p className="calib-loading-file">{fileName}</p>
            </div>
          )}

          {/* ── Paso 3: resultados ── */}
          {estado === "listo" && resultado && (
            <div className="calib-step-content">
              <div className={`calib-sec-pill calib-sec-pill--${seccionInfo?.color}`}>
                <span>{seccionInfo?.icon}</span>
                <span>Resultados — {seccionInfo?.label}</span>
                {resultado.analisis.calibrado
                  ? <span className="calib-precision-badge calib-precision-badge--ok">Exacto</span>
                  : <span className="calib-precision-badge calib-precision-badge--warn">~±10%</span>}
              </div>

              {/* Stats */}
              <div className="calib-stats">
                <div className="calib-stat">
                  <span>{resultado.analisis.duracion_s}s</span><span>Duración</span>
                </div>
                <div className="calib-stat">
                  <span>{Math.round(resultado.analisis.ratio_habla * 100)}%</span><span>Habla</span>
                </div>
                <div className="calib-stat">
                  <span>{resultado.analisis.silencios_detectados}</span><span>Silencios</span>
                </div>
                <div className="calib-stat">
                  <span>{resultado.analisis.sils_per_sec != null ? resultado.analisis.sils_per_sec : "—"}</span><span>Síls/seg</span>
                </div>
              </div>

              {/* Grupo: velocidad & tempo */}
              {speedTempoEntries.length > 0 && (
                <div className="calib-param-group">
                  <div className="calib-param-group-label">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                    Velocidad &amp; Tempo
                  </div>
                  {speedTempoEntries.map(([k, v]) => (
                    <label key={k} className={`calib-param-row ${seleccionados[k] ? "selected" : ""}`}>
                      <span className="calib-param-label">{CALIB_LABELS[k] ?? k}</span>
                      <span className="calib-param-val">{v}</span>
                      <input type="checkbox" className="calib-check" checked={!!seleccionados[k]} onChange={() => toggleKey(k)} />
                    </label>
                  ))}
                </div>
              )}

              {/* Grupo: pausas SSML */}
              {breakEntries.length > 0 && (
                <div className="calib-param-group">
                  <div className="calib-param-group-label">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="18"/></svg>
                    Pausas SSML
                  </div>
                  {breakEntries.map(([k, v]) => (
                    <label key={k} className={`calib-param-row ${seleccionados[k] ? "selected" : ""}`}>
                      <span className="calib-param-label">{CALIB_LABELS[k] ?? k}</span>
                      <span className="calib-param-val">{v}s</span>
                      <input type="checkbox" className="calib-check" checked={!!seleccionados[k]} onChange={() => toggleKey(k)} />
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Actions (solo en resultados) ── */}
        {estado === "listo" && resultado && (
          <div className="calib-actions">
            <button className="calib-btn-secondary" onClick={() => { setEstado("idle"); setResultado(null) }}>
              ↩ Otro audio
            </button>
            <button className="calib-btn-secondary" onClick={() => { setEstado("seccion"); setSeccion(null); setResultado(null) }}>
              ↩ Sección
            </button>
            <button className="calib-btn-primary" onClick={aplicar} disabled={!Object.values(seleccionados).some(Boolean)}>
              Aplicar ✓
            </button>
          </div>
        )}

      </div>
    </div>,
    document.body
  )
}

/* ═══════════════════════════════════════════════════════════ */

export default function ConfigPanel({ config, setConfig, userId }) {
  const set = (key, val) => setConfig(prev => ({ ...prev, [key]: val }))
  const setVS = (key, val) =>
    setConfig(prev => ({ ...prev, voice_settings: { ...prev.voice_settings, [key]: val } }))

  const [voices, setVoices] = useState([])
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [showCalib, setShowCalib] = useState(false)

  const [predefinedKeys, setPredefinedKeys]     = useState([])
  const [selectedKeyIndex, setSelectedKeyIndex] = useState(-1)
  const [accountInfo, setAccountInfo]           = useState(null)
  const [loadingAccount, setLoadingAccount]     = useState(false)

  const handleKeySelect = async (index, skipSave = false) => {
    setSelectedKeyIndex(index)
    if (index < 0) {
      if (userId) {
        fetch(`${import.meta.env.VITE_API_URL}/api/user-prefs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, key_index: -1 }),
        }).catch(() => {})
      }
      return
    }
    if (!skipSave && userId) {
      fetch(`${import.meta.env.VITE_API_URL}/api/user-prefs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, key_index: index }),
      }).catch(() => {})
    }
    setLoadingAccount(true)
    setAccountInfo(null)
    try {
      const res  = await fetch(`${import.meta.env.VITE_API_URL}/api/account-info?key_index=${index}`)
      const data = await res.json()
      setConfig(prev => ({ ...prev, api_key: data.api_key, voice_id: data.voice_id }))
      setAccountInfo(data)
    } catch {}
    setLoadingAccount(false)
  }

  useEffect(() => {
    const API = import.meta.env.VITE_API_URL
    fetch(`${API}/api/keys`)
      .then(r => r.json())
      .then(async keys => {
        setPredefinedKeys(keys)
        if (!userId) return
        const prefsRes = await fetch(`${API}/api/user-prefs?user_id=${encodeURIComponent(userId)}`)
        const prefs    = prefsRes.ok ? await prefsRes.json() : {}
        const idx      = typeof prefs.key_index === "number" ? prefs.key_index : -1
        if (idx >= 0 && idx < keys.length) {
          handleKeySelect(idx, true) // skipSave=true: ya está guardado en backend
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [openSections, setOpenSections] = useState(() => {
    try {
      const saved = sessionStorage.getItem("config_sections_open")
      return saved ? JSON.parse(saved) : {}
    } catch { return {} }
  })

  const toggleSection = (title) => {
    setOpenSections(prev => {
      const next = { ...prev, [title]: !prev[title] }
      sessionStorage.setItem("config_sections_open", JSON.stringify(next))
      return next
    })
  }

  const aplicarCalibracion = (params) => {
    setConfig(prev => ({ ...prev, ...params }))
  }

  const fetchVoices = async () => {
    if (!config.api_key) return
    setLoadingVoices(true)
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/voices?api_key=${config.api_key}`)
      const data = await res.json()
      setVoices(data)
    } catch {}
    setLoadingVoices(false)
  }

  return (
    <div className="card fade-up" style={{ animationDelay: "0.08s" }}>
      {showCalib && (
        <CalibracionModal
          onClose={() => setShowCalib(false)}
          onApply={aplicarCalibracion}
          config={config}
        />
      )}

      <div className="card-header">
        <div>
          <div className="card-title">Configuración </div>
          <div className="card-subtitle">ElevenLabs + Audio</div>
        </div>
        <button className="calib-trigger-btn" onClick={() => setShowCalib(true)} title="Calibrar parámetros desde un audio de referencia">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>
          </svg>
          Calibrar voz
        </button>
      </div>

      <Section title="API & Voz" open={openSections["API & Voz"]} onToggle={() => toggleSection("API & Voz")}>
        <div className="field" style={{ marginTop: 6 }}>
          <label>Cuenta ElevenLabs</label>
          <select
            value={selectedKeyIndex}
            onChange={e => handleKeySelect(Number(e.target.value))}
          >
            <option value={-1}>— Seleccionar cuenta —</option>
            {predefinedKeys.map(k => (
              <option key={k.index} value={k.index}>{k.name}</option>
            ))}
          </select>
        </div>

        {loadingAccount && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            Cargando info de cuenta...
          </div>
        )}

        {accountInfo && !loadingAccount && (() => {
          const usado    = accountInfo.character_count
          const limite   = accountInfo.character_limit
          const pct      = limite > 0 ? usado / limite : 0
          const agotado  = limite > 0 && usado >= limite
          const critico  = !agotado && pct >= 0.85
          const dotColor = agotado ? "#e05252" : critico ? "#f0a020" : "#3ecf6e"
          const barColor = agotado ? "#e05252" : critico ? "#f0a020" : "var(--accent, #7c6af7)"

          return (
            <div style={{
              background: agotado ? "rgba(224,82,82,0.07)" : critico ? "rgba(240,160,32,0.07)" : "var(--bg-secondary, #1a1a2e)",
              border: `1px solid ${agotado ? "rgba(224,82,82,0.4)" : critico ? "rgba(240,160,32,0.35)" : "var(--border-color, #2a2a3e)"}`,
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 10,
              fontSize: 12,
            }}>
              {/* Nombre de cuenta */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                marginBottom: 10, paddingBottom: 8,
                borderBottom: `1px solid ${agotado ? "rgba(224,82,82,0.25)" : critico ? "rgba(240,160,32,0.2)" : "var(--border-color, #2a2a3e)"}`,
              }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, fontSize: 13 }}>{accountInfo.name}</span>
              </div>

              {/* Banner de advertencia */}
              {agotado && (
                <div style={{
                  background: "rgba(224,82,82,0.15)", border: "1px solid rgba(224,82,82,0.4)",
                  borderRadius: 6, padding: "7px 10px", marginBottom: 10,
                  color: "#e05252", fontWeight: 600, fontSize: 12,
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <span style={{ fontSize: 14 }}>⚠</span>
                  Créditos agotados — cambia a otra cuenta antes de generar
                </div>
              )}
              {critico && (
                <div style={{
                  background: "rgba(240,160,32,0.12)", border: "1px solid rgba(240,160,32,0.35)",
                  borderRadius: 6, padding: "7px 10px", marginBottom: 10,
                  color: "#f0a020", fontWeight: 600, fontSize: 12,
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <span style={{ fontSize: 14 }}>⚠</span>
                  Pocos créditos restantes
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: "var(--text-muted)" }}>Plan</span>
                <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{accountInfo.tier || "—"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: "var(--text-muted)" }}>Caracteres usados</span>
                <span style={{ fontWeight: 600, color: agotado ? "#e05252" : critico ? "#f0a020" : "inherit" }}>
                  {usado.toLocaleString()} / {limite.toLocaleString()}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 4, background: "var(--border-color, #2a2a3e)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 4,
                  width: `${Math.min(100, Math.round(pct * 100))}%`,
                  background: barColor,
                  transition: "width 0.4s ease",
                }} />
              </div>
              <div style={{ textAlign: "right", marginTop: 4, fontSize: 11, color: agotado ? "#e05252" : critico ? "#f0a020" : "var(--text-muted)" }}>
                {(limite - usado).toLocaleString()} restantes
              </div>
            </div>
          )
        })()}

        <div className="field">
          <label>Modelo</label>
          <select value={config.model_id} onChange={e => set("model_id", e.target.value)}>
            <option value="eleven_multilingual_v2">Multilingual v2</option>
            <option value="eleven_turbo_v2_5">Turbo v2.5 (rápido)</option>
            <option value="eleven_flash_v2_5">Flash v2.5</option>
          </select>
        </div>

        <div className="field">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <label style={{ margin: 0 }}>Voice ID</label>
            <button
              className="btn btn-ghost btn-sm"
              onClick={fetchVoices}
              disabled={loadingVoices || !config.api_key}
            >
              {loadingVoices ? "Cargando..." : "Cargar voces"}
            </button>
          </div>
          {voices.length > 0 ? (
            <select value={config.voice_id} onChange={e => set("voice_id", e.target.value)}>
              {voices.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={config.voice_id}
              onChange={e => set("voice_id", e.target.value)}
              placeholder="voice ID o carga desde API"
            />
          )}
        </div>

        <div className="field">
          <label>Idioma</label>
          <select value={config.language_code} onChange={e => set("language_code", e.target.value)}>
            <option value="es">Español (es)</option>
            <option value="en">English (en)</option>
            <option value="pt">Português (pt)</option>
            <option value="fr">Français (fr)</option>
          </select>
        </div>

        <div className="field">
          <label>Output Format (ElevenLabs)</label>
          <select value={config.output_format || "mp3_44100_128"} onChange={e => set("output_format", e.target.value)}>
            <optgroup label="MP3">
              <option value="mp3_44100_32">MP3 · 32 kbps (ligero)</option>
              <option value="mp3_44100_128">MP3 · 128 kbps (recomendado)</option>
              <option value="mp3_44100_192">MP3 · 192 kbps (alta calidad)</option>
            </optgroup>
            <optgroup label="PCM / WAV (Lossless)">
              <option value="pcm_24000">PCM · 24 kHz</option>
              <option value="pcm_44100">PCM · 44 kHz (CD quality)</option>
            </optgroup>
          </select>
        </div>
      </Section>

      <Section title="Parámetros de Voz" open={openSections["Parámetros de Voz"]} onToggle={() => toggleSection("Parámetros de Voz")}>
        <div style={{ marginTop: 6 }}>
          <Slider label="Estabilidad" value={config.voice_settings.stability}
            onChange={v => setVS("stability", v)} min={0} max={1}
            tooltip="Mayor = más consistente, menor = más expresiva" />
          <Slider label="Similarity Boost" value={config.voice_settings.similarity_boost}
            onChange={v => setVS("similarity_boost", v)} min={0} max={1} />
          <Slider label="Style" value={config.voice_settings.style}
            onChange={v => setVS("style", v)} min={0} max={1} />
          <Toggle label="Speaker Boost" value={config.voice_settings.use_speaker_boost}
            onChange={v => setVS("use_speaker_boost", v)} />
        </div>
      </Section>

      <Section title="Intro — Velocidad & Tempo" open={openSections["Intro — Velocidad & Tempo"]} onToggle={() => toggleSection("Intro — Velocidad & Tempo")}>
        <div style={{ marginTop: 6 }}>
          <Slider label="Voice Speed (ElevenLabs)" value={config.intro_voice_speed}
            onChange={v => set("intro_voice_speed", v)} min={0.7} max={1.3} step={0.01}
            tooltip="Velocidad enviada a la API" />
          <Slider label="Tempo Factor (post-proceso)" value={config.intro_tempo_factor}
            onChange={v => set("intro_tempo_factor", v)} min={0.6} max={1.3} step={0.01}
            tooltip="Time-stretching con ffmpeg. 1.0 = sin cambio" />
        </div>
      </Section>

      <Section title="Meditación — Velocidad & Tempo" open={openSections["Meditación — Velocidad & Tempo"]} onToggle={() => toggleSection("Meditación — Velocidad & Tempo")}>
        <div style={{ marginTop: 6 }}>
          <Slider label="Voice Speed (ElevenLabs)" value={config.medit_voice_speed}
            onChange={v => set("medit_voice_speed", v)} min={0.7} max={1.3} step={0.01}
            tooltip="Velocidad enviada a la API para la sección de meditación" />
          <Slider label="Tempo Factor (post-proceso)" value={config.medit_tempo_factor}
            onChange={v => set("medit_tempo_factor", v)} min={0.6} max={1.3} step={0.01}
            tooltip="Time-stretching con ffmpeg para la meditación" />
        </div>
      </Section>
      <Section title="Afirmaciones — Velocidad & Tempo" open={openSections["Afirmaciones — Velocidad & Tempo"]} onToggle={() => toggleSection("Afirmaciones — Velocidad & Tempo")}>
        <div style={{ marginTop: 6 }}>
          <Slider label="Voice Speed (ElevenLabs)" value={config.afirm_voice_speed}
            onChange={v => set("afirm_voice_speed", v)} min={0.7} max={1.3} step={0.01} />
          <Slider label="Tempo Factor (post-proceso)" value={config.afirm_tempo_factor}
            onChange={v => set("afirm_tempo_factor", v)} min={0.6} max={1.3} step={0.01} />
        </div>
      </Section>


      <Section title="Silencios (ms)" open={openSections["Silencios (ms)"]} onToggle={() => toggleSection("Silencios (ms)")}>
        <div style={{ marginTop: 6 }}>
          <div className="field-row">
            <NumInput label="Entre oraciones" value={config.pausa_entre_oraciones}
              onChange={v => set("pausa_entre_oraciones", v)} min={0} max={5000} step={100} />
            <NumInput label="Intro → Afirm" value={config.pausa_intro_a_afirm}
              onChange={v => set("pausa_intro_a_afirm", v)} min={0} max={10000} step={500} />
          </div>
          <div className="field-row">
            <NumInput label="Entre afirmaciones (ms)" value={config.pausa_entre_afirmaciones}
              onChange={v => set("pausa_entre_afirmaciones", v)} min={1000} max={30000} step={500} />
            <NumInput label="Afirm → Meditación" value={config.pausa_afirm_a_medit}
              onChange={v => set("pausa_afirm_a_medit", v)} min={0} max={10000} step={500} />
          </div>
          <NumInput label="Entre segmentos meditación (ms)" value={config.pausa_entre_meditaciones}
            onChange={v => set("pausa_entre_meditaciones", v)} min={500} max={30000} step={500} />
        </div>
      </Section>

      <Section title="Pausas SSML" open={openSections["Pausas SSML"]} onToggle={() => toggleSection("Pausas SSML")}>
        <div style={{ marginTop: 6 }}>
          <Toggle label="Insertar breaks por puntuación" value={config.usar_ssml_breaks}
            onChange={v => set("usar_ssml_breaks", v)} />
          {config.usar_ssml_breaks && (
            <>
              <Slider label="Coma , (s)" value={config.break_coma}
                onChange={v => set("break_coma", v)} min={0} max={3} step={0.05} />
              <Slider label="Punto . (s)" value={config.break_punto}
                onChange={v => set("break_punto", v)} min={0} max={3} step={0.05} />
              <Slider label="Puntos suspensivos … (s)" value={config.break_suspensivos}
                onChange={v => set("break_suspensivos", v)} min={0} max={3} step={0.05} />
              <Slider label="Dos puntos : (s)" value={config.break_dos_puntos}
                onChange={v => set("break_dos_puntos", v)} min={0} max={3} step={0.05} />
              <Slider label="Punto y coma ; (s)" value={config.break_punto_coma}
                onChange={v => set("break_punto_coma", v)} min={0} max={3} step={0.05} />
              <Slider label="Guión largo — (s)" value={config.break_guion}
                onChange={v => set("break_guion", v)} min={0} max={3} step={0.05} />
              <Slider label="Exclamación ! (s)" value={config.break_exclamacion}
                onChange={v => set("break_exclamacion", v)} min={0} max={3} step={0.05} />
              <Slider label="Interrogación ? (s)" value={config.break_interrogacion}
                onChange={v => set("break_interrogacion", v)} min={0} max={3} step={0.05} />
              <Slider label="Salto de párrafo (s)" value={config.break_parrafo}
                onChange={v => set("break_parrafo", v)} min={0} max={5} step={0.1} />
            </>
          )}
        </div>
      </Section>

      <Section title="Silencios Internos" open={openSections["Silencios Internos"]} onToggle={() => toggleSection("Silencios Internos")}>
        <div style={{ marginTop: 6 }}>
          <Toggle label="Extender silencios internos" value={config.extend_silence}
            onChange={v => set("extend_silence", v)} />
          {config.extend_silence && (
            <>
              <Slider label="Factor coma (< 400ms)" value={config.factor_coma}
                onChange={v => set("factor_coma", v)} min={0.5} max={3} step={0.1} />
              <Slider label="Factor punto (400–900ms)" value={config.factor_punto}
                onChange={v => set("factor_punto", v)} min={0.5} max={3} step={0.1} />
              <Slider label="Factor suspensivos (> 900ms)" value={config.factor_suspensivos}
                onChange={v => set("factor_suspensivos", v)} min={0.5} max={3} step={0.1} />
            </>
          )}
        </div>
      </Section>

      <Section title="Avanzado" open={openSections["Avanzado"]} onToggle={() => toggleSection("Avanzado")}>
        <div style={{ marginTop: 6 }}>
          <NumInput label="Máx. caracteres por párrafo" value={config.max_chars_parrafo}
            onChange={v => set("max_chars_parrafo", v)} min={220} max={800} />
          <NumInput label="Mín. caracteres por bloque" value={config.min_chars_parrafo ?? 220}
            onChange={v => set("min_chars_parrafo", v)} min={0} max={500} />
          <NumInput label="Umbral silencio (dBFS)" value={config.silence_thresh_db}
            onChange={v => set("silence_thresh_db", v)} min={-80} max={-10} />
          <NumInput label="Silencio mínimo (ms)" value={config.silence_min_ms}
            onChange={v => set("silence_min_ms", v)} min={20} max={500} />
        </div>
      </Section>

      <div style={{ padding: "12px 22px", borderTop: "1px solid var(--border)" }}>
        <div className="text-xs text-muted">
          La config se guarda automáticamente en el navegador
        </div>
      </div>
    </div>
  )
}
