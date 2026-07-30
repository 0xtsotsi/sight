import { useRef, useState } from 'react'
import ColorPicker from './ColorPicker'

// A clickable color swatch (checkerboard behind a transparent fill) that opens the
// color picker anchored under it. Drop-in for any color field: pass the current
// value and an onChange that routes live drags vs. committed changes.
export default function ColorSwatch({ value, busy, onChange, ariaLabel = 'Choose color' }: {
  value: string
  busy?: boolean
  onChange: (color: string, live: boolean) => void
  ariaLabel?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="u-color-swatch"
        disabled={busy}
        aria-label={ariaLabel}
        onClick={() => setAnchor((a) => (a ? null : ref.current?.getBoundingClientRect() ?? null))}
      >
        <span className="u-color-swatch-fill" style={{ background: value.trim() || 'transparent' }} />
      </button>
      {anchor ? (
        <ColorPicker value={value} anchor={anchor} trigger={ref.current} onChange={onChange} onClose={() => setAnchor(null)} />
      ) : null}
    </>
  )
}
