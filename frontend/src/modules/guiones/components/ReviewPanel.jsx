import { useState, useEffect, useRef } from "react"

// ─────────────────────────────────────────────────────────────
//  XAI Tooltip — shows explicacion_detallada on hover/click
// ─────────────────────────────────────────────────────────────
function XAITooltip({ text }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  if (!text) return null
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: "var(--text3)", fontSize: "0.72rem", padding: "0 3px",
          lineHeight: 1, verticalAlign: "middle",
        }}
        title="Ver explicación del agente"
      >
        ℹ
      </button>
      {open && (
        <span style={{
          position: "absolute", bottom: "120%", left: "50%", transform: "translateX(-50%)",
          background: "var(--bg3, #1e1e2e)", color: "var(--text1)",
          border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)",
          padding: "8px 12px", fontSize: "0.75rem", lineHeight: 1.5,
          whiteSpace: "pre-wrap", width: 260, zIndex: 999,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          pointerEvents: "none",
        }}>
          {text}
        </span>
      )}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
//  Confidence Badge con botón ℹ para XAI
// ─────────────────────────────────────────────────────────────
function ConfidenceBadge({ data }) {
  if (!data || data.decision == null) return null

  const c        = data.confianza ?? 0
  const razon    = data.razon_principal || data.razon || ""
  const explicac = data.explicacion_detallada || ""

  let cls = "clf-badge clf-badge--low"
  let icon = "⚠"
  let label = `Revisar · ${c}%`

  if (data.decision === "aprobado" && c >= 85) {
    cls = "clf-badge clf-badge--ok"; icon = "✦"; label = `${c}% confianza`
  } else if (data.decision === "aprobado" && c >= 70) {
    cls = "clf-badge clf-badge--warn"; icon = "◐"; label = `${c}% confianza`
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      <span className={cls} title={razon}>
        {icon} {label}
      </span>
      <XAITooltip text={explicac} />
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
//  Star Rating — inline selector 1-5 estrellas
// ─────────────────────────────────────────────────────────────
function StarRating({ value, onChange }) {
  const [hovered, setHovered] = useState(0)
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onMouseEnter={() => setHovered(n)}
          onMouseLeave={() => setHovered(0)}
          onClick={() => onChange(n)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "0 1px",
            fontSize: "1.1rem", lineHeight: 1,
            color: n <= (hovered || value) ? "#f4c430" : "var(--text3)",
            transition: "color 0.1s",
          }}
          title={`${n} estrella${n > 1 ? "s" : ""}`}
        >
          ★
        </button>
      ))}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
//  Approve Modal — star rating before confirming approval
// ─────────────────────────────────────────────────────────────
function ApproveModal({ onConfirm, onCancel }) {
  const [stars, setStars] = useState(0)
  return (
    <div style={{
      position: "absolute", zIndex: 50, top: "100%", left: 0, right: 0,
      background: "var(--bg2)", border: "1px solid var(--gold2)",
      borderRadius: "var(--radius-sm)", padding: "12px 14px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)", marginTop: 6,
    }}>
      <div className="text-xs" style={{ marginBottom: 8, color: "var(--text2)" }}>
        ¿Qué tan inmersivo es este audio?
      </div>
      <StarRating value={stars} onChange={setStars} />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          className="btn btn-sm btn-success"
          onClick={() => onConfirm(stars || null)}
        >
          ✓ Confirmar
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Reject Menu — multi-select labels before confirming rejection
// ─────────────────────────────────────────────────────────────
const REJECT_LABELS = [
  { id: "voz_robotica",      label: "Voz robótica" },
  { id: "velocidad_lenta",   label: "Velocidad lenta" },
  { id: "velocidad_rapida",  label: "Velocidad rápida" },
  { id: "mala_pronunciacion", label: "Mala pronunciación" },
]

function RejectMenu({ onConfirm, onCancel }) {
  const [selected, setSelected] = useState([])

  const toggle = (id) => setSelected(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  )

  return (
    <div style={{
      position: "absolute", zIndex: 50, top: "100%", left: 0, right: 0,
      background: "var(--bg2)", border: "1px solid var(--border2)",
      borderRadius: "var(--radius-sm)", padding: "12px 14px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)", marginTop: 6,
    }}>
      <div className="text-xs" style={{ marginBottom: 8, color: "var(--text2)" }}>
        ¿Por qué lo rechazas?
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {REJECT_LABELS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            className="btn btn-sm"
            style={{
              background: selected.includes(id) ? "var(--violet2, #7c5cbf)" : "var(--bg3)",
              color: selected.includes(id) ? "#fff" : "var(--text2)",
              border: `1px solid ${selected.includes(id) ? "var(--violet2)" : "var(--border2)"}`,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => onConfirm(selected.length > 0 ? selected : null)}
        >
          ↺ Confirmar
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Player de audio con controles de salto
// ─────────────────────────────────────────────────────────────
function AudioPlayer({ src }) {
  const audioRef   = useRef(null)
  const barRef     = useRef(null)
  const fillRef    = useRef(null)
  const thumbRef   = useRef(null)
  const seekingRef = useRef(false)
  const durationRef = useRef(0)

  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [durDisp, setDurDisp] = useState(0)
  const [speed,   setSpeed]   = useState(1)
  const SPEEDS = [1, 1.5, 2]

  const _setPct = (pct) => {
    const p = Math.max(0, Math.min(1, pct)) * 100
    if (fillRef.current)  fillRef.current.style.width = `${p}%`
    if (thumbRef.current) thumbRef.current.style.left = `${p}%`
  }

  const _pctFromEvent = (e) => {
    const bar = barRef.current; if (!bar) return 0
    const rect = bar.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  useEffect(() => {
    const a = audioRef.current; if (!a) return
    a.pause(); setPlaying(false); setCurrent(0); setDurDisp(0)
    durationRef.current = 0; setSpeed(1); a.playbackRate = 1
    seekingRef.current = false; _setPct(0); a.load()
  }, [src])

  const fmt = (s) => {
    if (!s || isNaN(s)) return "0:00"
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
  }

  const toggle = () => { const a = audioRef.current; if (!a) return; playing ? a.pause() : a.play(); setPlaying(p => !p) }
  const skip   = (secs) => {
    const a = audioRef.current; if (!a) return
    const dur = durationRef.current; if (!dur || isNaN(dur)) return
    const next = Math.max(0, Math.min(dur, a.currentTime + secs))
    a.currentTime = next; setCurrent(next); _setPct(next / dur)
  }

  return (
    <div className="audio-player">
      <audio
        ref={audioRef} src={src} preload="auto"
        onTimeUpdate={(e) => { if (!seekingRef.current) { setCurrent(e.target.currentTime); _setPct(durationRef.current > 0 ? e.target.currentTime / durationRef.current : 0) } }}
        onLoadedMetadata={(e) => { durationRef.current = e.target.duration; setDurDisp(e.target.duration) }}
        onEnded={() => { setPlaying(false); seekingRef.current = false }}
      />
      <div ref={barRef} className="ap-seek-bar"
        onPointerDown={(e) => { e.preventDefault(); seekingRef.current = true; barRef.current.setPointerCapture(e.pointerId); _setPct(_pctFromEvent(e)) }}
        onPointerMove={(e) => { if (seekingRef.current) _setPct(_pctFromEvent(e)) }}
        onPointerUp={(e) => { if (!seekingRef.current) return; seekingRef.current = false; const pct = _pctFromEvent(e); const dur = durationRef.current; _setPct(pct); if (dur && audioRef.current) { const t = pct * dur; audioRef.current.currentTime = t; setCurrent(t) } }}
      >
        <div className="ap-seek-track"><div ref={fillRef} className="ap-seek-fill" style={{ width: "0%" }} /></div>
        <div ref={thumbRef} className="ap-seek-thumb" style={{ left: "0%" }} />
      </div>
      <div className="ap-controls">
        <button type="button" className="ap-btn" onClick={() => skip(-10)}>«10</button>
        <button type="button" className="ap-btn" onClick={() => skip(-5)}>«5</button>
        <button type="button" className="ap-btn ap-play" onClick={toggle}>{playing ? "▐▐" : "▶"}</button>
        <button type="button" className="ap-btn" onClick={() => skip(5)}>5»</button>
        <button type="button" className="ap-btn" onClick={() => skip(10)}>10»</button>
        <button type="button" className="ap-btn ap-speed" onClick={() => { const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; setSpeed(next); if (audioRef.current) audioRef.current.playbackRate = next }}>x{speed}</button>
        <span className="ap-time">{fmt(current)} / {fmt(durDisp)}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Card individual
// ─────────────────────────────────────────────────────────────
function ReviewCard({ section, index, label, text, audioUrl, decision, onDecision, classifierData }) {
  const [editing, setEditing]         = useState(false)
  const [editedText, setEditedText]   = useState("")
  const [regenCount, setRegenCount]   = useState(0)
  const [pendingOk, setPendingOk]     = useState(false)
  const [pendingReject, setPendingReject] = useState(false)
  const prevAudioUrl = useRef(null)
  const cardClass = decision ? `decided-${decision}` : ""

  useEffect(() => {
    if (audioUrl && prevAudioUrl.current !== null && audioUrl !== prevAudioUrl.current) {
      setRegenCount(c => c + 1)
      setPendingOk(false)
      setPendingReject(false)
    }
    prevAudioUrl.current = audioUrl ?? null
  }, [audioUrl])

  const handleDownload = async () => {
    if (!audioUrl) return
    const fullUrl = `${import.meta.env.VITE_API_URL}${audioUrl}`
    const filename = audioUrl.split("/").pop() || `audio_${index + 1}.wav`
    try {
      const res = await fetch(fullUrl); const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    } catch {}
  }

  // Aprobar → show star modal
  const handleAprobarClick = () => {
    if (!audioUrl) return
    setPendingReject(false)
    setPendingOk(true)
  }
  const handleAprobarConfirm = (stars) => {
    setPendingOk(false)
    setRegenCount(0)
    onDecision(section, index, "ok", null, { calidad_score: stars })
  }

  // Regenerar → show rejection labels
  const handleRegenClick = () => {
    if (!audioUrl) return
    setPendingOk(false)
    setPendingReject(true)
  }
  const handleRegenConfirm = (labels) => {
    setPendingReject(false)
    setRegenCount(0)
    onDecision(section, index, "regenerate", null, { razon_rechazo: labels })
  }

  // Omitir
  const handleSkip = () => {
    setPendingOk(false); setPendingReject(false); setRegenCount(0)
    onDecision(section, index, "skip")
  }

  const cancelEdit = () => setEditing(false)
  const confirmEdit = () => {
    const trimmed = editedText.trim()
    if (!trimmed || trimmed === text) { setEditing(false); return }
    onDecision(section, index, "regenerate", trimmed)
    setEditing(false)
  }

  return (
    <div className={`review-card fade-up ${cardClass}`} style={{ animationDelay: `${index * 0.04}s`, position: "relative" }}>

      <div className="review-card-num">
        {label || (section === "intro" ? "SEGMENTO" : section === "medit" ? "MEDITACIÓN" : "AFIRMACIÓN")} {String(index + 1).padStart(2, "0")}
        {decision && (
          <span className={`decision-badge ${decision}`}>
            {decision === "ok"         && "✓ Aprobado"}
            {decision === "regenerate" && "↺ Regenerar"}
            {decision === "skip"       && "— Omitir"}
          </span>
        )}
        <ConfidenceBadge data={classifierData} />
      </div>

      <div className="review-card-text" style={{ whiteSpace: "pre-line" }}>
        {(text || "…")
          .replace(/<break[^>]*\/>/g, "\n")
          .replace(/[ \t]+/g, " ")
          .replace(/ \n/g, "\n")
          .replace(/\n /g, "\n")
          .replace(/\n+/g, "\n\n")
          .trim()}
      </div>

      {editing && (
        <div style={{ marginBottom: 8 }}>
          <textarea
            value={editedText}
            onChange={e => setEditedText(e.target.value)}
            rows={4}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "var(--bg2)", color: "var(--text1)",
              border: "1px solid var(--gold2)", borderRadius: "var(--radius-sm)",
              padding: "8px 10px", fontSize: "0.82rem", lineHeight: 1.5,
              resize: "vertical", fontFamily: "inherit",
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button className="btn btn-sm btn-secondary" onClick={confirmEdit} disabled={!editedText.trim()}>
              ↺ Regenerar con nuevo texto
            </button>
            <button className="btn btn-sm btn-ghost" onClick={cancelEdit}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="review-card-audio">
        {regenCount > 0 && (
          <div className="regen-badge" key={regenCount}>
            <span>✦ Audio regenerado ({regenCount})</span>
          </div>
        )}
        {audioUrl
          ? <AudioPlayer src={`${import.meta.env.VITE_API_URL}${audioUrl}`} />
          : <div className="text-xs text-muted" style={{ padding: "8px 0" }}><span className="pulse">⏳ Generando audio...</span></div>
        }
      </div>

      <div className="review-card-actions" style={{ position: "relative" }}>
        <button
          className={`btn btn-sm ${decision === "ok" ? "btn-success" : "btn-ghost"}`}
          onClick={handleAprobarClick}
          disabled={!audioUrl}
        >
          ✓ Aprobar
        </button>
        <button
          className={`btn btn-sm ${decision === "regenerate" ? "btn-secondary" : "btn-ghost"}`}
          onClick={handleRegenClick}
          disabled={!audioUrl}
        >
          ↺ Regenerar
        </button>
        <button
          className={`btn btn-sm ${decision === "skip" ? "btn-danger" : "btn-ghost"}`}
          onClick={handleSkip}
        >
          — Omitir
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => { setEditedText(text || ""); setEditing(e => !e) }}
          title="Editar texto y regenerar"
          style={{ marginLeft: "auto", opacity: 0.65 }}
        >
          ✎ Editar
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={handleDownload}
          disabled={!audioUrl}
          title="Descargar audio"
          style={{ opacity: audioUrl ? 0.65 : 0.3 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>

        {/* Approve star rating modal */}
        {pendingOk && (
          <ApproveModal
            onConfirm={handleAprobarConfirm}
            onCancel={() => setPendingOk(false)}
          />
        )}

        {/* Reject label menu */}
        {pendingReject && (
          <RejectMenu
            onConfirm={handleRegenConfirm}
            onCancel={() => setPendingReject(false)}
          />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Panel de sección
// ─────────────────────────────────────────────────────────────
function SectionReview({ section, label, items, audios, decisions, onDecision, onFinalize, jobStatus, isActive, regeneratingItems, classifierEvents }) {
  const total    = items.length
  const decided  = Object.keys(decisions).length
  const approved = Object.values(decisions).filter(d => d === "ok").length
  const toRegen  = Object.values(decisions).filter(d => d === "regenerate").length
  const skipped  = Object.values(decisions).filter(d => d === "skip").length
  const pending  = total - decided

  const canFinalize       = decided === total && toRegen === 0
  const allAudiosLoaded   = items.every((_, i) => !!audios[i])
  const anyRegenerating   = regeneratingItems.size > 0
  const canApproveAll     = allAudiosLoaded && !anyRegenerating && jobStatus !== "building"

  const handleApproveAll = () => {
    items.forEach((_, i) => {
      if (!audios[i] || regeneratingItems.has(i)) return
      if (!decisions[i] || decisions[i] === "regenerate") {
        onDecision(section, i, "ok", null, { calidad_score: null })
      }
    })
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body" style={{ padding: "16px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 6 }}>
                {isActive
                  ? `Revisión de ${label}`
                  : <span style={{ color: "var(--text2)" }}>{label} <span className="text-xs" style={{ marginLeft: 8, color: "var(--green)" }}>✓ Completada</span></span>
                }
              </div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <span className="text-xs text-muted">Total: <span className="text-accent">{total}</span></span>
                <span className="text-xs text-muted">Aprobados: <span style={{ color: "var(--green)" }}>{approved}</span></span>
                {toRegen > 0 && <span className="text-xs text-muted">Regenerar: <span className="text-accent">{toRegen}</span></span>}
                {skipped > 0 && <span className="text-xs text-muted">Omitidos: <span style={{ color: "var(--text3)" }}>{skipped}</span></span>}
                {pending > 0 && isActive && <span className="text-xs text-muted">Pendientes: <span style={{ color: "var(--red)" }}>{pending}</span></span>}
              </div>
            </div>
            {isActive && (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleApproveAll}
                  disabled={!canApproveAll}
                  title={anyRegenerating ? "Espera a que terminen las regeneraciones" : !allAudiosLoaded ? "Espera a que carguen todos los audios" : ""}
                >
                  ✓ Aprobar todos
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => onFinalize(section)}
                  disabled={!canFinalize || jobStatus === "building"}
                  title={!canFinalize ? "Decide todos los segmentos antes de continuar" : ""}
                >
                  {jobStatus === "building"
                    ? <><span className="pulse">◉</span> Ensamblando...</>
                    : <>Confirmar y continuar →</>
                  }
                </button>
              </div>
            )}
          </div>
          {total > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="progress-bar-wrap">
                <div className="progress-bar-fill" style={{ width: `${(decided / total) * 100}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="review-grid" style={{ marginBottom: 32 }}>
        {items.map((text, i) => (
          <ReviewCard
            key={i}
            section={section}
            index={i}
            label={label === "Intro" ? "SEGMENTO" : label === "Meditación" ? "MEDITACIÓN" : "AFIRMACIÓN"}
            text={text}
            audioUrl={audios[i]}
            decision={decisions[i]}
            onDecision={onDecision}
            classifierData={classifierEvents?.[`${section}_${i}`] ?? null}
          />
        ))}
      </div>

      {isActive && canFinalize && (
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => onFinalize(section)}
            disabled={jobStatus === "building"}
          >
            {jobStatus === "building"
              ? <><span className="pulse">◉</span> Procesando...</>
              : <>✦ Confirmar {label} y continuar</>
            }
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Panel principal
// ─────────────────────────────────────────────────────────────
export default function ReviewPanel({
  reviewSection,
  introBloques, introAudios, introDecisions,
  afirmaciones, afirmAudios, afirmDecisions,
  meditaciones, meditAudios, meditDecisions,
  introRegenerating, afirmRegenerating, meditRegenerating,
  classifierEvents,
  onDecision, onFinalize, jobStatus,
}) {
  const hasIntro = introBloques.length > 0
  const hasAfirm = afirmaciones.length > 0
  const hasMedit = meditaciones.length > 0

  if (!hasIntro && !hasAfirm && !hasMedit) {
    return (
      <div className="empty-state fade-up">
        <div className="empty-icon">◎</div>
        <div>Los segmentos aparecerán aquí durante la generación</div>
        <div className="text-xs text-muted mt-8">Inicia la generación desde la pestaña Guion</div>
      </div>
    )
  }

  return (
    <div className="fade-up">
      {reviewSection && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          marginBottom: 24, padding: "10px 16px",
          background: "rgba(147,112,219,0.07)",
          border: "1px solid var(--border2)", borderRadius: "var(--radius-sm)",
        }}>
          <span className="pulse" style={{ color: "var(--violet2)" }}>◉</span>
          <span className="text-xs" style={{ color: "var(--text2)" }}>Revisando ahora:</span>
          <span className="text-xs text-accent">
            {reviewSection === "intro" ? "Intro" : reviewSection === "afirm" ? "Afirmaciones" : "Meditación"}
          </span>
          <span className="text-xs text-muted" style={{ marginLeft: "auto" }}>
            {reviewSection === "intro" && (hasAfirm || hasMedit) ? "Las siguientes secciones se generarán después"
              : reviewSection === "afirm" && hasMedit ? "La meditación se generará después" : ""}
          </span>
        </div>
      )}

      {hasIntro && (
        <SectionReview
          section="intro" label="Intro"
          items={introBloques} audios={introAudios} decisions={introDecisions}
          onDecision={onDecision} onFinalize={onFinalize} jobStatus={jobStatus}
          isActive={reviewSection === "intro"} regeneratingItems={introRegenerating}
          classifierEvents={classifierEvents}
        />
      )}

      {hasIntro && hasAfirm && <div className="section-divider" style={{ margin: "8px 0 28px" }}>Afirmaciones</div>}

      {hasAfirm && (
        <SectionReview
          section="afirm" label="Afirmaciones"
          items={afirmaciones} audios={afirmAudios} decisions={afirmDecisions}
          onDecision={onDecision} onFinalize={onFinalize} jobStatus={jobStatus}
          isActive={reviewSection === "afirm"} regeneratingItems={afirmRegenerating}
          classifierEvents={classifierEvents}
        />
      )}

      {(hasIntro || hasAfirm) && hasMedit && <div className="section-divider" style={{ margin: "8px 0 28px" }}>Meditación</div>}

      {hasMedit && (
        <SectionReview
          section="medit" label="Meditación"
          items={meditaciones} audios={meditAudios} decisions={meditDecisions}
          onDecision={onDecision} onFinalize={onFinalize} jobStatus={jobStatus}
          isActive={reviewSection === "medit"} regeneratingItems={meditRegenerating}
          classifierEvents={classifierEvents}
        />
      )}
    </div>
  )
}
