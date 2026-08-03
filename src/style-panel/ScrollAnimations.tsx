import { useEffect, useMemo, useRef, useState } from 'react'
import Select, { type SelectOption } from './components/Select'
import type { ResolvedProp } from './lib/resolved'
import {
  emitAnimationRange,
  emitAnimationRangeEnd,
  emitAnimationRangeStart,
  emitAnimationTimeline,
  emitKeyframes,
  parseAnimationRange,
  parseAnimationRangeEnd,
  parseAnimationRangeStart,
  parseAnimationTimeline,
  parseKeyframes,
  parseViewTimelineName,
  firstAndLastStops,
} from './lib/scroll-timeline.js'

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
}
type TimelineSource = 'none' | 'scroll' | 'view'
type Axis = 'block' | 'inline'
type AnimatedProperty = 'opacity' | 'translateY' | 'translateX' | 'scale' | 'rotate' | 'clip-path'
type Stop = { progress: number; value: string }

const TIMELINES: SelectOption<TimelineSource>[] = [
  { value: 'none', label: 'None' },
  { value: 'scroll', label: 'scroll()' },
  { value: 'view', label: 'view()' },
]
const AXES: SelectOption<Axis>[] = [
  { value: 'block', label: 'Block' },
  { value: 'inline', label: 'Inline' },
]
const PROPERTIES: SelectOption<AnimatedProperty>[] = [
  { value: 'opacity', label: 'Opacity' },
  { value: 'translateY', label: 'Transform · translateY' },
  { value: 'translateX', label: 'Transform · translateX' },
  { value: 'scale', label: 'Transform · scale' },
  { value: 'rotate', label: 'Transform · rotate' },
  { value: 'clip-path', label: 'Clip path · inset()' },
]
const DEFAULT_VALUES: Record<AnimatedProperty, [string, string]> = {
  opacity: ['0', '1'],
  translateY: ['40px', '0px'],
  translateX: ['40px', '0px'],
  scale: ['0.85', '1'],
  rotate: ['-12deg', '0deg'],
  'clip-path': ['20%', '0%'],
}

// Properties whose spec value is a transform function: those need wrapping
// and unwrapping. `opacity` is bare; `clip-path` uses `inset()`.
function cssProperty(property: AnimatedProperty): string {
  if (property === 'clip-path' || property === 'opacity') return property
  return 'transform'
}

function wrapValue(property: AnimatedProperty, value: string): string {
  if (property === 'opacity') return value
  if (property === 'clip-path') return value.trim().startsWith('inset(') ? value : `inset(${value})`
  return value.trim().startsWith(`${property}(`) ? value : `${property}(${value})`
}

function unwrapValue(property: AnimatedProperty, value: string): string {
  if (property === 'opacity') return value
  const fn = property === 'clip-path' ? 'inset' : property
  const match = value.trim().match(new RegExp(`^${fn}\\((.*)\\)$`, 'i'))
  return match ? match[1] : value
}

function inferProperty(raw: string): AnimatedProperty {
  const value = raw.toLowerCase()
  if (value.includes('translatex(')) return 'translateX'
  if (value.includes('scale(')) return 'scale'
  if (value.includes('rotate(')) return 'rotate'
  if (value.includes('inset(')) return 'clip-path'
  if (value.includes('translatey(')) return 'translateY'
  return 'opacity'
}

function TextField({ value, disabled, label, placeholder, onCommit }: {
  value: string; disabled: boolean; label: string; placeholder?: string; onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  return <input className="u-input scroll-animations-input" value={draft} disabled={disabled} aria-label={label}
    placeholder={placeholder} spellCheck={false}
    onFocus={() => { focused.current = true }} onChange={(event) => setDraft(event.target.value)}
    onBlur={() => { focused.current = false; onCommit(draft.trim()) }}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
}

function MiniTimeline({ stops, playhead }: { stops: Stop[]; playhead: number }) {
  const ordered = [...stops].sort((a, b) => a.progress - b.progress)
  const points = ordered.map((stop) => `${8 + stop.progress * 1.84},20`).join(' ')
  return (
    <svg className="scroll-animations-timeline" viewBox="0 0 200 40" role="img" aria-label={`Animation playhead ${Math.round(playhead)} percent`}>
      <line x1="8" y1="20" x2="192" y2="20" className="scroll-animations-track" />
      <polyline points={points} className="scroll-animations-progress" />
      {ordered.map((stop, index) => <circle key={`stop-${index}-${stop.progress}`} cx={8 + stop.progress * 1.84} cy="20" r="3" className="scroll-animations-stop" />)}
      <line x1={8 + playhead * 1.84} y1="7" x2={8 + playhead * 1.84} y2="33" className="scroll-animations-playhead" />
    </svg>
  )
}

export default function ScrollAnimationsSection({ read, busy, setProp, clearProp, liveSetProp }: Props) {
  const timelineCss = resolvedValue(read, 'animation-timeline')
  const timeline = parseAnimationTimeline(timelineCss)
  const source = timeline.source as TimelineSource
  // The `view-timeline-name` is a SEPARATE property — names do not live inside
  // `view()`. Read it independently so we never try to put it inside the
  // `animation-timeline` declaration.
  const viewTimelineName = parseViewTimelineName(resolvedValue(read, 'view-timeline-name'))
  // Prefer the shorthand `animation-range` if present; otherwise read the
  // longhands individually.
  const shorthandRange = resolvedValue(read, 'animation-range')
  const range = shorthandRange
    ? parseAnimationRange(shorthandRange)
    : {
        start: parseAnimationRangeStart(resolvedValue(read, 'animation-range-start')),
        end: parseAnimationRangeEnd(resolvedValue(read, 'animation-range-end')),
      }
  const storedKeyframes = resolvedValue(read, '--sight-scroll-keyframes')
  const inferred = inferProperty(storedKeyframes)
  const [property, setProperty] = useState<AnimatedProperty>(inferred)
  const defaults = DEFAULT_VALUES[property]
  // FIX (bug #1): the previous code read `targetProperty` here, which is
  // never defined in this scope — it threw a ReferenceError on render. Use the
  // in-scope `property` state.
  const parsedStops = parseKeyframes(storedKeyframes).map((stop: Stop) => ({ ...stop, value: unwrapValue(property, stop.value) }))
  const [stops, setStops] = useState<Stop[]>(parsedStops.length ? parsedStops : [
    { progress: 0, value: defaults[0] }, { progress: 100, value: defaults[1] },
  ])
  const [playhead, setPlayhead] = useState(0)
  const previewFrame = useRef<number | null>(null)

  useEffect(() => {
    if (!storedKeyframes) return
    const next = parseKeyframes(storedKeyframes).map((stop: Stop) => ({ ...stop, value: unwrapValue(property, stop.value) }))
    if (next.length) setStops(next)
  }, [storedKeyframes, property])

  useEffect(() => {
    if (source === 'none') { setPlayhead(0); return }
    const onScroll = () => {
      if (previewFrame.current != null) cancelAnimationFrame(previewFrame.current)
      previewFrame.current = requestAnimationFrame(() => {
        const root = document.scrollingElement
        const maximum = Math.max(1, (root?.scrollHeight || 1) - window.innerHeight)
        const next = Math.min(100, Math.max(0, ((root?.scrollTop || window.scrollY) / maximum) * 100))
        setPlayhead(next)
      })
    }
    window.addEventListener('scroll', onScroll, true)
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      if (previewFrame.current != null) cancelAnimationFrame(previewFrame.current)
    }
  }, [source])

  const emittedStops = useMemo(() => stops.map((stop) => ({ ...stop, value: wrapValue(property, stop.value) })), [property, stops])

  // Write the multi-stop store AND the actual animated property. Per the
  // CSS Scroll-driven Animations spec, `@keyframes` is not available for scroll
  // timelines — only a single property change driven by `animation-range`. We
  // honour that by writing ONLY the first + last stop values onto the real
  // property; the browser interpolates linearly between them via
  // `animation-range`. Middle stops stay in `--sight-scroll-keyframes` for
  // visual editor feedback (MiniTimeline) but cannot be honoured natively.
  const writeStops = (next: Stop[], live: boolean, targetProperty: AnimatedProperty = property) => {
    setStops(next)
    const emitted = emitKeyframes(next.map((stop) => ({ ...stop, value: wrapValue(targetProperty, stop.value) })))
    if (live) liveSetProp('--sight-scroll-keyframes', emitted, false)
    else setProp('--sight-scroll-keyframes', emitted, false)
    const bookends = firstAndLastStops(next)
    if (bookends.length) {
      const cssProp = cssProperty(targetProperty)
      // The first stop's value is the "at start" state and the last stop's
      // value is the "at end" state. The browser linearly interpolates the
      // property between them across `animation-range`.
      // `transform` is special — multiple functions are space-separated within
      // a single declaration. Here we only emit ONE function per property
      // (opacity, translateY, …), so we can safely write each stop as its own
      // declaration overwriting the previous. This gives a sensible single-axis
      // preview; multi-axis combinations need the full transform editor.
      liveSetProp(cssProp, wrapValue(targetProperty, bookends[0].value), false)
    }
  }

  // `animation-timeline` only carries the source + axis (per spec). Names live
  // on `view-timeline-name`, written separately.
  const setTimeline = (next: Partial<{ source: TimelineSource; axis: Axis }>) => {
    const merged = { ...timeline, ...next }
    const value = emitAnimationTimeline(merged)
    if ((next.source || timeline.source) === 'none') {
      clearProp(['animation-timeline', 'animation-range', 'animation-range-start', 'animation-range-end', 'view-timeline-name', 'view-timeline-axis', '--sight-scroll-keyframes'])
    } else {
      setProp('animation-timeline', value, false)
    }
  }

  const setAxis = (axis: Axis) => {
    setTimeline({ axis })
    // `view-timeline-axis` is only valid for `view()`, but emit it always so
    // re-selecting the source keeps the user's pick.
    if ((timeline.source || 'view') === 'view') setProp('view-timeline-axis', axis, false)
  }

  const setViewName = (name: string) => {
    if (name) setProp('view-timeline-name', name, false)
    else clearProp('view-timeline-name')
  }

  // Accept any whitespace-separated `name <offset>` string the user types. We
  // hand it to the range parser, which handles percentages, lengths, calc(),
  // and keywords uniformly.
  const setRange = (which: 'start' | 'end', value: string) => {
    const point = which === 'start'
      ? parseAnimationRangeStart(value)
      : parseAnimationRangeEnd(value)
    const nextRange = { ...range, [which]: point }
    const emitted = emitAnimationRange(nextRange)
    setProp('animation-range', emitted, false)
    // Also write the longhands so consumers reading either form stay in sync.
    setProp('animation-range-start', which === 'start' ? value : emitAnimationRangeStart(range.start), false)
    setProp('animation-range-end', which === 'end' ? value : emitAnimationRangeEnd(range.end), false)
  }

  const chooseProperty = (next: AnimatedProperty) => {
    setProperty(next)
    const values = DEFAULT_VALUES[next]
    writeStops([{ progress: 0, value: values[0] }, { progress: 100, value: values[1] }], false, next)
  }

  const patchStop = (index: number, patch: Partial<Stop>) => writeStops(
    stops.map((stop, stopIndex) => stopIndex === index ? { ...stop, ...patch } : stop),
    false,
  )
  const removeStop = (index: number) => writeStops(stops.filter((_, stopIndex) => stopIndex !== index), false)
  const addStop = () => writeStops([...stops, { progress: 50, value: defaults[1] }], false)

  return (
    <section className={`scroll-animations ${source === 'none' ? 'is-disabled' : ''}`} aria-label="Scroll animations">
      <div className="scroll-animations-heading">
        <div><strong>Scroll animations</strong><span>CSS scroll-driven animation</span></div>
        <span className="scroll-animations-baseline">Baseline 2025</span>
      </div>
      <div className="scroll-animations-row">
        <label>Timeline</label>
        <Select value={source} options={TIMELINES} onChange={(next) => setTimeline({ source: next })} ariaLabel="Timeline source" disabled={busy} />
      </div>
      {source !== 'none' && <div className="scroll-animations-view-grid">
        <div className="scroll-animations-row"><label>Axis</label><Select value={timeline.axis as Axis} options={AXES} onChange={setAxis} ariaLabel="Timeline axis" disabled={busy} /></div>
        {source === 'view' && <div className="scroll-animations-row"><label>Name</label><TextField value={viewTimelineName} disabled={busy} label="View timeline name" placeholder="--hero" onCommit={setViewName} /></div>}
      </div>}
      {source !== 'none' && <>
        <div className="scroll-animations-range">
          <div className="scroll-animations-row"><label>Range start</label><TextField value={`${range.start.name} ${range.start.offset}`.trim()} disabled={busy} label="Animation range start" onCommit={(value) => setRange('start', value)} /></div>
          <div className="scroll-animations-row"><label>Range end</label><TextField value={`${range.end.name} ${range.end.offset}`.trim()} disabled={busy} label="Animation range end" onCommit={(value) => setRange('end', value)} /></div>
        </div>
        <div className="scroll-animations-row"><label>Property</label><Select value={property} options={PROPERTIES} onChange={chooseProperty} ariaLabel="Animated property" disabled={busy} /></div>
        <MiniTimeline stops={emittedStops} playhead={playhead} />
        <div className="scroll-animations-keyframes-head"><span>Keyframes</span><button type="button" className="scroll-animations-add" onClick={addStop} disabled={busy}>+ Add stop</button></div>
        <div className="scroll-animations-keyframes">
          {stops.map((stop, index) => <div className="scroll-animations-stop-row" key={`row-${index}-${stop.progress}`}>
            <div className="scroll-animations-percent"><input type="number" min="0" max="100" value={stop.progress} disabled={busy} aria-label={`Stop ${index + 1} progress`} onChange={(event) => patchStop(index, { progress: Math.min(100, Math.max(0, Number(event.target.value))) })} /><span>%</span></div>
            <TextField value={stop.value} disabled={busy} label={`Stop ${index + 1} value`} onCommit={(value) => patchStop(index, { value: value || defaults[index ? 1 : 0] })} />
            <button type="button" className="scroll-animations-remove" onClick={() => removeStop(index)} disabled={busy || stops.length <= 1} aria-label={`Remove stop ${index + 1}`}>×</button>
          </div>)}
        </div>
        <p className="scroll-animations-note">Scroll the preview to follow the playhead. Only the first and last stop are written to the animated property — the browser interpolates linearly across <code>animation-range</code>. Middle stops shape the timeline preview only.</p>
      </>}
    </section>
  )
}