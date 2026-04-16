import { useEffect } from "react"

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal")
    const io  = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("visible"); io.unobserve(e.target) } }),
      { threshold: 0.10 }
    )
    els.forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [])
}

const IconGlobe = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>
  </svg>
)
const IconUsers = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
)
const IconBar = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M18 20V10M12 20V4M6 20v-6"/>
  </svg>
)
const IconHeart = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/>
  </svg>
)

const GEO = [
  { country: "🇲🇽 México",    pct: 32 },
  { country: "🇨🇴 Colombia",  pct: 22 },
  { country: "🇪🇸 España",    pct: 18 },
  { country: "🇦🇷 Argentina", pct: 14 },
  { country: "🌎 Otros",      pct: 14 },
]

const AGE = [
  { range: "18–24", pct: 20 },
  { range: "25–34", pct: 44 },
  { range: "35–44", pct: 26 },
  { range: "45+",   pct: 10 },
]

export default function Canal() {
  useReveal()

  return (
    <>
      {/* Page Hero */}
      <div className="lp-page-hero">
        <div className="lp-wrap">
          <div className="lp-page-hero-eyebrow reveal">Media Kit 2025</div>
          <h1 className="lp-page-hero-title reveal reveal-delay-1">
            Números que<br />hablan por<br /><em>sí solos</em>
          </h1>
          <p className="lp-page-hero-sub reveal reveal-delay-2">
            Una audiencia comprometida, con alta retención y un perfil demográfico
            premium para marcas del sector bienestar, consciencia y desarrollo personal.
          </p>
          <div className="lp-page-hero-meta reveal reveal-delay-3">
            <span className="lp-page-hero-tag">Actualizado Ene 2025</span>
            <span className="lp-page-hero-tag">Latam &amp; España</span>
            <span className="lp-page-hero-tag">25–44 años · 65% Femenino</span>
          </div>
        </div>
      </div>

      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-wrap">

          {/* Key stats row */}
          <div className="lp-stat-row reveal">
            {[
              { val: "50K+",  lbl: "Suscriptores",          note: "Crecimiento orgánico sostenido"  },
              { val: "5M+",   lbl: "Visualizaciones totales",note: "Acumuladas desde el lanzamiento" },
              { val: "68%",   lbl: "Retención promedio",     note: "Muy por encima del promedio YT"  },
              { val: "15+",   lbl: "Países alcanzados",      note: "Presencia en toda Hispanohablante"},
            ].map(s => (
              <div key={s.lbl} className="lp-stat-box">
                <div className="lp-stat-box-val">{s.val}</div>
                <div className="lp-stat-box-lbl">{s.lbl}</div>
                <div className="lp-stat-box-note">{s.note}</div>
              </div>
            ))}
          </div>

          {/* Bento grid */}
          <div className="lp-bento">

            {/* Distribución geográfica */}
            <div className="lp-bento-card reveal reveal-delay-1">
              <div className="lp-bento-label"><IconGlobe /> Distribución geográfica</div>
              <div className="lp-geo-list">
                {GEO.map(g => (
                  <div key={g.country} className="lp-geo-item">
                    <div className="lp-geo-row">
                      <span className="lp-geo-country">{g.country}</span>
                      <span className="lp-geo-pct">{g.pct}%</span>
                    </div>
                    <div className="lp-geo-bar">
                      <div className="lp-geo-fill" style={{ width: `${g.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Rango de edad */}
            <div className="lp-bento-card reveal reveal-delay-2">
              <div className="lp-bento-label"><IconBar /> Rango de edad</div>
              <div className="lp-age-list">
                {AGE.map(a => (
                  <div key={a.range} className="lp-age-item">
                    <span className="lp-age-label">{a.range}</span>
                    <div className="lp-age-bar-wrap">
                      <div className="lp-age-fill" style={{ width: `${a.pct}%` }}>
                        <span className="lp-age-pct">{a.pct}%</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Género */}
            <div className="lp-bento-card reveal reveal-delay-1">
              <div className="lp-bento-label"><IconUsers /> Género de audiencia</div>
              <div className="lp-gender-row">
                <div className="lp-donut-wrap">
                  <div className="lp-donut">
                    <div className="lp-donut-inner">
                      <span className="lp-donut-pct">65%</span>
                      <span className="lp-donut-sub">Fem.</span>
                    </div>
                  </div>
                </div>
                <div className="lp-gender-legend">
                  {[["--f","Femenino","65%"],["--m","Masculino","35%"]].map(([cls,lbl,pct]) => (
                    <div key={lbl} className="lp-legend-item">
                      <span className={`lp-legend-dot lp-legend-dot${cls}`} />
                      <span className="lp-legend-label">{lbl}</span>
                      <span className="lp-legend-pct">{pct}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Engagement */}
            <div className="lp-bento-card reveal reveal-delay-2">
              <div className="lp-bento-label"><IconHeart /> Engagement</div>
              <div className="lp-eng-list">
                {[
                  { lbl: "Tasa de retención",     val: "68%",   color: "var(--gold4)" },
                  { lbl: "Tasa de likes",          val: "8.2%",  color: "var(--green)" },
                  { lbl: "Comentarios / video",    val: "120+",  color: "var(--gold5)" },
                  { lbl: "Crecimiento mensual",    val: "+4.5%", color: "var(--gold5)" },
                  { lbl: "Visualizaciones / mes",  val: "80K+",  color: "var(--gold4)" },
                ].map(m => (
                  <div key={m.lbl} className="lp-eng-row">
                    <span className="lp-eng-lbl">{m.lbl}</span>
                    <span className="lp-eng-val" style={{ color: m.color }}>{m.val}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>

          {/* Why advertise */}
          <div className="lp-divider" />
          <div className="lp-section-label reveal" style={{ marginTop: 0 }}>Por qué colaborar con nosotros</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14, marginTop:20 }} className="reveal reveal-delay-1">
            {[
              { icon: "◈", title: "Audiencia de nicho",      desc: "Altamente segmentada en wellness, espiritualidad y desarrollo personal." },
              { icon: "◉", title: "Alta retención",           desc: "68% de retención promedio — la audiencia realmente consume el contenido." },
              { icon: "◎", title: "Confianza establecida",    desc: "Una comunidad que confía en las recomendaciones del canal." },
            ].map(c => (
              <div key={c.title} style={{
                background:"rgba(8,6,2,0.70)", border:"1px solid var(--bd-dim)",
                borderRadius:"var(--r-lg)", padding:"24px 20px"
              }}>
                <div style={{ fontSize:"1.4rem", color:"var(--gold4)", marginBottom:10, fontFamily:"var(--ff-h)" }}>{c.icon}</div>
                <div style={{ fontFamily:"var(--ff-h)", fontSize:"0.84rem", fontWeight:700, color:"var(--tx)", marginBottom:6 }}>{c.title}</div>
                <div style={{ fontSize:"0.74rem", color:"var(--tx3)", lineHeight:1.60 }}>{c.desc}</div>
              </div>
            ))}
          </div>

        </div>
      </section>
    </>
  )
}
