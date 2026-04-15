import { useState, useEffect, useRef } from "react"

// ─────────────────────────────────────────────────────────────
//  Player de audio con controles de salto
// ─────────────────────────────────────────────────────────────
function AudioPlayer({ src }) {
  const audioRef    = useRef(null)
  const barRef      = useRef(null)   // contenedor clickeable de la barra
  const fillRef     = useRef(null)   // div del progreso (visual)
  const thumbRef    = useRef(null)   // circulo thumb
  const seekingRef  = useRef(false)
  const durationRef = useRef(0)      // duración sin causar re-renders

  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [durDisp, setDurDisp] = useState(0)  // solo para mostrar en pantalla
  const [speed,   setSpeed]   = useState(1)
  const SPEEDS = [1, 1.5, 2]

  // Actualiza la barra visualmente dado un porcentaje 0-1
  const _setPct = (pct) => {
    const p = Math.max(0, Math.min(1, pct)) * 100
    if (fillRef.current)  fillRef.current.style.width  = `${p}%`
    if (thumbRef.current) thumbRef.current.style.left  = `${p}%`
  }

  // Calcula el porcentaje relativo al ancho de la barra desde un PointerEvent
  const _pctFromEvent = (e) => {
    const bar = barRef.current
    if (!bar) return 0
    const rect = bar.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  // Reset al cambiar src
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    a.pause(); setPlaying(false); setCurrent(0); setDurDisp(0)
    durationRef.current = 0
    setSpeed(1); a.playbackRate = 1
    seekingRef.current = false
    _setPct(0)
    a.load()
  }, [src])

  const fmt = (s) => {
    if (!s || isNaN(s)) return "0:00"
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
  }

  const toggle = () => {
    const a = audioRef.current; if (!a) return
    playing ? a.pause() : a.play()
    setPlaying(p => !p)
  }

  const skip = (secs) => {
    const a = audioRef.current; if (!a) return
    const dur = durationRef.current; if (!dur || isNaN(dur)) return
    const next = Math.max(0, Math.min(dur, a.currentTime + secs))
    a.currentTime = next
    setCurrent(next)
    _setPct(next / dur)
  }

  const handleTimeUpdate = (e) => {
    if (seekingRef.current) return
    const t = e.target.currentTime
    setCurrent(t)
    _setPct(durationRef.current > 0 ? t / durationRef.current : 0)
  }

  const handleMetadata = (e) => {
    const dur = e.target.duration
    durationRef.current = dur
    setDurDisp(dur)
  }

  // ── Pointer events en la barra (funcionan igual en mouse y touch) ──

  const onBarPointerDown = (e) => {
    e.preventDefault()
    seekingRef.current = true
    barRef.current.setPointerCapture(e.pointerId)  // captura el pointer aunque salga del elemento
    _setPct(_pctFromEvent(e))
  }

  const onBarPointerMove = (e) => {
    if (!seekingRef.current) return
    _setPct(_pctFromEvent(e))
  }

  const onBarPointerUp = (e) => {
    if (!seekingRef.current) return
    seekingRef.current = false
    const pct = _pctFromEvent(e)
    const dur = durationRef.current
    _setPct(pct)
    if (dur && audioRef.current) {
      const t = pct * dur
      audioRef.current.currentTime = t
      setCurrent(t)
    }
  }

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    setSpeed(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        src={src}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleMetadata}
        onEnded={() => { setPlaying(false); seekingRef.current = false }}
      />

      {/* Barra de seek completamente custom — sin input[type=range] */}
      <div
        ref={barRef}
        className="ap-seek-bar"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarPointerUp}
      >
        <div className="ap-seek-track">
          <div ref={fillRef} className="ap-seek-fill" style={{ width: "0%" }} />
        </div>
        <div ref={thumbRef} className="ap-seek-thumb" style={{ left: "0%" }} />
      </div>

      <div className="ap-controls">
        <button type="button" className="ap-btn" onClick={() => skip(-10)}>«10</button>
        <button type="button" className="ap-btn" onClick={() => skip(-5)}>«5</button>
        <button type="button" className="ap-btn ap-play" onClick={toggle}>
          {playing ? "▐▐" : "▶"}
        </button>
        <button type="button" className="ap-btn" onClick={() => skip(5)}>5»</button>
        <button type="button" className="ap-btn" onClick={() => skip(10)}>10»</button>
        <button type="button" className="ap-btn ap-speed" onClick={cycleSpeed}>x{speed}</button>
        <span className="ap-time">{fmt(current)} / {fmt(durDisp)}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Card individual — igual para intro y afirmaciones
// ─────────────────────────────────────────────────────────────
function ReviewCard({ section, index, label, text, audioUrl, decision, onDecision }) {
  const [editing, setEditing]       = useState(false)
  const [editedText, setEditedText] = useState("")
  const [regenCount, setRegenCount] = useState(0)
  const prevAudioUrl = useRef(null)
  const cardClass = decision ? `decided-${decision}` : ""

  useEffect(() => {
    if (audioUrl && prevAudioUrl.current !== null && audioUrl !== prevAudioUrl.current) {
      setRegenCount(c => c + 1)
    }
    prevAudioUrl.current = audioUrl ?? null
  }, [audioUrl])

  const handleDownload = async () => {
    if (!audioUrl) return
    const fullUrl = `${import.meta.env.VITE_API_URL}${audioUrl}`
    const filename = audioUrl.split("/").pop() || `audio_${index + 1}.wav`
    try {
      const res  = await fetch(fullUrl)
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {}
  }

  const cancelEdit = () => setEditing(false)

  const confirmEdit = () => {
    const trimmed = editedText.trim()
    if (!trimmed || trimmed === text) { setEditing(false); return }
    onDecision(section, index, "regenerate", trimmed)
    setEditing(false)
  }

  return (
    <div className={`review-card fade-up ${cardClass}`}
         style={{ animationDelay: `${index * 0.04}s` }}>

      <div className="review-card-num">
        {label || (section === "intro" ? "SEGMENTO" : section === "medit" ? "MEDITACIÓN" : "AFIRMACIÓN")} {String(index + 1).padStart(2, "0")}
        {decision && (
          <span className={`decision-badge ${decision}`}>
            {decision === "ok"         && "✓ Aprobado"}
            {decision === "regenerate" && "↺ Regenerar"}
            {decision === "skip"       && "— Omitir"}
          </span>
        )}
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
              resize: "vertical", fontFamily: "inherit"
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              className="btn btn-sm btn-secondary"
              onClick={confirmEdit}
              disabled={!editedText.trim()}
            >
              ↺ Regenerar con nuevo texto
            </button>
            <button className="btn btn-sm btn-ghost" onClick={cancelEdit}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="review-card-audio">
        {regenCount > 0 && (
          <div className="regen-badge" key={regenCount}>
            <span>✦ Audio regenerado ({regenCount})</span>
          </div>
        )}
        {audioUrl ? (
          <AudioPlayer src={`${import.meta.env.VITE_API_URL}${audioUrl}`} />
        ) : (
          <div className="text-xs text-muted" style={{ padding: "8px 0" }}>
            <span className="pulse">⏳ Generando audio...</span>
          </div>
        )}
      </div>

      <div className="review-card-actions">
        <button
          className={`btn btn-sm ${decision === "ok" ? "btn-success" : "btn-ghost"}`}
          onClick={() => { onDecision(section, index, "ok"); setRegenCount(0) }}
          disabled={!audioUrl}
        >
          ✓ Aprobar
        </button>
        <button
          className={`btn btn-sm ${decision === "regenerate" ? "btn-secondary" : "btn-ghost"}`}
          onClick={() => { onDecision(section, index, "regenerate"); setRegenCount(0) }}
          disabled={!audioUrl}
        >
          ↺ Regenerar
        </button>
        <button
          className={`btn btn-sm ${decision === "skip" ? "btn-danger" : "btn-ghost"}`}
          onClick={() => { onDecision(section, index, "skip"); setRegenCount(0) }}
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
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Panel de sección (Intro o Afirmaciones)
// ─────────────────────────────────────────────────────────────
function SectionReview({ section, label, items, audios, decisions, onDecision, onFinalize, jobStatus, isActive, regeneratingItems }) {
  const total    = items.length
  const decided  = Object.keys(decisions).length
  const approved = Object.values(decisions).filter(d => d === "ok").length
  const toRegen  = Object.values(decisions).filter(d => d === "regenerate").length
  const skipped  = Object.values(decisions).filter(d => d === "skip").length
  const pending  = total - decided

  // Puede finalizar cuando no hay ninguna en estado "regenerate" y todas decididas
  const canFinalize = decided === total && toRegen === 0

  // Aprobar todos: disponible solo cuando todos los audios cargaron y no hay regeneraciones pendientes
  const allAudiosLoaded   = items.every((_, i) => !!audios[i])
  const anyRegenerating   = regeneratingItems.size > 0
  const canApproveAll     = allAudiosLoaded && !anyRegenerating && jobStatus !== "building"

  const handleApproveAll = () => {
    items.forEach((_, i) => {
      if (!audios[i]) return                  // sin audio, saltar
      if (regeneratingItems.has(i)) return    // aún regenerando, saltar
      if (!decisions[i] || decisions[i] === "regenerate") {
        onDecision(section, i, "ok")
      }
    })
  }

  return (
    <div>
      {/* Barra de control de sección */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body" style={{ padding: "16px 24px" }}>
          <div style={{ display: "flex", alignItems: "center",
                        justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 6 }}>
                {isActive
                  ? `Revisión de ${label}`
                  : <span style={{ color: "var(--text2)" }}>
                      {label} <span className="text-xs" style={{ marginLeft: 8, color: "var(--green)" }}>
                        ✓ Completada
                      </span>
                    </span>
                }
              </div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <span className="text-xs text-muted">
                  Total: <span className="text-accent">{total}</span>
                </span>
                <span className="text-xs text-muted">
                  Aprobados: <span style={{ color: "var(--green)" }}>{approved}</span>
                </span>
                {toRegen > 0 && (
                  <span className="text-xs text-muted">
                    Regenerar: <span className="text-accent">{toRegen}</span>
                  </span>
                )}
                {skipped > 0 && (
                  <span className="text-xs text-muted">
                    Omitidos: <span style={{ color: "var(--text3)" }}>{skipped}</span>
                  </span>
                )}
                {pending > 0 && isActive && (
                  <span className="text-xs text-muted">
                    Pendientes: <span style={{ color: "var(--red)" }}>{pending}</span>
                  </span>
                )}
              </div>
            </div>

            {isActive && (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleApproveAll}
                  disabled={!canApproveAll}
                  title={
                    anyRegenerating   ? "Espera a que terminen las regeneraciones" :
                    !allAudiosLoaded  ? "Espera a que carguen todos los audios"    : ""
                  }
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

          {/* Barra de progreso de revisión */}
          {total > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="progress-bar-wrap">
                <div className="progress-bar-fill"
                     style={{ width: `${(decided / total) * 100}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Grid de tarjetas */}
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
          />
        ))}
      </div>

      {/* Botón final grande cuando todo está listo */}
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
//  Panel principal — orquesta intro + afirm
// ─────────────────────────────────────────────────────────────
export default function ReviewPanel({
  reviewSection,
  introBloques, introAudios, introDecisions,
  afirmaciones, afirmAudios, afirmDecisions,
  meditaciones, meditAudios, meditDecisions,
  introRegenerating, afirmRegenerating, meditRegenerating,
  onDecision, onFinalize, jobStatus
}) {
  const hasIntro = introBloques.length > 0
  const hasAfirm = afirmaciones.length > 0
  const hasMedit = meditaciones.length > 0

  if (!hasIntro && !hasAfirm && !hasMedit) {
    return (
      <div className="empty-state fade-up">
        <div className="empty-icon">◎</div>
        <div>Los segmentos aparecerán aquí durante la generación</div>
        <div className="text-xs text-muted mt-8">
          Inicia la generación desde la pestaña Guion
        </div>
      </div>
    )
  }

  return (
    <div className="fade-up">

      {/* Indicador de sección activa */}
      {reviewSection && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          marginBottom: 24, padding: "10px 16px",
          background: "rgba(147,112,219,0.07)",
          border: "1px solid var(--border2)",
          borderRadius: "var(--radius-sm)"
        }}>
          <span className="pulse" style={{ color: "var(--violet2)" }}>◉</span>
          <span className="text-xs" style={{ color: "var(--text2)" }}>
            Revisando ahora:
          </span>
          <span className="text-xs text-accent">
            {reviewSection === "intro" ? "Intro" : reviewSection === "afirm" ? "Afirmaciones" : "Meditación"}
          </span>
          <span className="text-xs text-muted" style={{ marginLeft: "auto" }}>
            {reviewSection === "intro" && (hasAfirm || hasMedit)
              ? "Las siguientes secciones se generarán después"
              : reviewSection === "afirm" && hasMedit
              ? "La meditación se generará después"
              : ""}
          </span>
        </div>
      )}

      {/* Sección Intro */}
      {hasIntro && (
        <SectionReview
          section="intro"
          label="Intro"
          items={introBloques}
          audios={introAudios}
          decisions={introDecisions}
          onDecision={onDecision}
          onFinalize={onFinalize}
          jobStatus={jobStatus}
          isActive={reviewSection === "intro"}
          regeneratingItems={introRegenerating}
        />
      )}

      {/* Divisor intro → afirm */}
      {hasIntro && hasAfirm && (
        <div className="section-divider" style={{ margin: "8px 0 28px" }}>
          Afirmaciones
        </div>
      )}

      {/* Sección Afirmaciones */}
      {hasAfirm && (
        <SectionReview
          section="afirm"
          label="Afirmaciones"
          items={afirmaciones}
          audios={afirmAudios}
          decisions={afirmDecisions}
          onDecision={onDecision}
          onFinalize={onFinalize}
          jobStatus={jobStatus}
          isActive={reviewSection === "afirm"}
          regeneratingItems={afirmRegenerating}
        />
      )}

      {/* Divisor afirm → medit */}
      {(hasIntro || hasAfirm) && hasMedit && (
        <div className="section-divider" style={{ margin: "8px 0 28px" }}>
          Meditación
        </div>
      )}

      {/* Sección Meditación */}
      {hasMedit && (
        <SectionReview
          section="medit"
          label="Meditación"
          items={meditaciones}
          audios={meditAudios}
          decisions={meditDecisions}
          onDecision={onDecision}
          onFinalize={onFinalize}
          jobStatus={jobStatus}
          isActive={reviewSection === "medit"}
          regeneratingItems={meditRegenerating}
        />
      )}
    </div>
  )
}
