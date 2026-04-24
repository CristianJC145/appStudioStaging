import { useState, useEffect } from "react"

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


export default function ConfigPanel({ config, setConfig, userId }) {
  const set = (key, val) => setConfig(prev => ({ ...prev, [key]: val }))
  const setVS = (key, val) =>
    setConfig(prev => ({ ...prev, voice_settings: { ...prev.voice_settings, [key]: val } }))

  const [voices, setVoices] = useState([])
  const [loadingVoices, setLoadingVoices] = useState(false)

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
      <div className="card-header">
        <div>
          <div className="card-title">Configuración</div>
          <div className="card-subtitle">ElevenLabs + Audio</div>
        </div>
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
          <select value={config.output_format || "pcm_44100"} onChange={e => set("output_format", e.target.value)}>
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

      {/* ── Velocidad de voz — las 3 secciones en un solo dropdown ── */}
      <Section title="Velocidad de Voz" open={openSections["Velocidad de Voz"]} onToggle={() => toggleSection("Velocidad de Voz")}>
        <div style={{ marginTop: 6 }}>
          <Slider
            label="Intro"
            value={config.intro_voice_speed}
            onChange={v => set("intro_voice_speed", v)}
            min={0.7} max={1.3} step={0.01}
            tooltip="Velocidad enviada a ElevenLabs para la intro"
          />
          <Slider
            label="Afirmaciones"
            value={config.afirm_voice_speed}
            onChange={v => set("afirm_voice_speed", v)}
            min={0.7} max={1.3} step={0.01}
            tooltip="Velocidad enviada a ElevenLabs para las afirmaciones"
          />
          <Slider
            label="Meditación"
            value={config.medit_voice_speed}
            onChange={v => set("medit_voice_speed", v)}
            min={0.7} max={1.3} step={0.01}
            tooltip="Velocidad enviada a ElevenLabs para la meditación"
          />
        </div>
      </Section>

      {/* ── Solo la pausa entre afirmaciones — aplica en el ensamble final ── */}
      <Section title="Silencios" open={openSections["Silencios"]} onToggle={() => toggleSection("Silencios")}>
        <div style={{ marginTop: 6 }}>
          <NumInput
            label="Entre afirmaciones (ms)"
            value={config.pausa_entre_afirmaciones}
            onChange={v => set("pausa_entre_afirmaciones", v)}
            min={1000} max={30000} step={500}
          />
          <div className="text-xs text-muted" style={{ marginTop: 4, marginBottom: 4 }}>
            Silencio entre cada afirmación en el audio final.
          </div>
        </div>
      </Section>

      {/* ── Avanzado: tamaño de párrafos ── */}
      <Section title="Avanzado" open={openSections["Avanzado"]} onToggle={() => toggleSection("Avanzado")}>
        <div style={{ marginTop: 6 }}>

          {/* Segmentación de texto */}
          <div style={{ marginTop: 8 }}>
            <NumInput
              label="Máx. caracteres por párrafo"
              value={config.max_chars_parrafo}
              onChange={v => set("max_chars_parrafo", v)}
              min={220} max={800}
            />
            <NumInput
              label="Mín. caracteres por bloque"
              value={config.min_chars_parrafo ?? 220}
              onChange={v => set("min_chars_parrafo", v)}
              min={0} max={500}
            />
          </div>
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
