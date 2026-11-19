// Small UI kit shared by the panels.
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'

const ICONS: Record<string, string> = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M6 4.5h4.2v15H6zM13.8 4.5H18v15h-4.2z',
  start: 'M6 5h2.2v14H6zM19 5.5v13L9.5 12z',
  end: 'M15.8 5H18v14h-2.2zM5 5.5v13L14.5 12z',
  prev: 'M16.5 5.5v13L7 12zM6 6h1.6v12H6z',
  next: 'M7.5 5.5v13L17 12zM16.4 6H18v12h-1.6z',
  scissors: 'M9.6 7.6a3.2 3.2 0 1 0-1.4 1.4L10.6 12l-2.4 3a3.2 3.2 0 1 0 1.4 1.4l2.4-3 5.8 7.3h2.6L9.6 7.6zM6.8 8a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8zm0 10.8a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8zM14 10.6l1.3 1.6 5.1-6.4h-2.6z',
  undo: 'M9 5 3.5 10.5 9 16v-3.6h4.2a3.8 3.8 0 0 1 0 7.6H8v2h5.2a5.8 5.8 0 0 0 0-11.6H9z',
  redo: 'M15 5l5.5 5.5L15 16v-3.6h-4.2a3.8 3.8 0 0 0 0 7.6H16v2h-5.2a5.8 5.8 0 0 1 0-11.6H15z',
  magnet: 'M5 4h5v8.5a2 2 0 0 0 4 0V4h5v8.5a7 7 0 0 1-14 0zm1.8 1.8v3h1.4v-3zm9 0v3h1.4v-3z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  minus: 'M5 11h14v2H5z',
  trash: 'M9 3.5h6l.8 1.5H20v2H4V5h4.2zM6 8.5h12l-.9 11a1.6 1.6 0 0 1-1.6 1.5h-7a1.6 1.6 0 0 1-1.6-1.5zm3.2 2v8h1.6v-8zm4 0v8h1.6v-8z',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM14.5 8.3a5 5 0 0 1 0 7.4l-1.1-1.3a3.2 3.2 0 0 0 0-4.8zM17 5.6a8.6 8.6 0 0 1 0 12.8l-1.2-1.3a6.8 6.8 0 0 0 0-10.2z',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM14.6 9.2l2.2 2.2 2.2-2.2 1.3 1.3-2.2 2.2 2.2 2.2-1.3 1.3-2.2-2.2-2.2 2.2-1.3-1.3 2.2-2.2-2.2-2.2z',
  eye: 'M12 6c4.6 0 8 3.6 9.4 6-1.4 2.4-4.8 6-9.4 6s-8-3.6-9.4-6C4 9.600 7.400 6 12 6zm0 2.200a3.800 3.800 0 1 0 0 7.600 3.800 3.800 0 0 0 0-7.600zm0 2a1.800 1.800 0 1 1 0 3.600 1.800 1.800 0 0 1 0-3.600z',
  eyeOff: 'M4.300 3 21 19.700 19.700 21l-3-3A9.700 9.700 0 0 1 12 19c-4.600 0-8-3.600-9.400-6a14 14 0 0 1 3.500-4L3 4.300zm5.200 7.800a3.800 3.800 0 0 0 4.700 4.700zM12 6c4.600 0 8 3.600 9.400 6a14 14 0 0 1-2.500 3.100l-3.200-3.200A3.800 3.800 0 0 0 12 8.200l-2.100-2A9.600 9.600 0 0 1 12 6z',
  link: 'M10.600 13.400a3.500 3.500 0 0 1 0-5l3-3a3.500 3.500 0 0 1 5 5l-1.300 1.300-1.300-1.300 1.300-1.300a1.700 1.700 0 0 0-2.400-2.400l-3 3a1.700 1.700 0 0 0 0 2.400zm2.800-2.800a3.500 3.500 0 0 1 0 5l-3 3a3.500 3.500 0 0 1-5-5l1.300-1.300L8 13.600 6.700 14.900a1.700 1.700 0 0 0 2.400 2.400l3-3a1.700 1.700 0 0 0 0-2.400z',
  text: 'M5 5h14v3.500h-1.800V7H13v10.500h2V19H9v-1.500h2V7H6.800v1.500H5z',
  film: 'M4 4.500h16v15H4zm2 2v2h2v-2zm0 4v3h2v-3zm0 5v2h2v-2zm10-9v2h2v-2zm0 4v3h2v-3zm0 5v2h2v-2zm-6-9v11h4v-11z',
  music: 'M9 4.500 19 3v12.200a3 3 0 1 1-1.800-2.700V7l-6.400 1v8.700A3 3 0 1 1 9 14z',
  image: 'M4 5h16v14H4zm1.800 1.800v8.400l3.700-3.700 3 3 2.500-2.500 3.200 3.200V6.800zM9 8a1.700 1.700 0 1 1 0 3.400A1.700 1.700 0 0 1 9 8z',
  upload: 'M11 16V8.400L8.200 11.200 7 10l5-5 5 5-1.200 1.200L13 8.400V16zM5 18h14v2H5z',
  export: 'M5 4h9v2H7v12h10v-4h2v6H5zm9.500 1h5.500v5.500h-2V8.400l-5.800 5.800-1.400-1.400L16.600 7h-2.100z',
  close: 'M6.400 5 12 10.600 17.600 5 19 6.400 13.400 12l5.600 5.600-1.400 1.400L12 13.400 6.400 19 5 17.600 10.600 12 5 6.400z',
  up: 'M12 7.500 18.500 14l-1.400 1.400L12 10.300 6.900 15.400 5.500 14z',
  down: 'M12 16.500 5.500 10l1.400-1.400 5.100 5.100 5.100-5.100L18.500 10z',
  right: 'M9 5.500 15.500 12 9 18.500 7.600 17.100l5.100-5.100-5.100-5.100z',
  warn: 'M12 3.500 22 20H2zm-1 6v5.500h2V9.500zm0 7.200v2h2v-2z',
  fit: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  reset: 'M12 5a7 7 0 1 1-6.600 4.700l1.900.6A5 5 0 1 0 12 7v3L7.500 6 12 2z',
  folder: 'M3 5.500h6.500l2 2H21v11H3zm2 4v7h14v-7z',
  sparkle: 'M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM18.500 15l.9 2.600L22 18.500l-2.600.9-.9 2.600-.9-2.600-2.600-.9 2.600-.9z',
  zoom: 'M10.500 4a6.500 6.500 0 0 1 5.200 10.400l4.200 4.200-1.400 1.400-4.200-4.200A6.500 6.500 0 1 1 10.500 4zm0 2a4.500 4.500 0 1 0 0 9 4.500 4.500 0 0 0 0-9zm-.900 1.800h1.800v1.800h1.800v1.800h-1.800v1.800H9.600v-1.800H7.800V9.600h1.800z',
  move: 'M12 2.500l3.200 3.200h-2.300V11h5.400V8.800L21.500 12l-3.200 3.200V13h-5.400v5.300h2.300L12 21.500l-3.200-3.200h2.300V13H5.700v2.200L2.500 12l3.200-3.200V11h5.400V5.700H8.800z',
  keyboard: 'M3 6h18v12H3zm2 2v8h14V8zm1.500 1.500h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zM8 13h8v1.800H8z',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm-1 7.500v6h2v-6zm0-3.200v2h2v-2z',
  layers: 'M12 3 2 8l10 5 10-5zm0 2.200L17.600 8 12 10.800 6.400 8zM4.200 11.100 2 12.200l10 5 10-5-2.200-1.100L12 15zm0 4.300L2 16.500l10 5 10-5-2.200-1.100L12 19.300z'
}

export function Icon({ name, size = 16, style }: { name: string; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style} aria-hidden="true">
      <path d={ICONS[name] ?? ''} fillRule="evenodd" />
    </svg>
  )
}

interface BtnProps {
  icon?: string
  children?: ReactNode
  title?: string
  onClick?: (e: React.MouseEvent) => void
  active?: boolean
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  small?: boolean
  className?: string
  testId?: string
}

export function Btn({ icon, children, title, onClick, active, primary, danger, disabled, small, className, testId }: BtnProps) {
  const cls = ['btn', !children && 'btn-icon', active && 'active', primary && 'primary', danger && 'danger', small && 'small', className]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} title={title} aria-label={title} onClick={onClick} disabled={disabled} data-testid={testId}>
      {icon && <Icon name={icon} size={small ? 14 : 16} />}
      {children}
    </button>
  )
}

const clampNum = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))

function trimNum(v: number, step: number): string {
  const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)))
  return String(Number(v.toFixed(decimals)))
}

interface NumProps {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** Display multiplier (100 shows 0..1 as 0..100). */
  display?: number
  unit?: string
  width?: number
  testId?: string
  title?: string
}

/** A numeric field that commits on Enter/blur and supports arrow keys and the mouse wheel. */
export function Num({ value, onChange, min, max, step = 1, display = 1, unit, width = 64, testId, title }: NumProps) {
  const shownStep = step * display
  const [text, setText] = useState<string | null>(null)
  const shown = trimNum(value * display, shownStep)
  const commit = (raw: string) => {
    const v = Number(raw.replace(',', '.'))
    setText(null)
    if (raw.trim() === '' || !Number.isFinite(v)) return
    const next = clampNum(v / display, min, max)
    if (next !== value) onChange(next)
  }
  const nudge = (dir: number, big: boolean) => onChange(clampNum(Number((value + dir * step * (big ? 10 : 1)).toFixed(6)), min, max))
  return (
    <span className="num" style={{ width }} title={title}>
      <input
        type="text"
        inputMode="decimal"
        data-testid={testId}
        value={text ?? shown}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          else if (e.key === 'Escape') {
            setText(null)
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            setText(null)
            nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey)
          }
        }}
      />
      {unit && <span className="num-unit">{unit}</span>}
    </span>
  )
}

interface SliderProps extends NumProps {
  label?: string
  /** Value restored on double-click. */
  reset?: number
  /** Draws a tick at this value (e.g. 100% on a 0–500% volume slider). */
  mark?: number
}

export function Slider({ label, reset, mark, ...p }: SliderProps) {
  const { value, onChange, min = 0, max = 1, step = 0.01 } = p
  const frac = (v: number) => ((clampNum(v, min, max) - min) / (max - min)) * 100
  return (
    <label className="field">
      {label && <span className="field-label" title={label}>{label}</span>}
      <span className="slider-wrap">
        <input
          type="range"
          className="slider"
          min={min}
          max={max}
          step={step}
          value={value}
          style={{ '--fill': `${frac(value)}%` } as CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => reset !== undefined && onChange(reset)}
          title={reset !== undefined ? t('common.doubleClickReset') : undefined}
        />
        {mark !== undefined && <span className="slider-mark" style={{ left: `${frac(mark)}%` }} />}
      </span>
      <Num {...p} width={p.width ?? 62} />
    </label>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label" title={label}>{label}</span>
      <span className="field-body">{children}</span>
    </div>
  )
}

export function Color({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  const [text, setText] = useState<string | null>(null)
  const body = (
    <span className="color">
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
      <input
        type="text"
        value={text ?? value}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          const v = e.target.value.trim()
          setText(null)
          if (/^#?[0-9a-f]{6}$/i.test(v)) onChange(v.startsWith('#') ? v.toLowerCase() : '#' + v.toLowerCase())
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </span>
  )
  return label ? <Field label={label}>{body}</Field> : body
}

export function Select<T extends string>({ value, onChange, options, testId }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; disabled?: boolean }[]
  testId?: string
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
      ))}
    </select>
  )
}

export function Toggle({ value, onChange, label, testId }: { value: boolean; onChange: (v: boolean) => void; label: string; testId?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className="toggle-track" />
      <span>{label}</span>
    </label>
  )
}

export function Section({ title, icon, children, right, defaultOpen = true }: {
  title: string
  icon?: string
  children: ReactNode
  right?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="section">
      <header className="section-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'right'} size={14} />
        {icon && <Icon name={icon} size={15} />}
        <span className="section-title">{title}</span>
        <span className="section-right" onClick={(e) => e.stopPropagation()}>{right}</span>
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}

/** Closes a popover when clicking outside it or pressing Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [open, close])
  return ref
}

export function Modal({ title, children, onClose, width = 520, footer }: {
  title: string
  children: ReactNode
  onClose?: () => void
  width?: number
  footer?: ReactNode
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width }} role="dialog" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          {onClose && <Btn icon="close" title={t('common.close')} onClick={onClose} />}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function formatTime(t: number, fps = 30): string {
  const s = Math.max(0, t)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const f = Math.floor((s - Math.floor(s)) * Math.round(fps) + 1e-6)
  const pad = (v: number, l = 2) => String(v).padStart(l, '0')
  return `${h ? pad(h) + ':' : ''}${pad(m)}:${pad(sec)}:${pad(f)}`
}

export function formatDuration(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '0:00'
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = b / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
