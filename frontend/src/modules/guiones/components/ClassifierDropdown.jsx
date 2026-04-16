import { useState } from "react"

// ─── Umbral metadata ──────────────────────────────────────────
const UMBRAL_LABELS = {
  sin_datos: "Aprendiendo",
  aceptable: "Copiloto",
  bueno:     "Semi-auto",
  excelente: "Autónomo",
  pro:       "Pro",
}
const UMBRAL_COLORS = {
  sin_datos: "var(--tx3)",
  aceptable: "var(--aurora)",
  bueno:     "#f0c040",
  excelente: "var(--green)",
  pro:       "var(--gold3)",
}
const SEG_ENTRIES = [
  { key: "intro",        label: "Intro",         short: "Intro" },
  { key: "afirmaciones", label: "Afirmaciones",  short: "Afirm" },
  { key: "meditacion",   label: "Meditación",    short: "Medit" },
]
const UMBRAL_ORDER = ["pro", "excelente", "bueno", "aceptable", "sin_datos"]

// ─── Helpers ──────────────────────────────────────────────────
function bestUmbral(status) {
  if (!status) return "sin_datos"
  const all = Object.values(status).map(s => s?.umbral ?? "sin_datos")
  for (const u of UMBRAL_ORDER) {
    if (all.includes(u)) return u
  }
  return "sin_datos"
}

// ─── Component ────────────────────────────────────────────────
export default function ClassifierDropdown({ status, autonomousMode, onAutonomousChange }) {
  const [open, setOpen] = useState(false)

  const best        = bestUmbral(status)
  const accentColor = UMBRAL_COLORS[best]

  // Total examples across all segments
  const totalExamples = status
    ? Object.values(status).reduce((acc, s) => acc + (s?.ejemplos ?? 0), 0)
    : 0

  return (
    <div className="clf-dropdown">

      {/* ── Trigger bar ─────────────────────────────────── */}
      <button
        className={`clf-trigger ${open ? "clf-trigger--open" : ""}`}
        onClick={() => setOpen(o => !o)}
        title="Clasificador IA — historial de aprendizaje"
      >
        <span className="clf-trigger-icon" style={{ color: accentColor }}>◈</span>
        <span className="clf-trigger-title">Clasificador IA</span>

        {/* Segment mini-pills */}
        <div className="clf-trigger-pills">
          {SEG_ENTRIES.map(({ key, short }) => {
            const umbral = status?.[key]?.umbral ?? "sin_datos"
            const color  = UMBRAL_COLORS[umbral]
            return (
              <span key={key} className="clf-pill">
                <span className="clf-pill-seg">{short}</span>
                <span className="clf-pill-val" style={{ color }}>{UMBRAL_LABELS[umbral]}</span>
              </span>
            )
          })}
        </div>

        {/* Total counter */}
        {totalExamples > 0 && (
          <span className="clf-trigger-total">{totalExamples} ej.</span>
        )}

        <span className="clf-trigger-chevron">{open ? "▴" : "▾"}</span>
      </button>

      {/* ── Expanded panel ──────────────────────────────── */}
      <div className={`clf-panel ${open ? "clf-panel--open" : ""}`}>
        <div className="clf-panel-inner">
          {SEG_ENTRIES.map(({ key, label }) => {
            const info    = status?.[key]
            const n       = info?.ejemplos        ?? 0
            const umbral  = info?.umbral          ?? "sin_datos"
            const sig     = info?.siguiente_umbral ?? {}
            const pct     = sig.total
              ? Math.min(100, (n / sig.total) * 100)
              : umbral === "pro" ? 100 : 0
            const color   = UMBRAL_COLORS[umbral]
            const canAuto = umbral === "excelente" || umbral === "pro"
            const isAuto  = autonomousMode?.[key] ?? false

            return (
              <div key={key} className="clf-seg-row">
                <div className="clf-seg-row-head">
                  <span className="clf-seg-name">{label}</span>

                  <span className="clf-seg-badge" style={{ color }}>
                    {UMBRAL_LABELS[umbral]}
                  </span>

                  <div className="clf-seg-bar-wrap">
                    <div className="clf-seg-bar">
                      <div
                        className="clf-seg-bar-fill"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                  </div>

                  <span className="clf-seg-count">
                    {n}{sig.total ? ` / ${sig.total}` : ""} ej.
                  </span>

                  {canAuto && (
                    <label
                      className="clf-auto-toggle"
                      title="Auto-aprobar audios con confianza ≥ 85%"
                      onClick={e => e.stopPropagation()}
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
            )
          })}

          <div className="clf-panel-hint">
            El clasificador aprende de tus decisiones y con el tiempo puede aprobar audios automáticamente.
          </div>
        </div>
      </div>
    </div>
  )
}
