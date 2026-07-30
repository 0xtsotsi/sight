import { useEffect, useRef, useState } from 'react'
import FieldLabel from './components/FieldLabel'
import { handleArrowStep } from './lib/number-step'
import { parseImportant, readProp, withImportant } from './lib/prop-read'
import type { ParsedRule } from './lib/types'

// A labeled text field bound to a single CSS property on a rule, with live
// (debounced) canvas updates as you type, an authoritative commit on blur, and
// arrow-key number stepping. Shared by the bespoke section controls.
export default function PropField({
  rule,
  busy,
  prop,
  label,
  placeholder = '—',
  labelClassName = 'embed-editor_size-label',
  inputClassName = 'embed-editor_size-input',
  onSetProp,
  onClearProp,
  onLiveSetProp,
}: {
  rule: ParsedRule
  busy: boolean
  prop: string
  label: string
  placeholder?: string
  labelClassName?: string
  inputClassName?: string
  onSetProp: (prop: string, value: string, important: boolean) => void
  onClearProp: (prop: string | string[]) => void
  onLiveSetProp: (prop: string, value: string, important: boolean) => void
}) {
  const found = readProp(rule, prop)
  const external = found ? withImportant(found) : ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  const liveTimer = useRef<number | null>(null)

  useEffect(() => { if (!focused.current) setDraft(external) }, [external])

  const cancelLive = () => {
    if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null }
  }
  useEffect(() => cancelLive, [])

  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      const trimmed = text.trim()
      if (!trimmed) return
      const parsed = parseImportant(trimmed)
      onLiveSetProp(prop, parsed.value, parsed.important)
    }, 100)
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (!trimmed) { onClearProp(prop); return }
    const parsed = parseImportant(trimmed)
    onSetProp(prop, parsed.value, parsed.important)
  }

  return (
    <>
      <FieldLabel className={labelClassName} active={Boolean(found)} disabled={busy} onReset={() => onClearProp(prop)} resetLabel="Clear">
        {label}
      </FieldLabel>
      <input
        className={`u-input ${inputClassName}`}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); scheduleLive(event.target.value) }}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; cancelLive(); commit() }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.currentTarget.blur(); return }
          const stepped = handleArrowStep(event)
          if (!stepped) return
          event.preventDefault()
          const el = event.currentTarget
          el.value = stepped.text
          el.setSelectionRange(stepped.caret, stepped.caret)
          setDraft(stepped.text)
          scheduleLive(stepped.text)
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
      />
    </>
  )
}
