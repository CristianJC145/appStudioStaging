import { useState, useEffect, useRef, useCallback } from "react"

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const TARGET_SR   = 48000
const COLOR_ES    = "#00e676"
const COLOR_EN    = "#ff6d00"
const COLOR_SYNC  = "#a78bfa"
const TRACK_H     = 130
const RULER_H     = 32
const SCROLL_H    = 14

// ─────────────────────────────────────────────────────────────────────────────
//  AUDIO ALGORITHMS (pure functions, no React)
// ─────────────────────────────────────────────────────────────────────────────

function dbToLinear(db) { return Math.pow(10, db / 20) }

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

function detectVoiceSegments(buffer, sampleRate, thresholdDb, minSilenceMs, paddingMs) {
  const threshold   = dbToLinear(thresholdDb)
  const winSamps    = Math.max(1, Math.floor(sampleRate * 0.01))  // 10ms
  const minSilSamps = Math.floor(sampleRate * minSilenceMs / 1000)
  const padSamps    = Math.floor(sampleRate * paddingMs / 1000)
  const numWins     = Math.ceil(buffer.length / winSamps)

  // Classify each 10ms window as voice or silence
  const voiced = new Uint8Array(numWins)
  for (let w = 0; w < numWins; w++) {
    const s0 = w * winSamps
    const s1 = Math.min(s0 + winSamps, buffer.length)
    let sum = 0
    for (let i = s0; i < s1; i++) sum += buffer[i] * buffer[i]
    voiced[w] = Math.sqrt(sum / (s1 - s0)) >= threshold ? 1 : 0
  }

  // Build raw voice regions
  const raw = []
  let inVoice = false, rStart = 0
  for (let w = 0; w < numWins; w++) {
    if (voiced[w] && !inVoice)  { inVoice = true;  rStart = w }
    if (!voiced[w] && inVoice)  { inVoice = false; raw.push([rStart, w - 1]) }
  }
  if (inVoice) raw.push([rStart, numWins - 1])
  if (raw.length === 0) return []

  // Merge regions with short silence gaps between them
  const merged = [[...raw[0]]]
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1]
    const gap  = (raw[i][0] - prev[1] - 1) * winSamps
    if (gap < minSilSamps) {
      prev[1] = raw[i][1]
    } else {
      merged.push([...raw[i]])
    }
  }

  // Convert to sample indices, apply padding
  return merged.map(([ws, we]) => ({
    start: Math.max(0, ws * winSamps - padSamps),
    end:   Math.min(buffer.length, (we + 1) * winSamps + padSamps),
  })).filter(s => s.start < s.end)
}

function buildSynced(esBuffer, esSr, enBuffer, enSr, segmentsES, segmentsEN) {
  const es = esSr === TARGET_SR ? esBuffer : resample(esBuffer, esSr, TARGET_SR)
  const en = enSr === TARGET_SR ? enBuffer : resample(enBuffer, enSr, TARGET_SR)

  const scaleES = TARGET_SR / esSr
  const scaleEN = TARGET_SR / enSr
  const segsES  = segmentsES.map(s => ({ start: Math.round(s.start * scaleES), end: Math.round(s.end * scaleES) }))
  const segsEN  = segmentsEN.map(s => ({ start: Math.round(s.start * scaleEN), end: Math.round(s.end * scaleEN) }))

  const n = Math.min(segsES.length, segsEN.length)
  if (n === 0) return new Float32Array(0)

  // Calculate total output length: EN chunks + ES gaps between them
  let totalLen = 0
  for (let i = 0; i < n; i++) {
    totalLen += segsEN[i].end - segsEN[i].start
    if (i < n - 1) totalLen += Math.max(0, segsES[i + 1].start - segsES[i].end)
  }

  const out = new Float32Array(totalLen)  // zeros = silence
  let pos = 0
  for (let i = 0; i < n; i++) {
    const chunk = en.subarray(segsEN[i].start, segsEN[i].end)
    out.set(chunk, pos)
    pos += chunk.length
    if (i < n - 1) pos += Math.max(0, segsES[i + 1].start - segsES[i].end)
  }
  return out
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
  ctx.fillStyle = "#080c18"
  ctx.fillRect(0, 0, W, H)

  const intervals = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]
  const interval  = intervals.find(iv => iv * zoom >= 56) || 300
  const subCount  = 4
  const subIv     = interval / subCount

  const tStart = Math.floor(viewStart / interval) * interval
  const tEnd   = viewStart + W / zoom + interval

  ctx.font = "10px 'JetBrains Mono', 'Courier New', monospace"
  ctx.textAlign = "center"

  for (let t = tStart; t <= tEnd; t = Math.round((t + subIv) * 10000) / 10000) {
    const x = Math.round((t - viewStart) * zoom)
    if (x < -2 || x > W + 2) continue
    const isMajor = Math.abs(Math.round(t / interval) * interval - t) < 0.0001

    if (isMajor) {
      ctx.strokeStyle = "rgba(255,255,255,0.28)"
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x + 0.5, H - 9); ctx.lineTo(x + 0.5, H); ctx.stroke()
      const mins = Math.floor(t / 60)
      const secs = t % 60
      const label = mins > 0 ? `${mins}:${String(Math.floor(secs)).padStart(2, "0")}` : `${secs.toFixed(secs < 10 && interval < 1 ? 1 : 0)}s`
      ctx.fillStyle = "rgba(180,200,220,0.55)"
      ctx.fillText(label, x, H - 12)
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.1)"
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x + 0.5, H - 5); ctx.lineTo(x + 0.5, H); ctx.stroke()
    }
  }

  ctx.strokeStyle = "rgba(255,255,255,0.06)"
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke()
}

function renderTrack(canvas, buffer, sampleRate, segments, zoom, viewStart, playhead, color, label) {
  const ctx = canvas.getContext("2d")
  const W = canvas.width, H = canvas.height
  ctx.fillStyle = "#080c14"
  ctx.fillRect(0, 0, W, H)

  // Empty state
  if (!buffer || buffer.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.08)"
    ctx.font = "12px 'JetBrains Mono', monospace"
    ctx.textAlign = "center"
    ctx.fillText(`Carga el audio ${label} →`, W / 2, H / 2)
    return
  }

  const dur = buffer.length / sampleRate

  // Silence shading between segments
  if (segments && segments.length > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.42)"

    const x0 = ((segments[0].start / sampleRate) - viewStart) * zoom
    if (x0 > 0) ctx.fillRect(0, 0, Math.min(x0, W), H)

    for (let i = 0; i < segments.length - 1; i++) {
      const xA = ((segments[i].end     / sampleRate) - viewStart) * zoom
      const xB = ((segments[i + 1].start / sampleRate) - viewStart) * zoom
      if (xB > 0 && xA < W) ctx.fillRect(Math.max(0, xA), 0, Math.min(xB, W) - Math.max(0, xA), H)
    }

    const xLast = ((segments[segments.length - 1].end / sampleRate) - viewStart) * zoom
    if (xLast < W) ctx.fillRect(Math.max(0, xLast), 0, W - Math.max(0, xLast), H)
  }

  // Waveform
  const visEnd = viewStart + W / zoom
  ctx.beginPath()
  ctx.strokeStyle = color
  ctx.lineWidth = 1

  for (let x = 0; x < W; x++) {
    const t0  = viewStart + x / zoom
    const t1  = viewStart + (x + 1) / zoom
    if (t0 > dur) break
    const s0  = Math.floor(t0 * sampleRate)
    const s1  = Math.min(Math.ceil(t1 * sampleRate), buffer.length)
    const stride = Math.max(1, Math.floor((s1 - s0) / 200))
    let mn = 0, mx = 0
    for (let s = s0; s < s1; s += stride) {
      if (buffer[s] < mn) mn = buffer[s]
      if (buffer[s] > mx) mx = buffer[s]
    }
    const pad  = 5
    const yMax = H / 2 - mx * (H / 2 - pad)
    const yMin = H / 2 - mn * (H / 2 - pad)
    ctx.moveTo(x + 0.5, yMax)
    ctx.lineTo(x + 0.5, yMin)
  }
  ctx.stroke()

  // Center line
  ctx.strokeStyle = "rgba(255,255,255,0.05)"
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke()

  // Segment borders + numbers
  if (segments && segments.length > 0 && zoom > 10) {
    ctx.setLineDash([3, 4])
    ctx.lineWidth = 1
    segments.forEach((seg, i) => {
      const xs = (seg.start / sampleRate - viewStart) * zoom
      const xe = (seg.end   / sampleRate - viewStart) * zoom
      const xm = ((seg.start + seg.end) / 2 / sampleRate - viewStart) * zoom

      ;[xs, xe].forEach(xp => {
        if (xp > -1 && xp < W + 1) {
          ctx.strokeStyle = "rgba(255,255,255,0.22)"
          ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, H); ctx.stroke()
        }
      })

      if (xm > 4 && xm < W - 4) {
        ctx.setLineDash([])
        ctx.font = "bold 10px monospace"
        ctx.textAlign = "center"
        ctx.fillStyle = "rgba(255,255,255,0.4)"
        ctx.fillText(String(i + 1), xm, 13)
        ctx.setLineDash([3, 4])
      }
    })
    ctx.setLineDash([])
  }

  // Playhead
  if (playhead >= viewStart && playhead <= visEnd) {
    const xph = (playhead - viewStart) * zoom
    ctx.strokeStyle = "#fff"
    ctx.lineWidth = 1.5
    ctx.setLineDash([])
    ctx.beginPath(); ctx.moveTo(xph, 0); ctx.lineTo(xph, H); ctx.stroke()
    ctx.fillStyle = "#fff"
    ctx.beginPath()
    ctx.moveTo(xph - 4, 0); ctx.lineTo(xph + 4, 0); ctx.lineTo(xph, 7)
    ctx.closePath(); ctx.fill()
  }

  // Track label
  ctx.setLineDash([])
  ctx.fillStyle = color + "bb"
  ctx.font = "bold 10px monospace"
  ctx.textAlign = "left"
  ctx.fillText(label, 7, H - 6)
}

// ─────────────────────────────────────────────────────────────────────────────
//  SVG ICONS
// ─────────────────────────────────────────────────────────────────────────────

const IcPlay  = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
const IcPause = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
const IcStop  = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>
const IcZoomIn  = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>
const IcZoomOut = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6"/></svg>
const IcFit     = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
const IcSync    = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
const IcExport  = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
const IcUpload  = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>

// ─────────────────────────────────────────────────────────────────────────────
//  SLIDER COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

function ASSlider({ label, value, min, max, step, unit, onChange }) {
  return (
    <div className="as-slider-row">
      <div className="as-slider-header">
        <span className="as-slider-label">{label}</span>
        <span className="as-slider-value">{value}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="as-range"
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPLOAD ZONE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

function UploadZone({ color, label, sublabel, name, segments, loading, onChange }) {
  const inputRef = useRef(null)

  const handleDrop = (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) onChange(file)
  }

  return (
    <div
      className={`as-upload-zone ${name ? "as-upload-zone--loaded" : ""}`}
      style={{ "--uz-color": color }}
      onClick={() => inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      tabIndex={0}
      onKeyDown={e => e.key === "Enter" && inputRef.current?.click()}
      role="button"
      aria-label={`Cargar ${label}`}
    >
      <input
        ref={inputRef} type="file" accept="audio/*" style={{ display: "none" }}
        onChange={e => { if (e.target.files[0]) onChange(e.target.files[0]); e.target.value = "" }}
      />
      <div className="as-uz-icon" style={{ color }}>
        {loading ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        ) : <IcUpload />}
      </div>
      <div className="as-uz-text">
        <span className="as-uz-label" style={{ color }}>{label}</span>
        <span className="as-uz-sub">{sublabel}</span>
      </div>
      {name && (
        <div className="as-uz-meta">
          <span className="as-uz-filename" title={name}>{name.length > 18 ? "…" + name.slice(-16) : name}</span>
          <span className="as-uz-segs" style={{ color }}>{segments} segs</span>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function AudioSyncModule() {
  // ── Heavy buffers in refs (avoid serializing Float32Arrays through React) ──
  const esBufferRef     = useRef(null)
  const enBufferRef     = useRef(null)
  const syncedBufferRef = useRef(null)
  const esSrRef         = useRef(44100)
  const enSrRef         = useRef(44100)

  // ── Canvas refs ─────────────────────────────────────────────────────────────
  const rulerRef     = useRef(null)
  const esCanvasRef  = useRef(null)
  const enCanvasRef  = useRef(null)
  const workspaceRef = useRef(null)
  const scrollbarRef = useRef(null)

  // ── Playback refs ────────────────────────────────────────────────────────────
  const audioCtxRef    = useRef(null)
  const sourceRef      = useRef(null)
  const startTimeRef   = useRef(0)
  const startPosRef    = useRef(0)
  const rafRef         = useRef(null)

  // ── Mutable refs mirroring state (for rAF closures) ─────────────────────────
  const playheadRef   = useRef(0)
  const viewStartRef  = useRef(0)
  const zoomRef       = useRef(100)
  const isPlayingRef  = useRef(false)
  const segsESRef     = useRef([])
  const segsENRef     = useRef([])
  const activeRef     = useRef("both")
  const settingsRef   = useRef({ thresholdDb: -40, minSilenceMs: 300, paddingMs: 40 })

  // ── React state ──────────────────────────────────────────────────────────────
  const [esName,    setEsName]    = useState(null)
  const [enName,    setEnName]    = useState(null)
  const [esLoading, setEsLoading] = useState(false)
  const [enLoading, setEnLoading] = useState(false)
  const [segsES,    setSegsES]    = useState([])
  const [segsEN,    setSegsEN]    = useState([])
  const [zoom,      setZoom]      = useState(100)
  const [viewStart, setViewStart] = useState(0)
  const [playhead,  setPlayhead]  = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [active,    setActive]    = useState("both")  // "both" | "synced"
  const [status,    setStatus]    = useState("Carga los dos archivos de audio para comenzar")
  const [stats,     setStats]     = useState(null)
  const [settings,  setSettings]  = useState({ thresholdDb: -40, minSilenceMs: 300, paddingMs: 40 })
  const [canvasW,   setCanvasW]   = useState(800)

  // Keep mutable refs in sync
  useEffect(() => { playheadRef.current  = playhead  }, [playhead])
  useEffect(() => { viewStartRef.current = viewStart }, [viewStart])
  useEffect(() => { zoomRef.current      = zoom      }, [zoom])
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  useEffect(() => { segsESRef.current    = segsES    }, [segsES])
  useEffect(() => { segsENRef.current    = segsEN    }, [segsEN])
  useEffect(() => { activeRef.current    = active    }, [active])
  useEffect(() => { settingsRef.current  = settings  }, [settings])

  // ── Canvas resize observer ───────────────────────────────────────────────────
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

  // ── Render ───────────────────────────────────────────────────────────────────
  const renderAll = useCallback(() => {
    const z  = zoomRef.current
    const vs = viewStartRef.current
    const ph = playheadRef.current

    if (rulerRef.current)    renderRuler(rulerRef.current, z, vs)
    if (esCanvasRef.current) {
      renderTrack(esCanvasRef.current, esBufferRef.current, esSrRef.current,
        segsESRef.current, z, vs, ph, COLOR_ES, "ES")
    }
    if (enCanvasRef.current) {
      const isSync = activeRef.current === "synced"
      renderTrack(enCanvasRef.current,
        isSync ? syncedBufferRef.current : enBufferRef.current,
        isSync ? TARGET_SR               : enSrRef.current,
        isSync ? []                      : segsENRef.current,
        z, vs, ph,
        isSync ? COLOR_SYNC : COLOR_EN,
        isSync ? "SYNCED"   : "EN"
      )
    }
  }, [])

  useEffect(() => { renderAll() }, [canvasW, zoom, viewStart, segsES, segsEN, active, renderAll])

  // ── Re-detect segments when settings change (debounced) ─────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      const { thresholdDb, minSilenceMs, paddingMs } = settings
      if (esBufferRef.current) {
        setSegsES(detectVoiceSegments(esBufferRef.current, esSrRef.current, thresholdDb, minSilenceMs, paddingMs))
      }
      if (enBufferRef.current) {
        setSegsEN(detectVoiceSegments(enBufferRef.current, enSrRef.current, thresholdDb, minSilenceMs, paddingMs))
      }
    }, 350)
    return () => clearTimeout(t)
  }, [settings])

  // ── Audio decode helper ──────────────────────────────────────────────────────
  const decodeFile = async (file) => {
    const ab  = await file.arrayBuffer()
    const ctx = new AudioContext()
    const decoded = await ctx.decodeAudioData(ab)
    ctx.close()
    // Copy channel 0 into a plain Float32Array — no createBuffer storage limit
    const data = new Float32Array(decoded.getChannelData(0))
    return { buffer: data, sampleRate: decoded.sampleRate }
  }

  // ── Upload handlers ──────────────────────────────────────────────────────────
  const handleESUpload = async (file) => {
    setEsLoading(true)
    setStatus("Decodificando ES…")
    try {
      const { buffer, sampleRate } = await decodeFile(file)
      esBufferRef.current = buffer
      esSrRef.current     = sampleRate
      setEsName(file.name)
      const { thresholdDb, minSilenceMs, paddingMs } = settingsRef.current
      const segs = detectVoiceSegments(buffer, sampleRate, thresholdDb, minSilenceMs, paddingMs)
      setSegsES(segs)
      setStatus(`ES cargado · ${(buffer.length / sampleRate).toFixed(1)}s · ${segs.length} segmentos detectados`)
    } catch (e) {
      setStatus("Error decodificando ES: " + e.message)
    } finally {
      setEsLoading(false)
    }
  }

  const handleENUpload = async (file) => {
    setEnLoading(true)
    setStatus("Decodificando EN…")
    try {
      const { buffer, sampleRate } = await decodeFile(file)
      enBufferRef.current = buffer
      enSrRef.current     = sampleRate
      setEnName(file.name)
      const { thresholdDb, minSilenceMs, paddingMs } = settingsRef.current
      const segs = detectVoiceSegments(buffer, sampleRate, thresholdDb, minSilenceMs, paddingMs)
      setSegsEN(segs)
      setStatus(`EN cargado · ${(buffer.length / sampleRate).toFixed(1)}s · ${segs.length} segmentos detectados`)
    } catch (e) {
      setStatus("Error decodificando EN: " + e.message)
    } finally {
      setEnLoading(false)
    }
  }

  // ── Synchronize ──────────────────────────────────────────────────────────────
  const handleSync = useCallback(() => {
    if (!esBufferRef.current || !enBufferRef.current) {
      setStatus("Carga ambos audios primero"); return
    }
    if (segsES.length === 0 || segsEN.length === 0) {
      setStatus("No se detectaron segmentos — ajusta el umbral de detección"); return
    }
    setStatus("Sincronizando…")
    setTimeout(() => {
      try {
        const synced = buildSynced(
          esBufferRef.current, esSrRef.current,
          enBufferRef.current, enSrRef.current,
          segsES, segsEN,
        )
        syncedBufferRef.current = synced
        const n       = Math.min(segsES.length, segsEN.length)
        const dur     = (synced.length / TARGET_SR).toFixed(2)
        setStats({
          n,
          durES:  (esBufferRef.current.length / esSrRef.current).toFixed(1),
          durEN:  (enBufferRef.current.length / enSrRef.current).toFixed(1),
          durSync: dur,
          skipped: Math.abs(segsES.length - segsEN.length),
        })
        setActive("synced")
        setStatus(`Sincronizado · ${n} segmentos emparejados · ${dur}s de salida`)
        renderAll()
      } catch (e) {
        setStatus("Error sincronizando: " + e.message)
      }
    }, 0)
  }, [segsES, segsEN, renderAll])

  // ── Playback ─────────────────────────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (sourceRef.current)   { try { sourceRef.current.stop() } catch {} sourceRef.current = null }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null }
    if (rafRef.current)      { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    setIsPlaying(false)
  }, [])

  const startPlayback = useCallback(() => {
    const isSync = activeRef.current === "synced"
    const buf    = isSync ? syncedBufferRef.current : (esBufferRef.current)
    const sr     = isSync ? TARGET_SR : esSrRef.current
    if (!buf) return

    const ctx  = new AudioContext()
    audioCtxRef.current = ctx
    const abuf = ctx.createBuffer(1, buf.length, sr)
    abuf.copyToChannel(buf, 0)

    const src = ctx.createBufferSource()
    src.buffer = abuf
    src.connect(ctx.destination)
    src.onended = () => { if (isPlayingRef.current) stopPlayback() }

    const offset = Math.max(0, Math.min(playheadRef.current, buf.length / sr - 0.01))
    src.start(0, offset)
    sourceRef.current   = src
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

      // Auto-scroll
      const w   = esCanvasRef.current?.width || 800
      const vis = w / zoomRef.current
      const vs  = viewStartRef.current
      if (pos > vs + vis * 0.8) {
        const nv = pos - vis * 0.2
        viewStartRef.current = nv
        setViewStart(nv)
      }

      renderAll()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stopPlayback, renderAll])

  const handlePlayPause = () => isPlaying ? stopPlayback() : startPlayback()

  // ── Export ───────────────────────────────────────────────────────────────────
  const handleExport = () => {
    if (!syncedBufferRef.current) { setStatus("Sincroniza primero"); return }
    const wav  = encodeWAV24(syncedBufferRef.current, TARGET_SR)
    const blob = new Blob([wav], { type: "audio/wav" })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement("a"), { href: url, download: "audio_synced_48k_24bit.wav" })
    a.click(); URL.revokeObjectURL(url)
    setStatus("Exportado: audio_synced_48k_24bit.wav  (PCM 24-bit / 48kHz)")
  }

  // ── Zoom ─────────────────────────────────────────────────────────────────────
  const handleZoomIn  = () => setZoom(z => Math.min(z * 1.5, 3000))
  const handleZoomOut = () => setZoom(z => Math.max(z / 1.5, 4))
  const handleFit     = () => {
    const buf = esBufferRef.current || enBufferRef.current
    if (!buf) return
    const dur = buf.length / (esBufferRef.current ? esSrRef.current : enSrRef.current)
    const w   = workspaceRef.current?.offsetWidth || 800
    setZoom((w - 2) / dur)
    setViewStart(0)
  }

  // ── Canvas interactions ──────────────────────────────────────────────────────
  const handleCanvasClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const t    = Math.max(0, viewStart + (e.clientX - rect.left) / zoom)
    playheadRef.current = t
    setPlayhead(t)
    if (isPlaying) {
      stopPlayback()
      startPosRef.current = t
      setTimeout(startPlayback, 30)
    } else {
      renderAll()
    }
  }

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const rect      = e.currentTarget.getBoundingClientRect()
    const xRel      = e.clientX - rect.left
    const tAtCursor = viewStartRef.current + xRel / zoomRef.current
    const factor    = e.deltaY < 0 ? 1.22 : 1 / 1.22
    const nz        = Math.max(4, Math.min(3000, zoomRef.current * factor))
    const nv        = Math.max(0, tAtCursor - xRel / nz)
    zoomRef.current      = nz
    viewStartRef.current = nv
    setZoom(nz)
    setViewStart(nv)
  }, [])

  // ── Scrollbar drag ───────────────────────────────────────────────────────────
  const getMaxDuration = () => {
    const es = esBufferRef.current ? esBufferRef.current.length / esSrRef.current : 0
    const en = enBufferRef.current ? enBufferRef.current.length / enSrRef.current : 0
    const sy = syncedBufferRef.current ? syncedBufferRef.current.length / TARGET_SR : 0
    return Math.max(es, en, sy, 10)
  }

  const scrollDrag = useRef(false)
  const handleScrollMouseDown = (e) => {
    scrollDrag.current = true
    e.preventDefault()
    moveScroll(e.clientX)
  }
  const moveScroll = (clientX) => {
    const rect    = scrollbarRef.current?.getBoundingClientRect()
    if (!rect) return
    const ratio   = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const dur     = getMaxDuration()
    const visible = canvasW / zoomRef.current
    const maxVS   = Math.max(0, dur - visible)
    const nv      = ratio * maxVS
    viewStartRef.current = nv
    setViewStart(nv)
  }
  useEffect(() => {
    const onMove = (e) => { if (scrollDrag.current) moveScroll(e.clientX) }
    const onUp   = ()  => { scrollDrag.current = false }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup",   onUp)
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived values ───────────────────────────────────────────────────────────
  const totalDur   = getMaxDuration()
  const visibleDur = canvasW / zoom
  const thumbW     = Math.max(6, Math.min(100, (visibleDur / totalDur) * 100))
  const thumbL     = totalDur > visibleDur ? (viewStart / (totalDur - visibleDur)) * (100 - thumbW) : 0

  const formatTC = (s) => {
    const m  = Math.floor(s / 60)
    const sc = s % 60
    return `${String(m).padStart(2, "0")}:${String(Math.floor(sc)).padStart(2, "0")}.${String(Math.floor((sc % 1) * 1000)).padStart(3, "0")}`
  }

  const canSync   = !!esBufferRef.current && !!enBufferRef.current
  const canExport = !!syncedBufferRef.current

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="as-root">

      {/* ── TOPBAR ─────────────────────────────────────── */}
      <div className="as-topbar">
        <div className="as-topbar-left">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLOR_ES} strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 12h3M5 8v8M8 5v14M11 9v6M14 6v12M17 9v6M20 8v8"/>
          </svg>
          <span className="as-topbar-name">AudioSync</span>
          <span className="as-topbar-sep">·</span>
          <span className="as-topbar-sub">Sincronizador de tiempos ES → EN</span>
        </div>
        <div className="as-topbar-right">
          <span className="as-timecode">{formatTC(playhead)}</span>
          <span className="as-zoom-badge">{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)} px/s</span>
          <span className="as-sr-badge">48kHz · 24bit</span>
        </div>
      </div>

      {/* ── TOOLBAR ────────────────────────────────────── */}
      <div className="as-toolbar">
        <div className="as-toolbar-group">
          <button className={`as-btn as-btn--play ${isPlaying ? "active" : ""}`} onClick={handlePlayPause} title={isPlaying ? "Pausar" : "Reproducir"}>
            {isPlaying ? <IcPause /> : <IcPlay />}
            <span>{isPlaying ? "PAUSA" : "PLAY"}</span>
          </button>
          <button className="as-btn" onClick={stopPlayback} title="Detener">
            <IcStop />
            <span>STOP</span>
          </button>
        </div>
        <div className="as-toolbar-sep" />
        <div className="as-toolbar-group">
          <button className="as-btn" onClick={handleZoomIn}  title="Ampliar zoom"><IcZoomIn  /><span>ZOOM+</span></button>
          <button className="as-btn" onClick={handleZoomOut} title="Reducir zoom"><IcZoomOut /><span>ZOOM-</span></button>
          <button className="as-btn" onClick={handleFit}     title="Ajustar vista"><IcFit /><span>FIT</span></button>
        </div>
        <div className="as-toolbar-sep" />
        <div className="as-toolbar-group">
          <button className={`as-btn as-btn--accent ${!canSync ? "disabled" : ""}`} onClick={handleSync} disabled={!canSync} title="Sincronizar audios">
            <IcSync /><span>SINCRONIZAR</span>
          </button>
          <button className={`as-btn as-btn--export ${!canExport ? "disabled" : ""}`} onClick={handleExport} disabled={!canExport} title="Exportar WAV 24-bit">
            <IcExport /><span>EXPORTAR WAV</span>
          </button>
        </div>
        <div className="as-toolbar-sep as-toolbar-sep--push" />
        <div className="as-toolbar-group">
          <button className={`as-btn as-btn--track ${active === "both" ? "as-btn--track-active" : ""}`} onClick={() => setActive("both")}>
            <span className="as-track-dot" style={{ background: COLOR_ES }} />
            <span className="as-track-dot" style={{ background: COLOR_EN }} />
            <span>ES+EN</span>
          </button>
          {canExport && (
            <button className={`as-btn as-btn--track ${active === "synced" ? "as-btn--track-active" : ""}`} onClick={() => setActive("synced")}>
              <span className="as-track-dot" style={{ background: COLOR_SYNC }} />
              <span>SYNCED</span>
            </button>
          )}
        </div>
      </div>

      {/* ── BODY ───────────────────────────────────────── */}
      <div className="as-body">

        {/* ── SIDEBAR ──────────────────────────────────── */}
        <div className="as-sidebar">
          <div className="as-sidebar-section">
            <div className="as-sidebar-title">Archivos</div>
            <UploadZone
              color={COLOR_ES} label="Audio ES" sublabel="Referencia de tiempos"
              name={esName} segments={segsES.length} loading={esLoading}
              onChange={handleESUpload}
            />
            <UploadZone
              color={COLOR_EN} label="Audio EN" sublabel="Audio a ajustar"
              name={enName} segments={segsEN.length} loading={enLoading}
              onChange={handleENUpload}
            />
          </div>

          <div className="as-sidebar-section">
            <div className="as-sidebar-title">Detección de silencios</div>
            <ASSlider
              label="Umbral" value={settings.thresholdDb} min={-70} max={-15} step={1} unit=" dB"
              onChange={v => setSettings(s => ({ ...s, thresholdDb: v }))}
            />
            <ASSlider
              label="Silencio mín." value={settings.minSilenceMs} min={50} max={2000} step={10} unit=" ms"
              onChange={v => setSettings(s => ({ ...s, minSilenceMs: v }))}
            />
            <ASSlider
              label="Padding voz" value={settings.paddingMs} min={0} max={150} step={5} unit=" ms"
              onChange={v => setSettings(s => ({ ...s, paddingMs: v }))}
            />
          </div>

          {stats && (
            <div className="as-sidebar-section">
              <div className="as-sidebar-title">Resultado</div>
              <div className="as-stats">
                <div className="as-stat"><span>Segmentos</span><span className="as-stat-val">{stats.n}</span></div>
                <div className="as-stat"><span>Dur. ES</span><span className="as-stat-val">{stats.durES}s</span></div>
                <div className="as-stat"><span>Dur. EN</span><span className="as-stat-val">{stats.durEN}s</span></div>
                <div className="as-stat"><span>Dur. SYNC</span><span className="as-stat-val" style={{ color: COLOR_SYNC }}>{stats.durSync}s</span></div>
                {stats.skipped > 0 && (
                  <div className="as-stat as-stat--warn">
                    <span>Saltados</span><span className="as-stat-val">{stats.skipped}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── WORKSPACE ────────────────────────────────── */}
        <div className="as-workspace-wrap">
          <div className="as-workspace" ref={workspaceRef}>

            {/* Ruler */}
            <canvas ref={rulerRef} className="as-ruler-canvas" width={canvasW} height={RULER_H} />

            {/* ES track */}
            <div className="as-track-row">
              <div className="as-track-label" style={{ borderColor: COLOR_ES + "44" }}>
                <span style={{ color: COLOR_ES }}>ES</span>
                <span className="as-track-segs">{segsES.length}</span>
              </div>
              <canvas
                ref={esCanvasRef} className="as-track-canvas" width={canvasW} height={TRACK_H}
                onClick={handleCanvasClick} onWheel={handleWheel}
              />
            </div>

            {/* Track separator */}
            <div className="as-track-divider">
              <span className="as-track-divider-label">
                {active === "synced" ? (
                  <><span style={{ color: COLOR_SYNC }}>●</span> SYNCED — EN con tiempos de ES</>
                ) : (
                  <><span style={{ color: COLOR_EN }}>●</span> EN</>
                )}
              </span>
            </div>

            {/* EN / Synced track */}
            <div className="as-track-row">
              <div className="as-track-label" style={{ borderColor: (active === "synced" ? COLOR_SYNC : COLOR_EN) + "44" }}>
                <span style={{ color: active === "synced" ? COLOR_SYNC : COLOR_EN }}>
                  {active === "synced" ? "SY" : "EN"}
                </span>
                <span className="as-track-segs">{active === "synced" ? "—" : segsEN.length}</span>
              </div>
              <canvas
                ref={enCanvasRef} className="as-track-canvas" width={canvasW} height={TRACK_H}
                onClick={handleCanvasClick} onWheel={handleWheel}
              />
            </div>

            {/* Scrollbar */}
            <div className="as-scrollbar" ref={scrollbarRef} onMouseDown={handleScrollMouseDown}>
              <div
                className="as-scrollbar-thumb"
                style={{ left: `${thumbL}%`, width: `${thumbW}%` }}
              />
            </div>

          </div>
        </div>

      </div>

      {/* ── STATUSBAR ──────────────────────────────────── */}
      <div className="as-statusbar">
        <span className="as-status-msg">{status}</span>
        <div className="as-status-meta">
          {esBufferRef.current && <span>ES: {(esBufferRef.current.length / esSrRef.current).toFixed(1)}s · {esSrRef.current / 1000}kHz</span>}
          {enBufferRef.current && <span>EN: {(enBufferRef.current.length / enSrRef.current).toFixed(1)}s · {enSrRef.current / 1000}kHz</span>}
          <span>Salida: 48kHz · 24-bit · mono</span>
        </div>
      </div>

    </div>
  )
}
