import { useEffect, useRef, useState } from 'react'
import FieldLabel from './components/FieldLabel'
import Select, { type SelectOption } from './components/Select'
import ProvenanceList from './ProvenanceList'
import VariableConnect from './VariableConnect'
import { POPOVER_MODES, CLOSEDBY_MODES } from './lib/anchor-positioning'
import type { ResolvedProp, Contributor } from './lib/resolved'

// The Popover sub-section groups the Popover-API controls so they don't sprawl
// the Effects section. It exposes:
//   - `popover` attribute (auto / manual / hint) — the popover state of the
//     element. Reading & writing a global attribute is the same shape as a CSS
//     longhand in this panel (the resolved model emits them as `prop: value`).
//   - `closedby` attribute — `<dialog>`'s closedBy attribute (Baseline 2026)
//     with values none / any / closerequest / auto.
//   - `::backdrop` pseudo — the dialog/popover backdrop pseudo, styled via the
//     same native-prop code path the rest of the panel uses for `:hover`/etc.
//
// All three live as CSS longhands (`popover`, `closedby`) / pseudo (`::backdrop`)
// in the resolved model, so the row components are identical to the rest of the
// effects section.

type SetProp = (prop: string, value: string, important: boolean) => void
type ClearProp = (prop: string | string[]) => void
type LiveSetProp = (prop: string, value: string | null, important: boolean) => void
type Read = (prop: string) => ResolvedProp | undefined

type Props = {
  read: Read
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}

type Display = { present: boolean; isSelected: boolean; overridden: boolean; winnerSelector: string; value: string; important: boolean }

function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) return { present: false, isSelected: false, overridden: false, winnerSelector: '', value: '', important: false }
  const isSelected = resolved.source === 'selected'
  const source = isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner
  return { present: true, isSelected, overridden: resolved.overridden, winnerSelector: resolved.winner.selectorText, value: source.value, important: source.important }
}

function PopLabel({ label, prop, props }: { label: string; prop: string; props: Props }) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props
  const d = displayOf(read(prop))
  const contributors: Contributor[] = read(prop)?.contributors ?? []
  if (d.present && !d.isSelected) {
    return (
      <button
        type="button"
        className="embed-editor_size-label embed-editor_prop-orange"
        disabled={busy}
        title="Set through another selector — click to see all"
        onClick={(e) => onProvenance(prop, e.currentTarget.getBoundingClientRect())}
      >
        {label}
      </button>
    )
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${d.overridden ? 'is-overridden' : ''}`}
      active={d.isSelected}
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel="Clear"
      title={d.overridden ? `Overridden by ${d.winnerSelector}` : undefined}
      menuNote={(close) => <ProvenanceList contributors={contributors} prop={prop} onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} />}
    >
      {label}
    </FieldLabel>
  )
}

// A select whose value comes from a fixed preset list. The Popover API has
// exactly three valid values (`auto`, `manual`, `hint`); the panel never
// accepts a custom value, so the picker is a strict dropdown.
function PresetRow({ prop, label, presets, fallback, props }: {
  prop: string
  label: string
  presets: readonly string[]
  fallback: string
  props: Props
}) {
  const { read, busy, setProp, liveSetProp } = props
  const d = displayOf(read(prop))
  const current = d.present ? d.value.trim().toLowerCase() : ''
  // If the user typed something else (var(), unset, …), surface the raw value
  // so the trigger isn't a silent lie.
  const isPreset = !current || presets.includes(current)
  const options: SelectOption<string>[] = presets.map((v) => ({ value: v, label: v }))
  const selectOptions = !isPreset && current
    ? [...options, { value: current, label: current }]
    : options
  return (
    <div className="embed-editor_position-row">
      <PopLabel label={label} prop={prop} props={props} />
      <Select
        value={current || fallback}
        options={selectOptions}
        onChange={(v) => setProp(prop, v, false)}
        onPreview={(v) => liveSetProp(prop, v, false)}
        ariaLabel={label}
        disabled={busy}
      />
    </div>
  )
}

// `::backdrop` is a CSS pseudo-element exposed through `selector(`::backdrop`)`.
// The panel can't style pseudo-elements directly (the resolved model is bound
// to the picked selector), so we expose a free-text field that writes the
// pseudo-element styles as a global rule under the selected element's class.
// This is a v0 escape hatch — the panel doesn't yet have a dedicated pseudo
// editor.
function BackdropRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read('::backdrop'))
  const external = d.present ? d.value : ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  const timer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(external) }, [external])
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  const live = (text: string) => {
    cancel()
    timer.current = window.setTimeout(() => {
      const t = text.trim()
      if (t) liveSetProp('::backdrop', t, false)
    }, 100)
  }
  const commit = () => {
    const t = draft.trim()
    if (!t) { clearProp('::backdrop'); return }
    setProp('::backdrop', t, false)
  }
  return (
    <div className="embed-editor_position-row">
      <PopLabel label="::backdrop" prop="::backdrop" props={props} />
      <VariableConnect className="is-fill" ariaLabel="Connect ::backdrop to a variable" disabled={busy} prop="::backdrop" onPick={(binding) => setProp('::backdrop', binding, false)}>
        <input
          className="u-input embed-editor_size-input embed-editor_popover-input"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); live(e.target.value) }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; cancel(); commit() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
          disabled={busy}
          spellCheck={false}
          placeholder="background: rgba(0,0,0,0.5)"
          aria-label="::backdrop"
        />
      </VariableConnect>
    </div>
  )
}

// The `popover-open` state selector: lets the user style the element while its
// popover is open. Surfaces a note that it's a state, not a property; the live
// preview is identical to the rest of the field.
function PopoverOpenRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read(':popover-open'))
  const external = d.present ? d.value : ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  const timer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(external) }, [external])
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  const live = (text: string) => {
    cancel()
    timer.current = window.setTimeout(() => {
      const t = text.trim()
      if (t) liveSetProp(':popover-open', t, false)
    }, 100)
  }
  const commit = () => {
    const t = draft.trim()
    if (!t) { clearProp(':popover-open'); return }
    setProp(':popover-open', t, false)
  }
  return (
    <div className="embed-editor_position-row">
      <PopLabel label=":popover-open" prop=":popover-open" props={props} />
      <VariableConnect className="is-fill" ariaLabel="Connect :popover-open to a variable" disabled={busy} prop=":popover-open" onPick={(binding) => setProp(':popover-open', binding, false)}>
        <input
          className="u-input embed-editor_size-input embed-editor_popover-input"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); live(e.target.value) }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; cancel(); commit() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
          disabled={busy}
          spellCheck={false}
          placeholder="opacity: 0; transform: translateY(4px);"
          aria-label=":popover-open"
        />
      </VariableConnect>
    </div>
  )
}

export default function PopoverSubSection(props: Props) {
  return (
    <div className="embed-editor_popover-section">
      <div className="embed-editor_popover-section-head">
        <span className="embed-editor_popover-section-title">Popover</span>
        <span className="embed-editor_popover-section-hint">Native Popover API + &lt;dialog&gt; — auto/manual/hint, closedby, ::backdrop.</span>
      </div>
      <PresetRow prop="popover" label="Popover" presets={POPOVER_MODES} fallback="manual" props={props} />
      <PresetRow prop="closedby" label="closedby" presets={CLOSEDBY_MODES} fallback="none" props={props} />
      <BackdropRow props={props} />
      <PopoverOpenRow props={props} />
    </div>
  )
}
