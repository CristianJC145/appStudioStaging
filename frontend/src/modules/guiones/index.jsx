import { useState, useRef, useCallback, useEffect } from "react"
import ConfigPanel from "./components/ConfigPanel"
import ScriptEditor from "./components/ScriptEditor"
import GenerationProgress from "./components/GenerationProgress"
import ReviewPanel from "./components/ReviewPanel"
import HistoryPanel from "./components/HistoryPanel"

const DEFAULT_CONFIG = {
  api_key: "dd15fc77bf3a163f41e678cf29f8018fc0c43e756081a6e4dcbd6bc66ae5e251",
  voice_id: "3fRg3Y6XXL8gnxYFuN1z",
  model_id: "eleven_multilingual_v2",
  language_code: "es",
  output_format: "mp3_44100_128",
  voice_settings: {
    stability: 0.45,
    similarity_boost: 0.95,
    style: 0.01,
    use_speaker_boost: true,
  },
  intro_voice_speed: 1.0,
  intro_tempo_factor: 0.98,
  afirm_voice_speed: 0.94,
  afirm_tempo_factor: 0.95,
  medit_voice_speed: 0.9,
  medit_tempo_factor: 0.9,
  pausa_entre_oraciones: 400,
  pausa_entre_afirmaciones: 10000,
  pausa_intro_a_afirm: 2000,
  pausa_afirm_a_medit: 3000,
  pausa_entre_meditaciones: 5000,
  usar_ssml_breaks: true,
  break_coma: 0.5,
  break_punto: 0.7,
  break_suspensivos: 0.8,
  break_dos_puntos: 0.4,
  break_punto_coma: 0.6,
  break_guion: 0.5,
  break_exclamacion: 0.7,
  break_interrogacion: 0.7,
  break_parrafo: 1.0,
  extend_silence: false,
  factor_coma: 1.0,
  factor_punto: 1.2,
  factor_suspensivos: 1.5,
  silence_thresh_db: -40,
  silence_min_ms: 80,
  max_chars_parrafo: 290,
  min_chars_parrafo: 220,
}

const TABS = [
  { id: "editor",   label: "Guion" },
  { id: "progress", label: "Progreso" },
  { id: "review",   label: "Revisión" },
  { id: "history",  label: "Historial" },
]

const API = import.meta.env.VITE_API_URL

// ── Persistencia de job por usuario ─────────────────────────────────────────
function getUserId() {
  try {
    const token = localStorage.getItem("studio_token")
    if (!token) return null
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))
    return String(payload.id ?? payload.sub ?? payload.user_id ?? "")
  } catch { return null }
}

function jobStorageKey(userId) { return `review_job_${userId}` }

function saveJobId(userId, jobId) {
  if (!userId) return
  try { localStorage.setItem(jobStorageKey(userId), jobId) } catch {}
}

function loadJobId(userId) {
  if (!userId) return null
  return localStorage.getItem(jobStorageKey(userId)) || null
}

function clearJobId(userId) {
  if (!userId) return
  localStorage.removeItem(jobStorageKey(userId))
}

export default function GuionesModule() {
  const [tab, setTab] = useState("editor")

  const [config, setConfig] = useState(() => {
    try {
      const saved = sessionStorage.getItem("medi_config")
      return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : DEFAULT_CONFIG
    } catch { return DEFAULT_CONFIG }
  })

  useEffect(() => {
    const apiKey = config.api_key
    if (!apiKey) return
    fetch(`${API}/api/config?api_key=${encodeURIComponent(apiKey)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Object.keys(data).length > 0) {
          const merged = { ...DEFAULT_CONFIG, ...data }
          setConfig(merged)
          sessionStorage.setItem("medi_config", JSON.stringify(merged))
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [guion, setGuion]   = useState("")
  const [nombre, setNombre] = useState("")
  const [jobId, setJobId]   = useState(null)
  const [jobStatus, setJobStatus] = useState(null)
  const [events, setEvents] = useState([])

  const [introBloques, setIntroBloques]     = useState([])
  const [introAudios, setIntroAudios]       = useState({})
  const [introDecisions, setIntroDecisions]         = useState({})
  const [introRegenerating, setIntroRegenerating]   = useState(new Set())

  const [afirmaciones, setAfirmaciones]     = useState([])
  const [afirmAudios, setAfirmAudios]       = useState({})
  const [afirmDecisions, setAfirmDecisions] = useState({})
  const [afirmRegenerating, setAfirmRegenerating]   = useState(new Set())

  const [meditaciones, setMeditaciones]     = useState([])
  const [meditAudios, setMeditAudios]       = useState({})
  const [meditDecisions, setMeditDecisions] = useState({})
  const [meditRegenerating, setMeditRegenerating]   = useState(new Set())

  const [reviewSection, setReviewSection] = useState(null)
  const [downloadUrl, setDownloadUrl]     = useState(null)
  const [durationMins, setDurationMins]   = useState(null)
  const [charsUsados, setCharsUsados]     = useState(null)
  const [charsRestantes, setCharsRestantes] = useState(null)
  const [generating, setGenerating]       = useState(false)
  const esRef        = useRef(null)
  const saveTimerRef = useRef(null)
  const userIdRef    = useRef(getUserId())

  const addEvent = useCallback((evt) => {
    setEvents(prev => [...prev, { ...evt, ts: Date.now() }])
  }, [])

  const saveConfig = useCallback((nextOrUpdater) => {
    setConfig(prev => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater
      sessionStorage.setItem("medi_config", JSON.stringify(next))
      if (next.api_key) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
          fetch(`${API}/api/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: next }),
          }).catch(() => {})
        }, 1500)
      }
      return next
    })
  }, [])

  // ── Conectar / reconectar SSE ──────────────────────────────────────────────
  const connectSSE = useCallback((id) => {
    if (esRef.current) esRef.current.close()
    const es = new EventSource(`${API}/api/events/${id}`)
    esRef.current = es

    es.onmessage = (e) => {
      const evt = JSON.parse(e.data)
      addEvent(evt)

      if (evt.type === "intro_start")  setIntroBloques(new Array(evt.data.total).fill(""))
      if (evt.type === "intro_ready") {
        setIntroAudios(prev => ({ ...prev, [evt.data.index]: evt.data.audio_url }))
        setIntroBloques(prev => { const u = [...prev]; u[evt.data.index] = evt.data.text; return u })
        setIntroRegenerating(prev => { const s = new Set(prev); s.delete(evt.data.index); return s })
      }
      if (evt.type === "intro_review_start") { setReviewSection("intro"); setJobStatus("awaiting_review"); setTab("review") }
      if (evt.type === "intro_review_done")  setReviewSection(null)

      if (evt.type === "afirm_start") setAfirmaciones(new Array(evt.data.total).fill(""))
      if (evt.type === "afirm_ready") {
        setAfirmAudios(prev => ({ ...prev, [evt.data.index]: evt.data.audio_url }))
        setAfirmaciones(prev => { const u = [...prev]; u[evt.data.index] = evt.data.text; return u })
        setAfirmRegenerating(prev => { const s = new Set(prev); s.delete(evt.data.index); return s })
      }
      if (evt.type === "afirm_review_start") { setReviewSection("afirm"); setJobStatus("awaiting_review"); setTab("review") }
      if (evt.type === "afirm_review_done")  setReviewSection(null)

      if (evt.type === "medit_start") setMeditaciones(new Array(evt.data.total).fill(""))
      if (evt.type === "medit_ready") {
        setMeditAudios(prev => ({ ...prev, [evt.data.index]: evt.data.audio_url }))
        setMeditaciones(prev => { const u = [...prev]; u[evt.data.index] = evt.data.text; return u })
        setMeditRegenerating(prev => { const s = new Set(prev); s.delete(evt.data.index); return s })
      }
      if (evt.type === "medit_review_start") { setReviewSection("medit"); setJobStatus("awaiting_review"); setTab("review") }
      if (evt.type === "medit_review_done")  setReviewSection(null)

      if (evt.type === "building") { setJobStatus("building"); setTab("progress") }
      if (evt.type === "done") {
        setDownloadUrl(`${API}${evt.data.download_url}`)
        setDurationMins(evt.data.duration_mins)
        if (evt.data.chars_usados    != null) setCharsUsados(evt.data.chars_usados)
        if (evt.data.chars_restantes != null) setCharsRestantes(evt.data.chars_restantes)
        setJobStatus("done")
        setGenerating(false)
        setTab("progress")
        clearJobId(userIdRef.current)
        es.close()
      }
      if (evt.type === "error") {
        setJobStatus("error")
        setGenerating(false)
        clearJobId(userIdRef.current)
        es.close()
      }
    }
    es.onerror = () => { es.close(); setGenerating(false) }
  }, [addEvent])

  // ── Restaurar job al recargar página ──────────────────────────────────────
  useEffect(() => {
    const userId = userIdRef.current
    const savedJobId = loadJobId(userId)
    if (!savedJobId) return

    fetch(`${API}/api/job/${savedJobId}`)
      .then(r => r.ok ? r.json() : null)
      .then(job => {
        if (!job) { clearJobId(userId); return }

        setJobId(savedJobId)
        setGenerating(job.status !== "done" && job.status !== "error")
        setTab("progress")

        // Restaurar decisiones ya enviadas desde el estado del backend
        if (job.intro_decisions)  setIntroDecisions(job.intro_decisions)
        if (job.afirm_decisions)  setAfirmDecisions(job.afirm_decisions)
        if (job.medit_decisions)  setMeditDecisions(job.medit_decisions)

        // Reconectar SSE — replaya todos los eventos desde el inicio
        connectSSE(savedJobId)
      })
      .catch(() => clearJobId(userId))
  }, [connectSSE]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cancelar job en curso ─────────────────────────────────────────────────
  const cancelJob = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
    clearJobId(userIdRef.current)
    setJobId(null)
    setJobStatus(null)
    setGenerating(false)
    setReviewSection(null)
    setIntroBloques([]); setIntroAudios({}); setIntroDecisions({}); setIntroRegenerating(new Set())
    setAfirmaciones([]); setAfirmAudios({}); setAfirmDecisions({}); setAfirmRegenerating(new Set())
    setMeditaciones([]); setMeditAudios({}); setMeditDecisions({}); setMeditRegenerating(new Set())
    setDownloadUrl(null); setDurationMins(null)
    setEvents([])
    setTab("editor")
  }, [])

  const startGeneration = async () => {
    if (!config.api_key) return alert("Ingresa tu API Key de ElevenLabs")
    if (!guion.trim())   return alert("El guion está vacío")

    setGenerating(true)
    setEvents([])
    setIntroBloques([]); setIntroAudios({}); setIntroDecisions({}); setIntroRegenerating(new Set())
    setAfirmaciones([]); setAfirmAudios({}); setAfirmDecisions({}); setAfirmRegenerating(new Set())
    setMeditaciones([]); setMeditAudios({}); setMeditDecisions({}); setMeditRegenerating(new Set())
    setReviewSection(null)
    setDownloadUrl(null)
    setDurationMins(null)
    setJobStatus("starting")

    try {
      const res = await fetch(`${API}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guion, config, nombre }),
      })
      const data = await res.json()
      const id   = data.job_id
      setJobId(id)
      saveJobId(userIdRef.current, id)
      setTab("progress")
      connectSSE(id)
    } catch (err) {
      alert("Error conectando al backend: " + err.message)
      setGenerating(false)
    }
  }

  const submitDecision = async (section, index, decision, newText = null) => {
    if (section === "intro") {
      setIntroDecisions(prev => ({ ...prev, [index]: decision }))
      if (newText && decision === "regenerate")
        setIntroBloques(prev => { const u = [...prev]; u[index] = newText; return u })
      if (decision === "regenerate")
        setIntroRegenerating(prev => { const s = new Set(prev); s.add(index); return s })
    } else if (section === "afirm") {
      setAfirmDecisions(prev => ({ ...prev, [index]: decision }))
      if (newText && decision === "regenerate")
        setAfirmaciones(prev => { const u = [...prev]; u[index] = newText; return u })
      if (decision === "regenerate")
        setAfirmRegenerating(prev => { const s = new Set(prev); s.add(index); return s })
    } else {
      setMeditDecisions(prev => ({ ...prev, [index]: decision }))
      if (newText && decision === "regenerate")
        setMeditaciones(prev => { const u = [...prev]; u[index] = newText; return u })
      if (decision === "regenerate")
        setMeditRegenerating(prev => { const s = new Set(prev); s.add(index); return s })
    }
    await fetch(`${API}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, section, index, decision, new_text: newText || null }),
    })
  }

  const finalizeSection = async (section) => {
    const items     = section === "intro" ? introBloques : section === "afirm" ? afirmaciones : meditaciones
    const decisions = section === "intro" ? introDecisions : section === "afirm" ? afirmDecisions : meditDecisions
    for (let i = 0; i < items.length; i++) {
      if (!decisions[i]) await submitDecision(section, i, "ok")
    }
    await fetch(`${API}/api/finalize/${jobId}/${section}`, { method: "POST" })
    setJobStatus("running")
    setTab("progress")
  }

  const pendingIntro = introBloques.filter((_, i) => !introDecisions[i]).length
  const pendingAfirm = afirmaciones.filter((_, i) => !afirmDecisions[i]).length
  const pendingMedit = meditaciones.filter((_, i) => !meditDecisions[i]).length
  const reviewBadge  = jobStatus === "awaiting_review"
    ? (reviewSection === "intro" ? pendingIntro : reviewSection === "afirm" ? pendingAfirm : pendingMedit) || null
    : null

  return (
    <div className="module-page fade-up">
      <nav className="module-nav">
        {TABS.map(({ id, label }) => {
          const badge = id === "progress" && generating ? "●"
                      : id === "review"   && reviewBadge ? reviewBadge
                      : null
          return (
            <button
              key={id}
              className={`nav-btn ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
              {badge && <span className="nav-badge">{badge}</span>}
            </button>
          )
        })}
        {generating && (
          <button
            className="nav-btn"
            style={{ marginLeft: "auto", color: "var(--danger, #e05c5c)" }}
            onClick={cancelJob}
          >
            Cancelar generación
          </button>
        )}
      </nav>

      <div className="module-content">
        {tab === "editor" && (
          <div className="editor-layout">
            <ScriptEditor
              guion={guion} setGuion={setGuion}
              nombre={nombre} setNombre={setNombre}
              onGenerate={startGeneration}
              generating={generating}
            />
            <ConfigPanel config={config} setConfig={saveConfig} userId={userIdRef.current} />
          </div>
        )}

        {tab === "progress" && (
          <GenerationProgress
            events={events}
            jobStatus={jobStatus}
            downloadUrl={downloadUrl}
            durationMins={durationMins}
            charsUsados={charsUsados}
            charsRestantes={charsRestantes}
            reviewSection={reviewSection}
            onGoReview={() => setTab("review")}
            pendingReview={reviewSection === "intro" ? pendingIntro : pendingAfirm}
          />
        )}

        {tab === "review" && (
          <ReviewPanel
            reviewSection={reviewSection}
            introBloques={introBloques} introAudios={introAudios} introDecisions={introDecisions}
            afirmaciones={afirmaciones} afirmAudios={afirmAudios} afirmDecisions={afirmDecisions}
            meditaciones={meditaciones} meditAudios={meditAudios} meditDecisions={meditDecisions}
            introRegenerating={introRegenerating}
            afirmRegenerating={afirmRegenerating}
            meditRegenerating={meditRegenerating}
            onDecision={submitDecision}
            onFinalize={finalizeSection}
            jobStatus={jobStatus}
          />
        )}

        {tab === "history" && <HistoryPanel />}
      </div>
    </div>
  )
}
