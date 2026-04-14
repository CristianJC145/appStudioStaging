import { useEffect, useRef } from "react"

const EVENT_ICONS = {
  start:               "◈",
  intro_start:         "◎",
  intro_generating:    "·",
  intro_ready:         "♪",
  intro_review_start:  "◉",
  intro_regenerating:  "↺",
  intro_review_done:   "✓",
  afirm_start:         "◎",
  afirm_generating:    "·",
  afirm_ready:         "♪",
  afirm_review_start:  "◉",
  afirm_regenerating:  "↺",
  afirm_review_done:   "✓",
  building:            "⟳",
  done:                "✦",
  error:               "✗",
  default:             "·",
}

function formatTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function computeProgress(events) {
  if (events.some(e => e.type === "done")) return 100
  if (events.some(e => e.type === "building")) return 95

  const intro_total       = events.find(e => e.type === "intro_start")?.data?.total
  const afirm_total       = events.find(e => e.type === "afirm_start")?.data?.total
  const intro_review_done = events.some(e => e.type === "intro_review_done")
  const afirm_review_done = events.some(e => e.type === "afirm_review_done")
  const has_intro         = !!intro_total
  const has_afirm         = !!afirm_total

  let progress = 0

  if (has_intro && has_afirm) {
    const intro_ready = events.filter(e => e.type === "intro_ready").length
    const afirm_ready = events.filter(e => e.type === "afirm_ready").length
    const intro_pct   = intro_review_done ? 40 : Math.min(35, (intro_ready / intro_total) * 38)
    const afirm_pct   = afirm_review_done ? 50 : Math.min(48, (afirm_ready / afirm_total) * 48)
    progress = intro_pct + afirm_pct
  } else if (has_intro) {
    const intro_ready = events.filter(e => e.type === "intro_ready").length
    progress = intro_review_done ? 90 : Math.min(80, (intro_ready / intro_total) * 80)
  } else if (has_afirm) {
    const afirm_ready = events.filter(e => e.type === "afirm_ready").length
    progress = afirm_review_done ? 90 : Math.min(80, (afirm_ready / afirm_total) * 80)
  }

  return Math.min(94, Math.round(progress))
}

export default function GenerationProgress({
  events, jobStatus, downloadUrl, durationMins,
  charsUsados, charsRestantes,
  reviewSection, onGoReview, pendingReview
}) {
  const logRef = useRef(null)

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [events])

  const progress = computeProgress(events)

  const statusLabel = {
    starting:        "Iniciando",
    running:         "Generando",
    awaiting_review: reviewSection === "intro" ? "Revisión de Intro" : "Revisión de Afirmaciones",
    building:        "Ensamblando",
    done:            "Completado",
    error:           "Error",
  }[jobStatus] ?? "En espera"

  const statusClass = {
    done:            "done",
    error:           "error",
    awaiting_review: "review",
    running:         "running",
    building:        "running",
  }[jobStatus] ?? "idle"

  // Contadores por sección
  const introTotal       = events.find(e => e.type === "intro_start")?.data?.total
  const introReady       = events.filter(e => e.type === "intro_ready").length
  const introReviewDone  = events.some(e => e.type === "intro_review_done")
  const afirmTotal       = events.find(e => e.type === "afirm_start")?.data?.total
  const afirmReady       = events.filter(e => e.type === "afirm_ready").length
  const afirmReviewDone  = events.some(e => e.type === "afirm_review_done")

  // Filtrar eventos menos verbosos para el log
  const logEvents = events.filter(e =>
    !["intro_generating", "afirm_generating"].includes(e.type) ||
    e.data?.index % 4 === 0
  )

  return (
    <div className="fade-up" style={{ maxWidth: 760, margin: "0 auto" }}>

      {/* Banner de descarga */}
      {downloadUrl && (
        <div className="download-banner">
          <div className="download-banner-icon">✦</div>
          <div className="download-banner-info">
            <div className="download-banner-title">Audio generado con éxito</div>
            <div className="download-banner-sub">{durationMins ? `${durationMins} min` : "Listo"}</div>
            {charsUsados != null && (
              <div style={{ marginTop: 5, fontSize: 11, opacity: 0.7, display: "flex", gap: 12 }}>
                <span>Créditos usados: <strong>{charsUsados.toLocaleString()}</strong></span>
                {charsRestantes != null && (
                  <span>Restantes: <strong>{charsRestantes.toLocaleString()}</strong></span>
                )}
              </div>
            )}
          </div>
          <a href={`${downloadUrl}?format=wav`} download className="btn btn-primary">
            ↓ Descargar WAV
          </a>
        </div>
      )}

      {/* Card de estado */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Estado de generación</div>
          <span className={`status-pill ${statusClass}`}>
            {(statusClass === "running" || statusClass === "review") &&
              <span className="pulse">●</span>}
            {statusLabel}
          </span>
        </div>
        <div className="card-body">

          {/* Barra de progreso */}
          <div className="progress-bar-wrap" style={{ marginBottom: 20 }}>
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>

          {/* Stats por sección */}
          <div style={{ display: "flex", gap: 28, marginBottom: 20, flexWrap: "wrap" }}>
            {introTotal && (
              <div>
                <div className="text-xs text-muted">Intro</div>
                <div className="text-xs" style={{ marginTop: 3, color: introReviewDone ? "var(--green)" : "var(--violet2)" }}>
                  {introReviewDone
                    ? "✓ Revisión completa"
                    : `${introReady}/${introTotal} segmento${introTotal !== 1 ? "s" : ""}`}
                </div>
              </div>
            )}
            {afirmTotal && (
              <div>
                <div className="text-xs text-muted">Afirmaciones</div>
                <div className="text-xs" style={{ marginTop: 3, color: afirmReviewDone ? "var(--green)" : "var(--violet2)" }}>
                  {afirmReviewDone
                    ? "✓ Revisión completa"
                    : `${afirmReady}/${afirmTotal} listas`}
                </div>
              </div>
            )}

            {/* Botón ir a revisión */}
            {jobStatus === "awaiting_review" && pendingReview > 0 && (
              <div style={{ marginLeft: "auto" }}>
                <button className="btn btn-primary" onClick={onGoReview}>
                  Revisar {pendingReview}{" "}
                  {reviewSection === "intro" ? "segmento" : "afirmación"}
                  {pendingReview !== 1 ? "s" : ""} →
                </button>
              </div>
            )}
          </div>

          {/* Log de eventos */}
          <div className="events-log" ref={logRef}>
            {logEvents.length === 0 ? (
              <div style={{ color: "var(--text3)", padding: "8px 0" }}>
                Esperando inicio...
              </div>
            ) : (
              logEvents.map((evt, i) => (
                <div key={i} className={`event-line type-${evt.type}`}>
                  <span className="event-time">{formatTime(evt.ts)}</span>
                  <span className="event-dot">
                    {EVENT_ICONS[evt.type] ?? EVENT_ICONS.default}
                  </span>
                  <span className="event-text">{evt.data?.message || evt.type}</span>
                </div>
              ))
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
