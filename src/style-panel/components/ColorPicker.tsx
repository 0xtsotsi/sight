import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { colorMode, formatColor, formatHex, hsvaToRgba, parseColor, rgbaToHsl, rgbaToHsva, type ColorMode, type HSVA, type RGBA } from '../shared/color'

// A Webflow-style color chooser popover: a saturation/brightness square, hue and
// alpha sliders, an eyedropper, and hex / RGB / HSB inputs. Portaled to <body> and
// anchored under the swatch that opened it, so it clears the panel and any scroll.
// HSVA is the canonical internal state; output notation follows the input's (hex /
// rgb / hsl), with alpha forcing the alpha form.

type Props = {
  value: string
  anchor: DOMRect
  /** The swatch that opened the picker — excluded from the outside-close so clicking
   *  it again toggles closed instead of closing-then-reopening. */
  trigger?: HTMLElement | null
  onChange: (color: string, live: boolean) => void
  onClose: () => void
}

const CHECKER = 'repeating-conic-gradient(#808080 0% 25%, #a0a0a0 0% 50%) 50% / 10px 10px'
const HUE_BAR = 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// Track the pointer across a drag on `el`, reporting a 0..1 fraction of its width
// (and, for the 2D square, height). Live during the drag; committed on release.
function useDrag(onMove: (fx: number, fy: number, live: boolean) => void) {
  return (el: HTMLElement, e: React.PointerEvent) => {
    const rect = el.getBoundingClientRect()
    const report = (ev: PointerEvent | React.PointerEvent, live: boolean) =>
      onMove(clamp((ev.clientX - rect.left) / rect.width, 0, 1), clamp((ev.clientY - rect.top) / rect.height, 0, 1), live)
    report(e, true)
    const move = (ev: PointerEvent) => report(ev, true)
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      report(ev, false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
}

function Field({ label, value, onChange, wide }: { label: string; value: string; onChange: (v: string) => void; wide?: boolean }) {
  const [text, setText] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value) }, [value])
  return (
    <label className={`u-color-field ${wide ? 'is-wide' : ''}`}>
      <input
        className="u-input u-color-field-input"
        value={text}
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); onChange(e.target.value) }}
        onFocus={(e) => { focused.current = true; e.target.select() }}
        onBlur={() => { focused.current = false; setText(value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur(); return }
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          // Step numeric fields (R/G/B, H/S/L/B, A) by 1 (10 with Shift). A non-numeric
          // value like a hex string parses to NaN → left to the browser's default.
          const n = parseFloat(text)
          if (Number.isNaN(n)) return
          e.preventDefault()
          const next = String(n + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1))
          setText(next)
          onChange(next)
        }}
        aria-label={label}
      />
    </label>
  )
}

const EyedropperIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true"><path d="M10.5 2.5a1.7 1.7 0 0 1 2.4 2.4l-1 1 1 1-1.2 1.2-1-1L6 12.8 3 13.5l.7-3 4.1-4.1-1-1L8 4.2l1 1 1-1a1.7 1.7 0 0 1 .5-.4Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>
)

export default function ColorPicker({ value, anchor, trigger, onChange, onClose }: Props) {
  const parsed = useRef<RGBA>(parseColor(value) ?? { r: 0, g: 0, b: 0, a: value.trim() ? 1 : 0 })
  const [hsva, setHsva] = useState<HSVA>(() => rgbaToHsva(parsed.current))
  // HEX is ALWAYS visible (its own field); the toggle only cycles the channel
  // notation shown in the middle three fields (RGB → HSL → HSB). Output notation
  // follows the active channel — hsb has no CSS form, so it emits rgb.
  const [channel, setChannel] = useState<Exclude<ColorMode, 'hex'>>(() => {
    const m = colorMode(value)
    return m === 'hex' ? 'rgb' : m
  })
  const cycleChannel = () => {
    const order = ['rgb', 'hsl', 'hsb'] as const
    setChannel((c) => order[(order.indexOf(c) + 1) % order.length])
  }
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const emit = (next: HSVA, live: boolean) => { setHsva(next); onChange(formatColor(hsvaToRgba(next), channel), live) }
  const rgba = hsvaToRgba(hsva)
  const hsl = rgbaToHsl(rgba)
  const hueColor = formatHex({ ...hsvaToRgba({ h: hsva.h, s: 100, v: 100, a: 1 }), a: 1 })

  // Position under the swatch, clamped to the viewport.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const w = el.offsetWidth || 240
    const h = el.offsetHeight || 300
    const left = clamp(anchor.left, 8, window.innerWidth - w - 8)
    const below = anchor.bottom + 6
    const top = below + h > window.innerHeight - 8 && anchor.top - h - 6 > 8 ? anchor.top - h - 6 : below
    setPos({ top, left })
  }, [anchor])

  // Close on outside pointerdown / Escape.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !trigger?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [onClose, trigger])

  const dragSB = useDrag((fx, fy, live) => emit({ ...hsva, s: Math.round(fx * 100), v: Math.round((1 - fy) * 100) }, live))
  const dragHue = useDrag((fx, _fy, live) => emit({ ...hsva, h: Math.round(fx * 360) }, live))
  const dragAlpha = useDrag((fx, _fy, live) => emit({ ...hsva, a: Math.round(fx * 100) / 100 }, live))

  const setFromColor = (input: string, live: boolean) => {
    const c = parseColor(input)
    if (!c) return
    const next = rgbaToHsva(c)
    // Preserve hue/sat when picking a greyscale value so the square doesn't jump.
    if (next.s === 0) next.h = hsva.h
    if (next.v === 0 || next.s === 0) next.s = next.s === 0 ? hsva.s : next.s
    setHsva(next)
    onChange(formatColor(c, channel), live)
  }
  const eyedrop = () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!ED) return
    new ED().open().then((r) => setFromColor(r.sRGBHex, false)).catch(() => {})
  }

  const setNum = (key: 'h' | 's' | 'v' | 'a', raw: string, max: number) => {
    const n = parseFloat(raw)
    if (Number.isNaN(n)) return
    emit({ ...hsva, [key]: key === 'a' ? clamp(n / 100, 0, 1) : clamp(n, 0, max) }, false)
  }
  const alphaPct = Math.round(hsva.a * 100)

  // The three middle channel fields, per the current notation.
  const chLabels = channel === 'rgb' ? ['R', 'G', 'B'] : channel === 'hsl' ? ['H', 'S', 'L'] : ['H', 'S', 'B']
  const chVals =
    channel === 'rgb' ? [String(rgba.r), String(rgba.g), String(rgba.b)]
    : channel === 'hsl' ? [String(hsl.h), String(hsl.s), String(hsl.l)]
    : [String(hsva.h), String(hsva.s), String(hsva.v)]
  const setCh = (i: number, v: string) => {
    if (channel === 'rgb') {
      setFromColor(`rgba(${i === 0 ? v : rgba.r}, ${i === 1 ? v : rgba.g}, ${i === 2 ? v : rgba.b}, ${rgba.a})`, false)
    } else if (channel === 'hsl') {
      setFromColor(`hsla(${i === 0 ? v : hsl.h}, ${i === 1 ? v : hsl.s}%, ${i === 2 ? v : hsl.l}%, ${rgba.a})`, false)
    } else {
      setNum(i === 0 ? 'h' : i === 1 ? 's' : 'v', v, i === 0 ? 360 : 100)
    }
  }

  return createPortal(
    <div ref={rootRef} className="u-color-picker" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }} role="dialog" aria-label="Color picker">
      <div
        className="u-color-sb"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
        onPointerDown={(e) => { e.preventDefault(); dragSB(e.currentTarget, e) }}
      >
        <span className="u-color-sb-thumb" style={{ left: `${hsva.s}%`, top: `${100 - hsva.v}%`, background: formatHex(rgba) }} />
      </div>

      <div className="u-color-sliders">
        <button type="button" className={`u-color-eyedrop ${typeof (window as { EyeDropper?: unknown }).EyeDropper === 'function' ? '' : 'is-hidden'}`} onClick={eyedrop} title="Pick a color from the screen" aria-label="Eyedropper"><EyedropperIcon /></button>
        <div className="u-color-slider-stack">
          <div className="u-color-slider" style={{ background: HUE_BAR }} onPointerDown={(e) => { e.preventDefault(); dragHue(e.currentTarget, e) }}>
            <span className="u-color-slider-thumb" style={{ left: `${(hsva.h / 360) * 100}%` }} />
          </div>
          <div className="u-color-slider u-color-alpha" style={{ ['--picker-checker' as string]: CHECKER }} onPointerDown={(e) => { e.preventDefault(); dragAlpha(e.currentTarget, e) }}>
            <span className="u-color-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${hueColorWithSat(hsva)})` }} />
            <span className="u-color-slider-thumb" style={{ left: `${alphaPct}%` }} />
          </div>
        </div>
      </div>

      {/* HEX is always present; the middle three fields follow the channel notation. */}
      <div className="u-color-inputs">
        <Field label="HEX" wide value={formatHex(rgba)} onChange={(v) => setFromColor(v, false)} />
        <div className="u-color-channels">
          {chLabels.map((lab, i) => (
            <Field key={i} label={lab} value={chVals[i]} onChange={(v) => setCh(i, v)} />
          ))}
        </div>
        <Field label="A" value={String(alphaPct)} onChange={(v) => setNum('a', v, 100)} />
      </div>

      {/* Column labels: HEX and A are static; the middle spans the three channel
          fields and is the toggle — press it to cycle RGB → HSL → HSB. */}
      <div className="u-color-modes">
        <span className="u-color-mode-static is-hex">HEX</span>
        <button
          type="button"
          className="u-color-mode is-channel"
          onClick={cycleChannel}
          aria-label="Cycle RGB, HSL, HSB"
          title="Toggle RGB / HSL / HSB"
        >
          {chLabels.map((lab, i) => <span key={i}>{lab}</span>)}
        </button>
        <span className="u-color-mode-static is-alpha">A</span>
      </div>
    </div>,
    document.body,
  )
}

function hueColorWithSat(hsva: HSVA): string {
  return formatHex({ ...hsvaToRgba({ ...hsva, a: 1 }), a: 1 })
}
