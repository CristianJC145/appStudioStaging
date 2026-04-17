import { useState, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useConfirm } from "../../../components/ConfirmModal"

// ─── Design tokens ────────────────────────────────────────────
const UMBRAL_META = {
  sin_datos: { label: "Aprendiendo", color: "#4a6a7a" },
  aceptable: { label: "Copiloto",    color: "#4ab8d4" },
  bueno:     { label: "Semi-auto",   color: "#f0c040" },
  excelente: { label: "Autónomo",    color: "#2dbe60" },
  pro:       { label: "Pro",         color: "#a8e8f5" },
}
const UMBRAL_ORDER = ["pro", "excelente", "bueno", "aceptable", "sin_datos"]
const SEG_ENTRIES = [
  { key: "intro",        label: "Intro" },
  { key: "afirmaciones", label: "Afirmaciones" },
  { key: "meditacion",   label: "Meditación"  },
]
const LANGUAGES = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
  { value: "fr", label: "Français" },
]

const INFO_PHASES = [
  {
    key: "sin_datos",
    color: "#4a6a7a",
    name: "Aprendiendo",
    desc: "Sin ejemplos aún. El clasificador observa tus decisiones para empezar a aprender.",
  },
  {
    key: "aceptable",
    color: "#4ab8d4",
    name: "Copiloto",
    desc: "Aprende de tus aprobaciones y rechazos. Sugiere decisiones con confianza básica.",
  },
  {
    key: "bueno",
    color: "#f0c040",
    name: "Semi-auto",
    desc: "Confianza ≥ 70 %. Sugiere con precisión mejorada para agilizar la revisión.",
  },
  {
    key: "excelente",
    color: "#2dbe60",
    name: "Autónomo",
    desc: "Puede aprobar automáticamente audios con confianza ≥ 85 %. Activa el toggle Auto.",
  },
  {
    key: "pro",
    color: "#a8e8f5",
    name: "Pro",
    desc: "Nivel máximo. Precisión óptima y aprobaciones automáticas con la mayor fiabilidad.",
  },
]

// ─── Helpers ──────────────────────────────────────────────────
function bestUmbral(status) {
  if (!status) return "sin_datos"
  const all = Object.values(status).map(s => s?.umbral ?? "sin_datos")
  return UMBRAL_ORDER.find(u => all.includes(u)) ?? "sin_datos"
}

// ─── Icons ────────────────────────────────────────────────────
function AiIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5"  cy="8"  r="1.4" />
      <circle cx="19" cy="8"  r="1.4" />
      <circle cx="5"  cy="16" r="1.4" />
      <circle cx="19" cy="16" r="1.4" />
      <line x1="6.3"  y1="8.8"  x2="9.8"  y2="11.1" />
      <line x1="17.7" y1="8.8"  x2="14.2" y2="11.1" />
      <line x1="6.3"  y1="15.2" x2="9.8"  y2="12.9" />
      <line x1="17.7" y1="15.2" x2="14.2" y2="12.9" />
    </svg>
  )
}

function ResetIcon({ size = 10 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────
export default function ClassifierDropdown({
  status,
  autonomousMode,
  onAutonomousChange,
  classifierLanguage,
  onLanguageChange,
  onResetSegment,
}) {
  const confirm                 = useConfirm()
  const [open, setOpen]         = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const panelRef                = useRef(null)
  const fabRef                  = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (
        !panelRef.current?.contains(e.target) &&
        !fabRef.current?.contains(e.target)
      ) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  const best          = bestUmbral(status)
  const accent        = UMBRAL_META[best].color
  const totalExamples = status
    ? Object.values(status).reduce((s, v) => s + (v?.ejemplos ?? 0), 0)
    : 0
  const anyAutoActive = autonomousMode && Object.values(autonomousMode).some(Boolean)

  const handleReset = async (key, label) => {
    const ok = await confirm({
      title:        `Resetear aprendizaje — ${label}`,
      description:  `Se eliminarán todos los ejemplos de entrenamiento y el resumen generado para el segmento "${label}". Esta acción no se puede deshacer.`,
      variant:      "danger",
      confirmLabel: "Sí, resetear",
    })
    if (ok) onResetSegment?.(key)
  }

  return createPortal(
    <div className="clf-fab-root">

      {/* ── Floating panel ───────────────────────── */}
      <div
        ref={panelRef}
        className={`clf-fab-panel ${open ? "clf-fab-panel--open" : ""}`}
        role="dialog"
        aria-modal="false"
        aria-label="Estado del Clasificador IA"
      >
        {/* Header */}
        <div className="clf-fab-header">
          <span className="clf-fab-header-icon" style={{ color: accent }}>
            <AiIcon size={14} />
          </span>
          <div className="clf-fab-header-text">
            <span className="clf-fab-header-title">Clasificador IA</span>
            <span className="clf-fab-header-sub">Aprendizaje progresivo</span>
          </div>
          <div className="clf-fab-header-right">
            {totalExamples > 0 && (
              <span className="clf-fab-header-badge">{totalExamples} ej.</span>
            )}
            <select
              className="clf-lang-select"
              value={classifierLanguage || "es"}
              onChange={e => onLanguageChange?.(e.target.value)}
              onClick={e => e.stopPropagation()}
              title="Idioma del clasificador"
            >
              {LANGUAGES.map(l => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
            <button
              className={`clf-info-btn ${showInfo ? "clf-info-btn--active" : ""}`}
              onClick={() => setShowInfo(v => !v)}
              title="Cómo funciona el clasificador"
              aria-label="Información del clasificador"
              aria-pressed={showInfo}
            >
              i
            </button>
          </div>
        </div>

        <div className="clf-fab-divider" />

        {/* Info panel */}
        <div className={`clf-info-panel ${showInfo ? "clf-info-panel--open" : ""}`}>
          <div className="clf-info-inner">
            {INFO_PHASES.map(p => (
              <div key={p.key} className="clf-info-phase">
                <span className="clf-info-dot" style={{ background: p.color }} />
                <div className="clf-info-phase-text">
                  <span className="clf-info-phase-name" style={{ color: p.color }}>{p.name}</span>
                  <span className="clf-info-phase-desc">{p.desc}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="clf-fab-divider" />
        </div>

        {/* Segments */}
        <div className="clf-fab-segs">
          {SEG_ENTRIES.map(({ key, label }) => {
            const info    = status?.[key]
            const n       = info?.ejemplos        ?? 0
            const umbral  = info?.umbral          ?? "sin_datos"
            const sig     = info?.siguiente_umbral ?? {}
            const pct     = sig.total
              ? Math.min(100, (n / sig.total) * 100)
              : umbral === "pro" ? 100 : 0
            const meta    = UMBRAL_META[umbral]
            const canAuto = umbral === "excelente" || umbral === "pro"
            const isAuto  = autonomousMode?.[key] ?? false

            return (
              <div key={key} className="clf-fab-seg">

                {/* ── Fila 1: nombre · nivel · conteo ── */}
                <div className="clf-fab-seg-row">
                  <div className="clf-fab-seg-left">
                    <span className="clf-fab-seg-dot" style={{ background: meta.color }} />
                    <span className="clf-fab-seg-name">{label}</span>
                  </div>
                  <div className="clf-fab-seg-right">
                    <span
                      className="clf-fab-seg-level"
                      style={{
                        color: meta.color,
                        borderColor: meta.color + "30",
                        background:  meta.color + "12",
                      }}
                    >
                      {meta.label}
                    </span>
                    <span className="clf-fab-seg-count">
                      {n}{sig.total ? `/${sig.total}` : ""}
                    </span>
                  </div>
                </div>

                {/* ── Barra de progreso ── */}
                <div className="clf-fab-seg-track">
                  <div
                    className="clf-fab-seg-fill"
                    style={{ width: `${pct}%`, background: meta.color }}
                  />
                </div>

                {/* ── Fila 2: acciones ── */}
                <div className="clf-fab-seg-actions">
                  <button
                    className="clf-reset-btn"
                    onClick={() => handleReset(key, label)}
                    title={`Limpiar aprendizaje de ${label}`}
                    aria-label={`Resetear ${label}`}
                  >
                    <ResetIcon size={9} />
                    <span>Resetear</span>
                  </button>

                  {canAuto && (
                    <button
                      className={`clf-toggle ${isAuto ? "clf-toggle--on" : ""}`}
                      onClick={() => onAutonomousChange?.(key, !isAuto)}
                      title="Auto-aprobar audios con confianza ≥ 85%"
                      aria-pressed={isAuto}
                    >
                      <span className="clf-auto-label">{isAuto ? "Auto on" : "Auto"}</span>
                      <span className="clf-toggle-track">
                        <span className="clf-toggle-knob" />
                      </span>
                    </button>
                  )}
                </div>

              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="clf-fab-footer">
          Aprende de tus decisiones para automatizar progresivamente las aprobaciones.
        </div>
      </div>

      {/* ── FAB circle ───────────────────────────── */}
      <button
        ref={fabRef}
        className={`clf-fab ${open ? "clf-fab--active" : ""} ${anyAutoActive ? "clf-fab--auto-on" : ""}`}
        style={{ color: accent }}
        onClick={() => setOpen(o => !o)}
        aria-label={open ? "Cerrar clasificador" : "Ver estado del Clasificador IA"}
        aria-expanded={open}
      >
        <AiIcon size={17} />
        <span className="clf-fab-dot" style={{ background: accent }} />
      </button>

    </div>,
    document.body
  )
}
