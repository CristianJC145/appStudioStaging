import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react"
import { createPortal } from "react-dom"

// ─── Context ──────────────────────────────────────────────────
const ConfirmContext = createContext(null)

// ─── Icons ────────────────────────────────────────────────────
function IconDanger() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}

function IconWarning() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}

// ─── Variant config ───────────────────────────────────────────
const VARIANTS = {
  danger: {
    color:      "#e84c3c",
    colorAlpha: "rgba(232,76,60,",
    Icon:       IconDanger,
    defaultConfirm: "Eliminar",
  },
  warning: {
    color:      "#f0c040",
    colorAlpha: "rgba(240,192,64,",
    Icon:       IconWarning,
    defaultConfirm: "Continuar",
  },
}

// ─── Modal UI ─────────────────────────────────────────────────
function ConfirmModalUI({ title, description, variant = "danger", confirmLabel, cancelLabel, onConfirm, onCancel }) {
  const v           = VARIANTS[variant] ?? VARIANTS.danger
  const { Icon }    = v
  const confirmRef  = useRef(null)
  const cancelRef   = useRef(null)
  const overlayRef  = useRef(null)

  // Auto-focus cancel on open (safer default for destructive actions)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  // Escape to cancel
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onCancel])

  // Focus trap within modal
  const handleKeyDown = (e) => {
    if (e.key !== "Tab") return
    const focusable = [cancelRef.current, confirmRef.current].filter(Boolean)
    if (!focusable.length) return
    const first = focusable[0]
    const last  = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus() }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus() }
    }
  }

  return (
    <div
      ref={overlayRef}
      className="cm-overlay"
      onClick={onCancel}
      aria-hidden="true"
    >
      <div
        className={`cm-modal cm-modal--${variant}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cm-title"
        aria-describedby="cm-desc"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Icon */}
        <div
          className="cm-icon-wrap"
          style={{
            color:           v.color,
            background:      v.colorAlpha + "0.1)",
            borderColor:     v.colorAlpha + "0.22)",
            boxShadow: `0 0 24px ${v.colorAlpha}0.12)`,
          }}
        >
          <Icon />
        </div>

        {/* Text */}
        <div className="cm-body">
          <h2 id="cm-title" className="cm-title">{title}</h2>
          <p  id="cm-desc"  className="cm-desc">{description}</p>
        </div>

        {/* Actions */}
        <div className="cm-actions">
          <button
            ref={cancelRef}
            className="cm-btn cm-btn--cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className="cm-btn cm-btn--confirm"
            style={{
              background:  v.colorAlpha + "0.14)",
              borderColor: v.colorAlpha + "0.4)",
              color:       v.color,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background  = v.colorAlpha + "0.22)"
              e.currentTarget.style.boxShadow   = `0 0 18px ${v.colorAlpha}0.2)`
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background  = v.colorAlpha + "0.14)"
              e.currentTarget.style.boxShadow   = "none"
            }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Provider ─────────────────────────────────────────────────
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)

  const confirm = useCallback(({
    title,
    description  = "",
    variant      = "danger",
    confirmLabel,
    cancelLabel  = "Cancelar",
  }) => {
    const v = VARIANTS[variant] ?? VARIANTS.danger
    return new Promise((resolve) => {
      setState({
        title,
        description,
        variant,
        confirmLabel: confirmLabel ?? v.defaultConfirm,
        cancelLabel,
        resolve,
      })
    })
  }, [])

  const handleConfirm = useCallback(() => {
    setState(prev => { prev?.resolve(true);  return null })
  }, [])

  const handleCancel = useCallback(() => {
    setState(prev => { prev?.resolve(false); return null })
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && createPortal(
        <ConfirmModalUI
          {...state}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />,
        document.body
      )}
    </ConfirmContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────
export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>")
  return ctx
}
