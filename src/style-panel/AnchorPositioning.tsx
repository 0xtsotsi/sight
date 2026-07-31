import { useEffect, useRef, useState } from 'react'
import FieldLabel from './components/FieldLabel'
import Select, { type SelectOption } from './components/Select'
import ProvenanceList from './ProvenanceList'
import VariableConnect from './VariableConnect'
import { parseAnchorNames, parsePositionAnchor, parseInsetArea, INSET_AREA_PRESETS } from './lib/anchor-positioning'
import type { ResolvedProp, Contributor } from './lib/resolved'

// CSS anchor positioning (Baseline 2025) — a small sub-section in the Position
// panel that exposes `anchor-name`, `position-anchor`, `inset-area`, and the
// `anchor-size()` function. The first two are dashed-ident names; the panel
// reads the raw value and writes it back with no transformation. `inset-area`
// gets a preset picker plus a Custom escape hatch so you can still type the
// two-area pairs or the spelled-out `block-start end` style names.

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

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}

// The labelled property control: an active-blue button when the picked selector
// sets the prop, a dim caption when empty, and an orange override indicator when
// another selector wins. Click → reset menu (with provenance for the override).
function AnchorLabel({ label, prop, props }: { label: string; prop: string; props: Props }) {
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

// A free-text input that live-updates as you type and commits on blur. Mirrors
// `LiveField` in PositionSection — duplicated here to keep the section file
// standalone (otherwise PositionSection would have to export it).
function LiveTextField({ prop, placeholder, props }: { prop: string; placeholder: string; props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read(prop))
  const external = d.present ? (d.important ? `${d.value} !important` : d.value) : ''
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
      if (t) {
        const p = parseImportant(t)
        liveSetProp(prop, p.value, false)
      }
    }, 100)
  }
  const commit = () => {
    const t = draft.trim()
    if (!t) { clearProp(prop); return }
    const p = parseImportant(t)
    setProp(prop, p.value, false)
  }
  return (
    <VariableConnect className="is-fill" ariaLabel={`Connect ${prop} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
      <input
        className="u-input embed-editor_size-input embed-editor_anchor-input"
        value={draft}
        onChange={(e) => { setDraft(e.target.value); live(e.target.value) }}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; cancel(); commit() }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={prop}
      />
    </VariableConnect>
  )
}

// `anchor-name`: a comma-separated list of dashed-idents. Edit-time chips
// would be nice but the spec calls for "expose the raw value" — typing a list
// (or picking a single name) is the simplest and round-trips predictably.
function AnchorNameRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp } = props
  const d = displayOf(read('anchor-name'))
  const parsed = parseAnchorNames(d.present ? d.value : '')
  const placeholder = parsed.kind === 'names' ? '--my-anchor' : 'none'
  return (
    <div className="embed-editor_position-row">
      <AnchorLabel label="Anchor name" prop="anchor-name" props={props} />
      <div className="embed-editor_anchor-input-group">
        <LiveTextField prop="anchor-name" placeholder={placeholder} props={props} />
        <button
          type="button"
          className="embed-editor_anchor-clear"
          disabled={busy || !d.present}
          onClick={() => clearProp('anchor-name')}
          title="Clear anchor-name"
          aria-label="Clear anchor-name"
        >
          Reset
        </button>
      </div>
    </div>
  )
}

// `position-anchor`: a single dashed-ident or `none` / `auto`. We surface a preset
// select with `none` / `auto` / a Custom escape hatch, AND a free-text field for
// the dashed-ident (since the user has to make the name up — autocompleting from
// "anchor-name" values authored elsewhere is out of scope for this feature).
const POSITION_ANCHOR_PRESETS = ['none', 'auto']
const POSITION_ANCHOR_PRESET_SET = new Set(POSITION_ANCHOR_PRESETS)
const CUSTOM = '__custom__'

function PositionAnchorRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read('position-anchor'))
  const current = d.present ? d.value.trim() : ''
  const isPreset = !current || POSITION_ANCHOR_PRESET_SET.has(current.toLowerCase())
  const [forceCustom, setForceCustom] = useState(false)
  const customMode = forceCustom || (d.present && !isPreset)
  const options: SelectOption<string>[] = [
    ...POSITION_ANCHOR_PRESETS.map((v) => ({ value: v, label: v })),
    { value: CUSTOM, label: 'Custom…' },
  ]
  const pick = (v: string) => {
    if (v === CUSTOM) { setForceCustom(true); return }
    setForceCustom(false)
    setProp('position-anchor', v, false)
  }
  // The Custom field is the same free-text field used for the other rows.
  return (
    <div className="embed-editor_position-row">
      <AnchorLabel label="Position anchor" prop="position-anchor" props={props} />
      {customMode ? (
        <div className="embed-editor_anchor-input-group">
          <LiveTextField prop="position-anchor" placeholder="--target" props={props} />
          <button
            type="button"
            className="embed-editor_anchor-clear"
            disabled={busy}
            onClick={() => { setForceCustom(false); clearProp('position-anchor') }}
            title="Back to preset"
            aria-label="Back to preset"
          >
            Reset
          </button>
        </div>
      ) : (
        <Select
          value={current || 'none'}
          options={options}
          onChange={pick}
          onPreview={(v) => liveSetProp('position-anchor', v === CUSTOM ? null : v, false)}
          ariaLabel="Position anchor"
          disabled={busy}
        />
      )}
    </div>
  )
}

// `inset-area`: preset picker for the named areas, with a Custom escape hatch for
// the two-area pairs and the spelled-out `block-start` style names.
const INSET_AREA_PRESET_SET = new Set(INSET_AREA_PRESETS)

function InsetAreaRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read('inset-area'))
  const v = d.present ? d.value.trim() : ''
  const parsed = parseInsetArea(v)
  const isPreset = parsed.kind === 'keyword' && INSET_AREA_PRESET_SET.has(parsed.value)
  const [forceCustom, setForceCustom] = useState(false)
  const customMode = forceCustom || (d.present && !isPreset && parsed.kind !== 'raw')
  const rawMode = parsed.kind === 'raw' && d.present
  const options: SelectOption<string>[] = INSET_AREA_PRESETS.map((p) => ({ value: p, label: p }))
  const pick = (next: string) => {
    if (next === CUSTOM) { setForceCustom(true); return }
    setForceCustom(false)
    setProp('inset-area', next, false)
  }
  return (
    <div className="embed-editor_position-row">
      <AnchorLabel label="Inset area" prop="inset-area" props={props} />
      {customMode || rawMode ? (
        <div className="embed-editor_anchor-input-group">
          <LiveTextField prop="inset-area" placeholder="top left" props={props} />
          <button
            type="button"
            className="embed-editor_anchor-clear"
            disabled={busy}
            onClick={() => { setForceCustom(false); clearProp('inset-area') }}
            title="Back to preset"
            aria-label="Back to preset"
          >
            Reset
          </button>
        </div>
      ) : (
        <Select
          value={isPreset ? parsed.value : 'none'}
          options={[...options, { value: CUSTOM, label: 'Custom…' }]}
          onChange={pick}
          onPreview={(next) => liveSetProp('inset-area', next === CUSTOM ? null : next, false)}
          ariaLabel="Inset area"
          disabled={busy}
        />
      )}
    </div>
  )
}

// A passive info row that explains `anchor-size()` is used inside `width` /
// `height` / `inset-area` — there's no dedicated longhand, so the row points
// to the existing fields where the function is typed. Sits at the bottom of
// the sub-section so it doesn't interrupt the editing flow.
function AnchorSizeNoteRow({ props }: { props: Props }) {
  const { read } = props
  const hasSize = (() => {
    const dotted = (val: string | undefined) => !!val && /anchor-size\s*\(/i.test(val)
    const w = displayOf(read('width')).value
    const h = displayOf(read('height')).value
    const ia = displayOf(read('inset-area')).value
    return dotted(w) || dotted(h) || dotted(ia)
  })()
  return (
    <div className="embed-editor_anchor-note">
      <span className="embed-editor_anchor-note-label">anchor-size()</span>
      <span className="embed-editor_anchor-note-text">
        {hasSize
          ? 'Used inside width / height / inset-area to read the anchor\'s size.'
          : 'Type `anchor-size(width)` or `anchor-size(height)` inside width, height, or inset-area to read the anchor\'s size.'}
      </span>
    </div>
  )
}

// The full sub-section: the four rows + a small header. Sits inside the Position
// section as a nested block — `position` lives on the anchor's element, the
// other three live on the target, so the panel shows them all together and lets
// the user pick which selector they're authoring.
export default function AnchorPositioning(props: Props) {
  return (
    <div className="embed-editor_anchor-section">
      <div className="embed-editor_anchor-section-head">
        <span className="embed-editor_anchor-section-title">Anchor</span>
        <span className="embed-editor_anchor-section-hint">CSS anchor positioning — names the anchor and the target's relationship to it.</span>
      </div>
      <AnchorNameRow props={props} />
      <PositionAnchorRow props={props} />
      <InsetAreaRow props={props} />
      <AnchorSizeNoteRow props={props} />
    </div>
  )
}
