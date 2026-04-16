import { useState, useEffect, useRef } from "react"
import { createPortal } from "react-dom"

// ─── Design tokens (match app palette) ───────────────────────
const UMBRAL_META = {
  sin_datos: { label: "Aprendiendo", color: "#4a6a7a" },
  aceptable: { label: "Copiloto",    color: "#4ab8d4" },
  bueno:     { label: "Semi-auto",   color: "#f0c040" },
  excelente: { label: "Autónomo",    color: "#2dbe60" },
  pro:       { label: "Pro",         color: "#a8e8f5" },
}
const UMBRAL_ORDER  = ["pro", "excelente", "bueno", "aceptable", "sin_datos"]
const SEG_ENTRIES = [
  { key: "intro",        label: "Intro" },
  { key: "afirmaciones", label: "Afirmaciones" },
  { key: "meditacion",   label: "Meditación"  },
]

// ─── Helpers ──────────────────────────────────────────────────
function bestUmbral(status) {
  if (!status) return "sin_datos"
  const all = Object.values(status).map(s => s?.umbral ?? "sin_datos")
  return UMBRAL_ORDER.find(u => all.includes(u)) ?? "sin_datos"
}

// ─── Neural-network SVG icon ──────────────────────────────────
function AiIcon({ size = 18 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Central node */}
      <circle cx="12" cy="12" r="2.5" />
      {/* Outer nodes */}
      <circle cx="5"  cy="8"  r="1.4" />
      <circle cx="19" cy="8"  r="1.4" />
      <circle cx="5"  cy="16" r="1.4" />
      <circle cx="19" cy="16" r="1.4" />
      {/* Connections */}
      <line x1="6.3"  y1="8.8"  x2="9.8"  y2="11.1" />
      <line x1="17.7" y1="8.8"  x2="14.2" y2="11.1" />
      <line x1="6.3"  y1="15.2" x2="9.8"  y2="12.9" />
      <line x1="17.7" y1="15.2" x2="14.2" y2="12.9" />
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────
export default function ClassifierDropdown({ status, autonomousMode, onAutonomousChange }) {
  const [open, setOpen]   = useState(false)
  const panelRef          = useRef(null)
  const fabRef            = useRef(null)

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
          {totalExamples > 0 && (
            <span className="clf-fab-header-badge">
              {totalExamples} ej.
            </span>
          )}
        </div>

        <div className="clf-fab-divider" />

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
                <div className="clf-fab-seg-row">
                  {/* Left: dot + name + level */}
                  <div className="clf-fab-seg-left">
                    <span
                      className="clf-fab-seg-dot"
                      style={{ background: meta.color }}
                    />
                    <span className="clf-fab-seg-name">{label}</span>
                    <span
                      className="clf-fab-seg-level"
                      style={{ color: meta.color }}
                    >
                      {meta.label}
                    </span>
                  </div>

                  {/* Right: count + auto toggle */}
                  <div className="clf-fab-seg-right">
                    <span className="clf-fab-seg-count">
                      {n}{sig.total ? `/${sig.total}` : ""}
                    </span>
                    {canAuto && (
                      <label
                        className="clf-auto-toggle"
                        title="Auto-aprobar audios con confianza ≥ 85%"
                      >
                        <input
                          type="checkbox"
                          checked={isAuto}
                          onChange={e => onAutonomousChange?.(key, e.target.checked)}
                        />
                        <span className="clf-auto-label">Auto</span>
                      </label>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                <div className="clf-fab-seg-track">
                  <div
                    className="clf-fab-seg-fill"
                    style={{ width: `${pct}%`, background: meta.color }}
                  />
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
        className={`clf-fab ${open ? "clf-fab--active" : ""}`}
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
