import { useState, useEffect, useRef, useCallback } from "react"

const API       = import.meta.env.VITE_API_URL || "http://localhost:8000"
const TARGET_SR = 48000
const COLOR_ES  = "#00e676"
const COLOR_EN  = "#ff6d00"
const COLOR_SY  = "#a78bfa"
const TRACK_H   = 128
const RULER_H   = 30

// ─────────────────────────────────────────────────────────────────────────────
//  PURE AUDIO ALGORITHMS
// ─────────────────────────────────────────────────────────────────────────────

function resample(buf, fromSr, toSr) {
  if (fromSr === toSr) return buf
  const ratio  = fromSr / toSr
  const outLen = Math.ceil(buf.length / ratio)
  const out    = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const lo  = Math.floor(pos)
    const hi  = Math.min(lo + 1, buf.length - 1)
    const f   = pos - lo
    out[i] = buf[lo] * (1 - f) + buf[hi] * f
  }
  return out
}

/**
 * Build synchronized EN audio aligned to ES sentence boundaries.
 *
 * For each sentence pair (es[i], en[i]):
 *   1. Insert ES inter-sentence silence (keeps natural ES rhythm)
 *   2. Insert EN speech content
 *   3. If EN sentence is shorter than ES: pad with silence to fill the gap
 *   4. If EN sentence is longer: no modification — it eats into next pause
 */
function buildSyncedFromSentences(esBuffer, esSr, enBuffer, enSr, esSents, enSents) {
  const en = resample(enBuffer, enSr, TARGET_SR)
  const n  = Math.min(esSents.length, enSents.length)
  if (n === 0) return { buffer: new Float32Array(0), padded: 0, overflow: 0 }

  const chunks = []
  let padded = 0, overflow = 0

  for (let i = 0; i < n; i++) {
    const esS = esSents[i]
    const enS = enSents[i]

    // 1. Leading silence (inter-sentence gap from ES)
    const prevEnd = i > 0 ? esSents[i - 1].end : 0
    const lead    = Math.max(0, esS.start - prevEnd)
    if (lead > 0.002) chunks.push(new Float32Array(Math.round(lead * TARGET_SR)))

    // 2. EN speech content for this sentence
    const s0 = Math.max(0, Math.round(enS.start * TARGET_SR))
    const s1 = Math.min(Math.round(enS.end * TARGET_SR), en.length)
    if (s1 > s0) chunks.push(en.subarray(s0, s1))

    // 3. Alignment padding
    const esDur = esS.end - esS.start
    const enDur = enS.end - enS.start
    const pad   = esDur - enDur
    if (pad > 0.01) {
      chunks.push(new Float32Array(Math.round(pad * TARGET_SR)))
      padded++
    } else if (pad < -0.01) {
      overflow++
    }
  }

  // 4. Trailing silence (maintain total ES duration feel)
  const esTotalDur = esBuffer.length / esSr
  const trailing   = esTotalDur - esSents[n - 1].end
  if (trailing > 0.01) chunks.push(new Float32Array(Math.round(trailing * TARGET_SR)))

  const totalLen = chunks.reduce((s, c) => s + c.length, 0)
  const out      = new Float32Array(totalLen)
  let pos = 0
  for (const c of chunks) { out.set(c, pos); pos += c.length }
  return { buffer: out, padded, overflow }
}

function encodeWAV24(buffer, sampleRate) {
  const data = buffer.length * 3
  const ab   = new ArrayBuffer(44 + data)
  const v    = new DataView(ab)
  const s    = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)) }
  s(0, "RIFF"); v.setUint32(4, 36 + data, true); s(8, "WAVE"); s(12, "fmt ")
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 3, true)
  v.setUint16(32, 3, true); v.setUint16(34, 24, true); s(36, "data"); v.setUint32(40, data, true)
  let off = 44
  for (let i = 0; i < buffer.length; i++) {
    const sample = Math.max(-1, Math.min(1, buffer[i]))
    const val    = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF)
    v.setUint8(off++, val & 0xFF); v.setUint8(off++, (val >> 8) & 0xFF); v.setUint8(off++, (val >> 16) & 0xFF)
  }
  return ab
}

// ─────────────────────────────────────────────────────────────────────────────
//  CANVAS RENDERERS
// ─────────────────────────────────────────────────────────────────────────────

function renderRuler(canvas, zoom, viewStart) {
  const ctx = canvas.getContext("2d")
  const W = canvas.width, H = canvas.height
  ctx.fillStyle = "#07090f"
  ctx.fillRect(0, 0, W, H)

  const intervals = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]
  const interval  = intervals.find(iv => iv * zoom >= 60) || 300
  const subIv     = interval / 4
  const tStart    = Math.floor(viewStart / interval) * interval
  const tEnd      = viewStart + W / zoom + interval

  ctx.font = "10px 'JetBrains Mono','Courier New',monospace"
  ctx.textAlign = "center"

  for (let t = tStart; t <= tEnd; t = Math.round((t + subIv) * 10000) / 10000) {
    const x      = Math.round((t - viewStart) * zoom)
    if (x < -2 || x > W + 2) continue
    const isMajor = Math.abs(Math.round(t / interval) * interval - t) < 0.0001

    if (isMajor) {
      ctx.strokeStyle = "rgba(255,255,255,0.25)"
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x + 0.5, H - 9); ctx.lineTo(x + 0.5, H); ctx.stroke()
      const mins  = Math.floor(t / 60)
      const secs  = t % 60
      const label = mins > 0
        ? `${mins}:${String(Math.floor(secs)).padStart(2, "0")}`
        : `${secs.toFixed(secs < 10 && interval < 1 ? 1 : 0)}s`
      ctx.fillStyle = "rgba(180,200,220,0.5)"
      ctx.fillText(label, x, H - 12)
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.09)"
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x + 0.5, H - 5); ctx.lineTo(x + 0.5, H); ctx.stroke()
    }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.05)"
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke()
}

/**
 * sentences: [{start, end, text}] in seconds.
 * Voice regions (sentence spans) are rendered brighter; silence darker.
 * Sentence boundary lines and numbers are drawn when zoom is sufficient.
 */
function renderTrack(canvas, buffer, sampleRate, sentences, zoom, viewStart, playhead, color, emptyMsg) {
  const ctx = canvas.getContext("2d")
  const W = canvas.width, H = canvas.height
  ctx.fillStyle = "#07090f"
  ctx.fillRect(0, 0, W, H)

  if (!buffer || buffer.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.07)"
    ctx.font = "11px 'JetBrains Mono',monospace"
    ctx.textAlign = "center"
    ctx.fillText(emptyMsg, W / 2, H / 2)
    return
  }

  const dur = buffer.length / sampleRate

  // Silence overlay between sentence spans
  if (sentences && sentences.length > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.42)"
    const s0 = sentences[0], sLast = sentences[sentences.length - 1]

    const xFirst = (s0.start - viewStart) * zoom
    if (xFirst > 0) ctx.fillRect(0, 0, Math.min(xFirst, W), H)

    for (let i = 0; i < sentences.length - 1; i++) {
      const xA = (sentences[i].end       - viewStart) * zoom
      const xB = (sentences[i + 1].start - viewStart) * zoom
      if (xB > 0 && xA < W) ctx.fillRect(Math.max(0, xA), 0, Math.min(xB, W) - Math.max(0, xA), H)
    }

    const xEnd = (sLast.end - viewStart) * zoom
    if (xEnd < W) ctx.fillRect(Math.max(0, xEnd), 0, W - Math.max(0, xEnd), H)
  }

  // Waveform
  ctx.beginPath()
  ctx.strokeStyle = color
  ctx.lineWidth   = 1
  for (let x = 0; x < W; x++) {
    const t0  = viewStart + x / zoom
    const t1  = viewStart + (x + 1) / zoom
    if (t0 > dur) break
    const s0  = Math.floor(t0 * sampleRate)
    const s1  = Math.min(Math.ceil(t1 * sampleRate), buffer.length)
    const str = Math.max(1, Math.floor((s1 - s0) / 200))
    let mn = 0, mx = 0
    for (let s = s0; s < s1; s += str) {
      if (buffer[s] < mn) mn = buffer[s]
      if (buffer[s] > mx) mx = buffer[s]
    }
    const pad  = 4
    const yMax = H / 2 - mx * (H / 2 - pad)
    const yMin = H / 2 - mn * (H / 2 - pad)
    ctx.moveTo(x + 0.5, yMax)
    ctx.lineTo(x + 0.5, yMin)
  }
  ctx.stroke()

  // Center line
  ctx.strokeStyle = "rgba(255,255,255,0.04)"
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke()

  // Sentence boundaries + numbers
  if (sentences && sentences.length > 0) {
    ctx.setLineDash([2, 4])
    ctx.lineWidth = 1
    sentences.forEach((sent, i) => {
      [sent.start, sent.end].forEach(t => {
        const x = (t - viewStart) * zoom
        if (x < 0 || x > W) return
        ctx.strokeStyle = color + "50"
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      })
      const xm = ((sent.start + sent.end) / 2 - viewStart) * zoom
      if (xm > 4 && xm < W - 4) {
        ctx.setLineDash([])
        ctx.font = "bold 10px monospace"
        ctx.textAlign = "center"
        ctx.fillStyle = color + "99"
        ctx.fillText(String(i + 1), xm, 12)
        ctx.setLineDash([2, 4])
      }
    })
    ctx.setLineDash([])
  }

  // Playhead
  const visEnd = viewStart + W / zoom
  if (playhead >= viewStart && playhead <= visEnd) {
    const xph = (playhead - viewStart) * zoom
    ctx.strokeStyle = "#ffffffcc"
    ctx.lineWidth   = 1.5
    ctx.setLineDash([])
    ctx.beginPath(); ctx.moveTo(xph, 0); ctx.lineTo(xph, H); ctx.stroke()
    ctx.fillStyle = "#fff"
    ctx.beginPath()
    ctx.moveTo(xph - 4, 0); ctx.lineTo(xph + 4, 0); ctx.lineTo(xph, 7)
    ctx.closePath(); ctx.fill()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SVG ICONS
// ─────────────────────────────────────────────────────────────────────────────

const IcPlay   = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
const IcPause  = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
const IcStop   = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>
const IcZoomIn = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35M11 8v6M8 11h6"/></svg>
const IcZoomOut= () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35M8 11h6"/></svg>
const IcFit    = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
const IcSync   = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
const IcExport = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
const IcMic    = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/></svg>
const IcUpload = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>

function IcSpinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="as-spinner">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPLOAD ZONE
// ─────────────────────────────────────────────────────────────────────────────

function UploadZone({ color, trackId, name, loading, onUpload }) {
  const inputRef = useRef(null)
  const label    = trackId === "es" ? "Audio ES" : "Audio EN"
  const sub      = trackId === "es" ? "Referencia de tiempos" : "Audio a sincronizar"

  const handleDrop = (e) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) onUpload(f)
  }

  return (
    <div
      className="as-upload-zone"
      style={{ borderColor: color + "45", background: color + "0b" }}
      onClick={() => inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      role="button" tabIndex={0}
      onKeyDown={e => e.key === "Enter" && inputRef.current?.click()}
      aria-label={`Cargar ${label}`}
    >
      <input
        ref={inputRef} type="file" accept="audio/*" style={{ display: "none" }}
        onChange={e => { if (e.target.files[0]) onUpload(e.target.files[0]); e.target.value = "" }}
      />
      <span style={{ color, flexShrink: 0 }}>
        {loading ? <IcSpinner /> : <IcUpload />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color, marginBottom: 1 }}>{label}</div>
        <div style={{ fontSize: "0.62rem", color: "rgba(255,255,255,0.38)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name ? (name.length > 22 ? "…" + name.slice(-20) : name) : sub}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  SENTENCE LIST (sidebar panel per track)
// ─────────────────────────────────────────────────────────────────────────────

function TransPanel({ color, trackId, trans, hasFile, onTranscribe }) {
  const label = trackId === "es" ? "ES" : "EN"

  return (
    <div className="as-trans-block" style={{ borderColor: color + "30" }}>
      <div className="as-trans-head">
        <span className="as-trans-badge" style={{ color, borderColor: color + "45" }}>{label}</span>
        <span className="as-trans-info">
          {trans.status === "idle"    && <span>—</span>}
          {trans.status === "loading" && <span style={{ color: "#f0c040" }}>Transcribiendo…</span>}
          {trans.status === "done"    && <span style={{ color }}>{trans.sentences.length} oraciones</span>}
          {trans.status === "error"   && <span style={{ color: "#ef5350" }}>Error</span>}
        </span>
        <button
          className="as-trans-btn"
          onClick={() => onTranscribe(trackId)}
          disabled={!hasFile || trans.status === "loading"}
        >
          {trans.status === "loading" ? <IcSpinner /> : trans.status === "done" ? "Re-scan" : "Transcribir"}
        </button>
      </div>

      {trans.status === "done" && trans.sentences.length > 0 && (
        <div className="as-sent-list">
          {trans.sentences.map((s, i) => (
            <div key={i} className="as-sent-item">
              <span className="as-sent-num" style={{ color }}>{i + 1}</span>
              <span className="as-sent-time">{s.start.toFixed(1)}s</span>
              <span className="as-sent-text">{s.text.length > 38 ? s.text.slice(0, 36) + "…" : s.text}</span>
            </div>
          ))}
        </div>
      )}

      {trans.status === "error" && (
        <div className="as-trans-error">{trans.error}</div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const IDLE_TRANS = { status: "idle", sentences: [], text: "", error: "" }

export default function AudioSyncModule() {

  // ── Heavy buffers in refs (Float32Arrays — never in React state) ─────────
  const esBufferRef     = useRef(null)
  const enBufferRef     = useRef(null)
  const syncedBufferRef = useRef(null)
  const esSrRef         = useRef(44100)
  const enSrRef         = useRef(44100)
  const esFileRef       = useRef(null)   // kept for re-transcription
  const enFileRef       = useRef(null)

  // ── Canvas + playback refs ───────────────────────────────────────────────
  const rulerRef     = useRef(null)
  const esCanvasRef  = useRef(null)
  const enCanvasRef  = useRef(null)
  const workspaceRef = useRef(null)
  const scrollRef    = useRef(null)
  const audioCtxRef  = useRef(null)
  const sourceRef    = useRef(null)
  const startTimeRef = useRef(0)
  const startPosRef  = useRef(0)
  const rafRef       = useRef(null)

  // ── Mutable mirrors (for rAF closures that outlive renders) ─────────────
  const playheadRef  = useRef(0)
  const viewStartRef = useRef(0)
  const zoomRef      = useRef(100)
  const isPlayRef    = useRef(false)
  const activeRef    = useRef("both")
  const transESRef   = useRef(IDLE_TRANS)
  const transENRef   = useRef(IDLE_TRANS)

  // ── React state ──────────────────────────────────────────────────────────
  const [esName,    setEsName]    = useState(null)
  const [enName,    setEnName]    = useState(null)
  const [esLoading, setEsLoading] = useState(false)
  const [enLoading, setEnLoading] = useState(false)
  const [transES,   setTransES]   = useState(IDLE_TRANS)
  const [transEN,   setTransEN]   = useState(IDLE_TRANS)
  const [zoom,      setZoom]      = useState(100)
  const [viewStart, setViewStart] = useState(0)
  const [playhead,  setPlayhead]  = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [active,    setActive]    = useState("both")
  const [statusMsg, setStatusMsg] = useState("Carga los dos archivos de audio para comenzar")
  const [stats,     setStats]     = useState(null)
  const [canvasW,   setCanvasW]   = useState(800)

  // Keep mutable refs in sync with state
  useEffect(() => { playheadRef.current  = playhead  }, [playhead])
  useEffect(() => { viewStartRef.current = viewStart }, [viewStart])
  useEffect(() => { zoomRef.current      = zoom      }, [zoom])
  useEffect(() => { isPlayRef.current    = isPlaying }, [isPlaying])
  useEffect(() => { activeRef.current    = active    }, [active])
  useEffect(() => { transESRef.current   = transES   }, [transES])
  useEffect(() => { transENRef.current   = transEN   }, [transEN])

  // ── Canvas resize ────────────────────────────────────────────────────────
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        const w = Math.floor(e.contentRect.width)
        if (w > 0) setCanvasW(w)
      }
    })
    if (workspaceRef.current) obs.observe(workspaceRef.current)
    return () => obs.disconnect()
  }, [])

  // ── renderAll ────────────────────────────────────────────────────────────
  const renderAll = useCallback(() => {
    const z  = zoomRef.current
    const vs = viewStartRef.current
    const ph = playheadRef.current

    if (rulerRef.current)   renderRuler(rulerRef.current, z, vs)

    if (esCanvasRef.current) {
      renderTrack(
        esCanvasRef.current,
        esBufferRef.current, esSrRef.current,
        transESRef.current.sentences,
        z, vs, ph, COLOR_ES, "Carga audio ES →"
      )
    }

    if (enCanvasRef.current) {
      const isSync = activeRef.current === "synced"
      renderTrack(
        enCanvasRef.current,
        isSync ? syncedBufferRef.current : enBufferRef.current,
        isSync ? TARGET_SR               : enSrRef.current,
        isSync ? transESRef.current.sentences : transENRef.current.sentences,
        z, vs, ph,
        isSync ? COLOR_SY : COLOR_EN,
        "Carga audio EN →"
      )
    }
  }, [])

  useEffect(() => { renderAll() }, [canvasW, zoom, viewStart, transES, transEN, active, renderAll])

  // ── Audio decode ─────────────────────────────────────────────────────────
  const decodeFile = async (file) => {
    const ab      = await file.arrayBuffer()
    const ctx     = new AudioContext()
    const decoded = await ctx.decodeAudioData(ab)
    ctx.close()
    return {
      buffer:     new Float32Array(decoded.getChannelData(0)),
      sampleRate: decoded.sampleRate,
    }
  }

  // ── File upload handlers ─────────────────────────────────────────────────
  const handleESUpload = async (file) => {
    setEsLoading(true)
    setStatusMsg("Decodificando ES…")
    setTransES(IDLE_TRANS)
    esFileRef.current = file
    try {
      const { buffer, sampleRate } = await decodeFile(file)
      esBufferRef.current = buffer
      esSrRef.current     = sampleRate
      setEsName(file.name)
      setStatusMsg(`ES cargado · ${(buffer.length / sampleRate).toFixed(1)}s · ${(sampleRate / 1000).toFixed(0)}kHz — haz clic en "Transcribir"`)
    } catch (e) {
      setStatusMsg("Error decodificando ES: " + e.message)
    } finally {
      setEsLoading(false)
    }
  }

  const handleENUpload = async (file) => {
    setEnLoading(true)
    setStatusMsg("Decodificando EN…")
    setTransEN(IDLE_TRANS)
    enFileRef.current = file
    try {
      const { buffer, sampleRate } = await decodeFile(file)
      enBufferRef.current = buffer
      enSrRef.current     = sampleRate
      setEnName(file.name)
      setStatusMsg(`EN cargado · ${(buffer.length / sampleRate).toFixed(1)}s · ${(sampleRate / 1000).toFixed(0)}kHz — haz clic en "Transcribir"`)
    } catch (e) {
      setStatusMsg("Error decodificando EN: " + e.message)
    } finally {
      setEnLoading(false)
    }
  }

  // ── Transcription ────────────────────────────────────────────────────────
  const handleTranscribe = async (lang) => {
    const file   = lang === "es" ? esFileRef.current : enFileRef.current
    const setter = lang === "es" ? setTransES : setTransEN
    if (!file) return

    setter({ status: "loading", sentences: [], text: "", error: "" })
    setStatusMsg(`Transcribiendo ${lang.toUpperCase()} con Whisper… (puede tardar ~30 s)`)

    const token = localStorage.getItem("studio_token")
    const form  = new FormData()
    form.append("file", file)
    form.append("language", lang)

    try {
      const res = await fetch(`${API}/api/audiosync/transcribe`, {
        method: "POST",
        body:   form,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setter({ status: "done", sentences: data.sentences, text: data.text, error: "" })
      setStatusMsg(`${lang.toUpperCase()} transcrito · ${data.sentences.length} oraciones detectadas`)
    } catch (e) {
      setter({ status: "error", sentences: [], text: "", error: e.message })
      setStatusMsg(`Error transcribiendo ${lang.toUpperCase()}: ${e.message}`)
    }
  }

  // ── Synchronize ──────────────────────────────────────────────────────────
  const handleSync = useCallback(() => {
    if (!esBufferRef.current || !enBufferRef.current) {
      setStatusMsg("Carga ambos audios primero"); return
    }
    const esS = transESRef.current.sentences
    const enS = transENRef.current.sentences
    if (esS.length === 0 || enS.length === 0) {
      setStatusMsg("Transcribe ambos audios antes de sincronizar"); return
    }

    setStatusMsg("Construyendo audio sincronizado…")
    setTimeout(() => {
      try {
        const { buffer: synced, padded, overflow } = buildSyncedFromSentences(
          esBufferRef.current, esSrRef.current,
          enBufferRef.current, enSrRef.current,
          esS, enS,
        )
        syncedBufferRef.current = synced
        const n     = Math.min(esS.length, enS.length)
        const dur   = (synced.length / TARGET_SR).toFixed(2)
        const durES = (esBufferRef.current.length / esSrRef.current).toFixed(1)
        const durEN = (enBufferRef.current.length / enSrRef.current).toFixed(1)
        setStats({ n, padded, overflow, durES, durEN, durSync: dur, skipped: Math.abs(esS.length - enS.length) })
        setActive("synced")
        setStatusMsg(`Sincronizado · ${n} oraciones · ${padded} rellenos · ${overflow} desbordamientos · ${dur}s`)
        renderAll()
      } catch (e) {
        setStatusMsg("Error sincronizando: " + e.message)
      }
    }, 0)
  }, [renderAll])

  // ── Playback ─────────────────────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (sourceRef.current)   { try { sourceRef.current.stop() } catch {} sourceRef.current = null }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null }
    if (rafRef.current)      { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    setIsPlaying(false)
  }, [])

  const startPlayback = useCallback(() => {
    const isSync = activeRef.current === "synced"
    const buf = isSync ? syncedBufferRef.current : esBufferRef.current
    const sr  = isSync ? TARGET_SR : esSrRef.current
    if (!buf) return

    const ctx  = new AudioContext()
    audioCtxRef.current = ctx
    const abuf = ctx.createBuffer(1, buf.length, sr)
    abuf.copyToChannel(buf, 0)
    const src  = ctx.createBufferSource()
    src.buffer = abuf
    src.connect(ctx.destination)
    src.onended = () => { if (isPlayRef.current) stopPlayback() }

    const offset = Math.max(0, Math.min(playheadRef.current, buf.length / sr - 0.01))
    src.start(0, offset)
    sourceRef.current    = src
    startTimeRef.current = ctx.currentTime
    startPosRef.current  = offset
    setIsPlaying(true)

    const duration = buf.length / sr
    const tick = () => {
      if (!audioCtxRef.current) return
      const pos = startPosRef.current + (audioCtxRef.current.currentTime - startTimeRef.current)
      if (pos >= duration) { stopPlayback(); setPlayhead(0); playheadRef.current = 0; renderAll(); return }

      playheadRef.current = pos
      setPlayhead(pos)

      const w   = esCanvasRef.current?.width || 800
      const vis = w / zoomRef.current
      const vs  = viewStartRef.current
      if (pos > vs + vis * 0.8) {
        const nv = pos - vis * 0.2
        viewStartRef.current = nv; setViewStart(nv)
      }
      renderAll()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stopPlayback, renderAll])

  const handlePlayPause = () => isPlaying ? stopPlayback() : startPlayback()

  // ── Export ───────────────────────────────────────────────────────────────
  const handleExport = () => {
    if (!syncedBufferRef.current) { setStatusMsg("Sincroniza primero"); return }
    const wav  = encodeWAV24(syncedBufferRef.current, TARGET_SR)
    const blob = new Blob([wav], { type: "audio/wav" })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement("a"), { href: url, download: "audio_synced_48k_24bit.wav" })
    a.click(); URL.revokeObjectURL(url)
    setStatusMsg("Exportado: audio_synced_48k_24bit.wav  (PCM 24-bit / 48 kHz)")
  }

  // ── Zoom ─────────────────────────────────────────────────────────────────
  const handleZoomIn  = () => setZoom(z => Math.min(z * 1.5, 3000))
  const handleZoomOut = () => setZoom(z => Math.max(z / 1.5, 4))
  const handleFit     = () => {
    const buf = esBufferRef.current || enBufferRef.current
    if (!buf) return
    const dur = buf.length / (esBufferRef.current ? esSrRef.current : enSrRef.current)
    const w   = workspaceRef.current?.offsetWidth || 800
    setZoom((w - 4) / dur)
    setViewStart(0)
  }

  // ── Canvas interactions ──────────────────────────────────────────────────
  const handleCanvasClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const t    = Math.max(0, viewStart + (e.clientX - rect.left) / zoom)
    playheadRef.current = t; setPlayhead(t)
    if (isPlaying) { stopPlayback(); startPosRef.current = t; setTimeout(startPlayback, 30) }
    else renderAll()
  }

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const rect      = e.currentTarget.getBoundingClientRect()
    const xRel      = e.clientX - rect.left
    const tAtCursor = viewStartRef.current + xRel / zoomRef.current
    const factor    = e.deltaY < 0 ? 1.22 : 1 / 1.22
    const nz        = Math.max(4, Math.min(3000, zoomRef.current * factor))
    const nv        = Math.max(0, tAtCursor - xRel / nz)
    zoomRef.current = nz; viewStartRef.current = nv
    setZoom(nz); setViewStart(nv)
  }, [])

  // ── Scrollbar drag ───────────────────────────────────────────────────────
  const getMaxDur = () => {
    const es = esBufferRef.current ? esBufferRef.current.length / esSrRef.current : 0
    const en = enBufferRef.current ? enBufferRef.current.length / enSrRef.current : 0
    const sy = syncedBufferRef.current ? syncedBufferRef.current.length / TARGET_SR : 0
    return Math.max(es, en, sy, 10)
  }
  const scrollDrag = useRef(false)
  const moveScroll = (clientX) => {
    const rect = scrollRef.current?.getBoundingClientRect()
    if (!rect) return
    const ratio   = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const dur     = getMaxDur()
    const visible = canvasW / zoomRef.current
    const maxVS   = Math.max(0, dur - visible)
    const nv      = ratio * maxVS
    viewStartRef.current = nv; setViewStart(nv)
  }
  useEffect(() => {
    const onMove = (e) => { if (scrollDrag.current) moveScroll(e.clientX) }
    const onUp   = ()  => { scrollDrag.current = false }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup",   onUp)
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived ──────────────────────────────────────────────────────────────
  const totalDur   = getMaxDur()
  const visibleDur = canvasW / zoom
  const thumbW     = Math.max(6, Math.min(100, (visibleDur / totalDur) * 100))
  const thumbL     = totalDur > visibleDur ? (viewStart / (totalDur - visibleDur)) * (100 - thumbW) : 0

  const formatTC = (s) => {
    const m  = Math.floor(s / 60)
    const sc = s % 60
    return `${String(m).padStart(2, "0")}:${String(Math.floor(sc)).padStart(2, "0")}.${String(Math.floor((sc % 1) * 100)).padStart(2, "0")}`
  }

  const canSync   = transES.status === "done" && transEN.status === "done"
  const canExport = !!syncedBufferRef.current

  // ─────────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="as-root">

      {/* ── TOPBAR ──────────────────────────────────────── */}
      <div className="as-topbar">
        <div className="as-topbar-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLOR_ES} strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 12h3M5 8v8M8 5v14M11 9v6M14 6v12M17 9v6M20 8v8"/>
          </svg>
          <span className="as-topbar-name">AudioSync</span>
          <span className="as-topbar-sep">·</span>
          <span style={{ fontSize: "0.72rem", color: "rgba(255,255,255,0.35)" }}>
            Sincronización por oraciones ES → EN
          </span>
        </div>
        <div className="as-topbar-right">
          <span className="as-timecode">{formatTC(playhead)}</span>
          <span className="as-zoom-badge">{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)} px/s</span>
          <span className="as-sr-badge">48 kHz · 24-bit</span>
        </div>
      </div>

      {/* ── TOOLBAR ─────────────────────────────────────── */}
      <div className="as-toolbar">

        <div className="as-toolbar-group">
          <button
            className={`as-btn${isPlaying ? " as-btn--play-active" : ""}`}
            onClick={handlePlayPause} title={isPlaying ? "Pausar" : "Reproducir"}
          >
            {isPlaying ? <IcPause /> : <IcPlay />}
            <span>{isPlaying ? "PAUSA" : "PLAY"}</span>
          </button>
          <button className="as-btn" onClick={stopPlayback} title="Detener">
            <IcStop /><span>STOP</span>
          </button>
        </div>

        <div className="as-toolbar-sep" />

        <div className="as-toolbar-group">
          <button className="as-btn" onClick={handleZoomIn}><IcZoomIn /><span>ZOOM+</span></button>
          <button className="as-btn" onClick={handleZoomOut}><IcZoomOut /><span>ZOOM-</span></button>
          <button className="as-btn" onClick={handleFit}><IcFit /><span>FIT</span></button>
        </div>

        <div className="as-toolbar-sep" />

        <div className="as-toolbar-group">
          <button
            className="as-btn as-btn--accent"
            onClick={handleSync} disabled={!canSync}
            title={canSync ? "Sincronizar por oraciones" : "Transcribe ambos audios primero"}
          >
            <IcSync /><span>SINCRONIZAR</span>
          </button>
          <button
            className="as-btn as-btn--export"
            onClick={handleExport} disabled={!canExport}
          >
            <IcExport /><span>EXPORTAR WAV</span>
          </button>
        </div>

        <div style={{ flex: 1 }} />

        <div className="as-toolbar-group">
          <button
            className={`as-btn as-btn--track${active === "both" ? " as-btn--track-active" : ""}`}
            onClick={() => setActive("both")}
          >
            <span className="as-track-dot" style={{ background: COLOR_ES }} />
            <span className="as-track-dot" style={{ background: COLOR_EN }} />
            <span>ES+EN</span>
          </button>
          {canExport && (
            <button
              className={`as-btn as-btn--track${active === "synced" ? " as-btn--track-active" : ""}`}
              onClick={() => setActive("synced")}
            >
              <span className="as-track-dot" style={{ background: COLOR_SY }} />
              <span>SYNCED</span>
            </button>
          )}
        </div>

      </div>

      {/* ── BODY ────────────────────────────────────────── */}
      <div className="as-body">

        {/* ── SIDEBAR ─────────────────────────────────── */}
        <div className="as-sidebar">

          <div className="as-sidebar-section">
            <div className="as-sidebar-title">Archivos</div>
            <UploadZone color={COLOR_ES} trackId="es" name={esName} loading={esLoading} onUpload={handleESUpload} />
            <UploadZone color={COLOR_EN} trackId="en" name={enName} loading={enLoading} onUpload={handleENUpload} />
          </div>

          <div className="as-sidebar-section">
            <div className="as-sidebar-title">Transcripción</div>
            <TransPanel color={COLOR_ES} trackId="es" trans={transES} hasFile={!!esName} onTranscribe={handleTranscribe} />
            <TransPanel color={COLOR_EN} trackId="en" trans={transEN} hasFile={!!enName} onTranscribe={handleTranscribe} />
            <div className="as-trans-hint">
              Whisper detecta automáticamente cada oración y sus tiempos.
              El EN se alineará oración por oración al ritmo del ES.
            </div>
          </div>

          {stats && (
            <div className="as-sidebar-section">
              <div className="as-sidebar-title">Resultado</div>
              <div className="as-stat-list">
                <div className="as-stat-row"><span>Oraciones</span><span>{stats.n}</span></div>
                <div className="as-stat-row"><span>Rellenos</span>
                  <span style={{ color: stats.padded > 0 ? "#f0c040" : "inherit" }}>{stats.padded}</span>
                </div>
                <div className="as-stat-row"><span>EN más largo</span>
                  <span style={{ color: stats.overflow > 0 ? "#ef5350" : "inherit" }}>{stats.overflow}</span>
                </div>
                {stats.skipped > 0 && (
                  <div className="as-stat-row" style={{ color: "#f0c040" }}>
                    <span>Saltados</span><span>{stats.skipped}</span>
                  </div>
                )}
                <div className="as-stat-row"><span>Dur. ES</span><span>{stats.durES}s</span></div>
                <div className="as-stat-row"><span>Dur. EN orig.</span><span>{stats.durEN}s</span></div>
                <div className="as-stat-row"><span>Dur. SYNCED</span>
                  <span style={{ color: COLOR_SY }}>{stats.durSync}s</span>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* ── WORKSPACE ───────────────────────────────── */}
        <div className="as-workspace-wrap">
          <div className="as-workspace" ref={workspaceRef}>

            <canvas ref={rulerRef} className="as-ruler-canvas" width={canvasW} height={RULER_H} />

            {/* ES track */}
            <div className="as-track-row">
              <div className="as-track-label" style={{ borderRightColor: COLOR_ES + "40" }}>
                <span style={{ color: COLOR_ES, fontWeight: 700 }}>ES</span>
                <span style={{ fontSize: "0.6rem", color: "rgba(255,255,255,0.3)" }}>
                  {transES.status === "done" ? `${transES.sentences.length} or.` : "—"}
                </span>
              </div>
              <canvas
                ref={esCanvasRef} className="as-track-canvas" width={canvasW} height={TRACK_H}
                onClick={handleCanvasClick} onWheel={handleWheel}
              />
            </div>

            <div className="as-track-divider">
              <span className="as-track-divider-label">
                {active === "synced"
                  ? <><span style={{ color: COLOR_SY }}>●</span> SYNCED — EN alineado a ritmo de ES</>
                  : <><span style={{ color: COLOR_EN }}>●</span> EN</>
                }
              </span>
            </div>

            {/* EN / Synced track */}
            <div className="as-track-row">
              <div className="as-track-label" style={{ borderRightColor: (active === "synced" ? COLOR_SY : COLOR_EN) + "40" }}>
                <span style={{ color: active === "synced" ? COLOR_SY : COLOR_EN, fontWeight: 700 }}>
                  {active === "synced" ? "SY" : "EN"}
                </span>
                <span style={{ fontSize: "0.6rem", color: "rgba(255,255,255,0.3)" }}>
                  {active === "synced"
                    ? (stats ? `${stats.n} or.` : "—")
                    : (transEN.status === "done" ? `${transEN.sentences.length} or.` : "—")
                  }
                </span>
              </div>
              <canvas
                ref={enCanvasRef} className="as-track-canvas" width={canvasW} height={TRACK_H}
                onClick={handleCanvasClick} onWheel={handleWheel}
              />
            </div>

            {/* Scrollbar */}
            <div
              className="as-scrollbar" ref={scrollRef}
              onMouseDown={e => { scrollDrag.current = true; e.preventDefault(); moveScroll(e.clientX) }}
            >
              <div className="as-scrollbar-thumb" style={{ left: `${thumbL}%`, width: `${thumbW}%` }} />
            </div>

          </div>
        </div>

      </div>

      {/* ── STATUSBAR ───────────────────────────────────── */}
      <div className="as-statusbar">
        <span className="as-status-msg">{statusMsg}</span>
        <div className="as-status-meta">
          {esBufferRef.current && (
            <span>ES: {(esBufferRef.current.length / esSrRef.current).toFixed(1)}s</span>
          )}
          {enBufferRef.current && (
            <span>EN: {(enBufferRef.current.length / enSrRef.current).toFixed(1)}s</span>
          )}
          <span>Salida: 48 kHz · 24-bit · mono</span>
        </div>
      </div>

    </div>
  )
}
