// CSS Scroll-driven Animations — parser/serializer for the Style Panel.
//
// We round-trip four pieces of the spec:
//   • `animation-timeline`        — `none | scroll(<axis>) | view(<axis>)`
//   • `animation-range`            — `<start> <end>` (range-start/range-end longhands)
//   • `view-timeline-name`         — `--ident` (separate property; names live here,
//                                    NOT inside `view()`, since the spec forbids it)
//   • `--sight-scroll-keyframes`   — our private multi-stop store, serialised as
//                                    `0%: <value>, 100%: <value>` (Webflow-style
//                                    stops-with-progress syntax).
//
// IMPORTANT — multi-stop UI vs. spec reality:
//   The CSS Scroll-driven Animations spec does NOT define `@keyframes` for
//   scroll timelines; only `animation-range-start`/`animation-range-end` and a
//   single property change driven by `animation-timeline`. To respect that
//   while still giving the user multi-stop visual feedback (timeline SVG), we
//   KEEP the multi-stop UI in `--sight-scroll-keyframes`, but on commit we only
//   emit the FIRST stop's value (at progress 0) and the LAST stop's value (at
//   progress 100) onto the actual animated property — the browser interpolates
//   via `animation-range`. Middle stops are preserved for the visual editor
//   only.
//
// Token-aware splitting (parens, quotes) is done with a small helper rather
// than regex so we handle `calc(…)`, `inset(…)`, etc. correctly.

const TIMELINE_RE = /^(none|scroll|view)(?:\((.*)\))?$/i

function splitTopLevel(input, delimiter = ',') {
  const result = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (char === quote && input[index - 1] !== '\\') quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === delimiter && depth === 0) {
      result.push(input.slice(start, index).trim())
      start = index + 1
    }
  }
  result.push(input.slice(start).trim())
  return result.filter(Boolean)
}

// Split on top-level whitespace runs (skips spaces inside parentheses/quotes).
function splitTopLevelWhitespace(input) {
  const result = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (char === quote && input[index - 1] !== '\\') quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (/\s/.test(char) && depth === 0) {
      if (index > start) result.push(input.slice(start, index).trim())
      start = index + 1
    }
  }
  if (start < input.length) result.push(input.slice(start).trim())
  return result.filter(Boolean)
}

// `<range-start>` / `<range-end>` accepts percentages, lengths, calc(),
// `normal`, `cover`, `contain`, `entry`, `exit`, `entry-crossing`, `exit-crossing`,
// or `<name> <offset>` (two tokens). Returns `{ name, offset, raw }` where
// `raw` is preserved when the input doesn't match any of those forms so
// the user's manually-written CSS round-trips intact.
const RANGE_NAME_KW = new Set(['normal', 'cover', 'contain', 'entry', 'exit', 'entry-crossing', 'exit-crossing'])
const LENGTH_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc)$/i
const PERCENT_RE = /^-?(?:\d+\.?\d*|\.\d+)%$/
const CALC_RE = /^calc\(/i

function isOffset(token) {
  return PERCENT_RE.test(token) || LENGTH_RE.test(token) || CALC_RE.test(token)
}

function parseRangePoint(value, fallbackName, fallbackOffset) {
  const text = String(value || '').trim()
  if (!text) return { name: fallbackName, offset: fallbackOffset, raw: '' }
  // If the whole thing is one of the keywords, it's a name with the default offset.
  if (RANGE_NAME_KW.has(text.toLowerCase())) {
    return { name: text.toLowerCase(), offset: '', raw: '' }
  }
  // If the whole thing is just an offset, the name defaults and offset is given.
  if (isOffset(text)) {
    return { name: fallbackName, offset: text, raw: '' }
  }
  // Otherwise expect `<name> <offset>` (or just `<name>` with no offset).
  // Tokenise at top level so calc() doesn't get split.
  const tokens = splitTopLevelWhitespace(text)
  if (tokens.length === 1) {
    return { name: tokens[0].toLowerCase(), offset: '', raw: '' }
  }
  // Find the offset token — it's typically the last one. If the last token is
  // an offset, peel it off; otherwise treat all tokens as the name (raw path).
  const last = tokens[tokens.length - 1]
  if (isOffset(last)) {
    return {
      name: tokens.slice(0, -1).join(' ').toLowerCase() || fallbackName,
      offset: last,
      raw: '',
    }
  }
  return { name: tokens.join(' ').toLowerCase(), offset: '', raw: text }
}

function rangePointToString(point, fallbackName, fallbackOffset) {
  if (!point) return `${fallbackName} ${fallbackOffset}`
  if (point.raw) return point.raw
  const name = point.name || fallbackName
  const offset = point.offset || fallbackOffset
  return offset && offset !== fallbackOffset ? `${name} ${offset}` : name
}

// Parse `animation-timeline`. Per spec, names live in `view-timeline-name`,
// NOT inside `view()`, so we never store a name on the timeline object.
export function parseAnimationTimeline(css = '') {
  const value = String(css).trim()
  const match = value.match(TIMELINE_RE)
  if (!match) return { source: 'none', axis: 'block', name: '', raw: value }
  const source = match[1].toLowerCase()
  if (source === 'none') return { source: 'none', axis: 'block', name: '', raw: '' }
  const args = String(match[2] || '').trim()
  if (!args) return { source, axis: 'block', name: '', raw: '' }
  // Axis is the only legal token inside `scroll()`/`view()` per the spec.
  const lower = args.toLowerCase()
  if (lower === 'inline') return { source, axis: 'inline', name: '', raw: '' }
  if (lower === 'block') return { source, axis: 'block', name: '', raw: '' }
  // Anything else (e.g. user hand-wrote `view(block --hero)`) — preserve as raw
  // so re-emit round-trips unchanged.
  return { source, axis: 'block', name: '', raw: value }
}

// Emit `animation-timeline`. The axis IS emitted for both scroll() and view()
// (the previous code dropped it). Names go to `view-timeline-name`, not here.
export function emitAnimationTimeline(timeline = {}) {
  if (timeline.raw) return timeline.raw
  const source = timeline.source || 'none'
  if (source === 'none') return 'none'
  const axis = timeline.axis === 'inline' ? 'inline' : 'block'
  return `${source}(${axis})`
}

// `view-timeline-name: --hero` is its own property. We accept either a bare
// ident or a quoted one and normalise to the leading-dashes form.
export function parseViewTimelineName(css = '') {
  const trimmed = String(css).trim().replace(/^["']|["']$/g, '')
  return trimmed
}

export function emitViewTimelineName(name = '') {
  const trimmed = String(name || '').trim().replace(/^["']|["']$/g, '')
  return trimmed
}

// `animation-range` is `<start> <end>` (separated by `to`/`→`, or by a single
// `normal` keyword meaning defaults). We also accept the longhand split into
// `animation-range-start` and `animation-range-end` via `parseAnimationRangeStart/End`.
export function parseAnimationRange(css = '') {
  const value = String(css).trim()
  if (!value || value.toLowerCase() === 'normal') {
    return {
      start: { name: 'cover', offset: '0%', raw: '' },
      end: { name: 'cover', offset: '100%', raw: '' },
      raw: '',
    }
  }
  const separator = value.match(/\s+(?:to|→)\s+/i)
  if (separator) {
    const index = separator.index
    return {
      start: parseRangePoint(value.slice(0, index), 'cover', '0%'),
      end: parseRangePoint(value.slice(index + separator[0].length), 'cover', '100%'),
      raw: '',
    }
  }
  // No `to` separator. Split on top-level whitespace. Heuristic: if we have
  // two offset tokens, split between them; if we have exactly two keywords
  // (e.g. `entry exit`), split between them as well; otherwise pass the whole
  // thing as `start` with default `end`.
  const tokens = splitTopLevelWhitespace(value)
  const offsetIdx = tokens
    .map((token, index) => (isOffset(token) ? index : -1))
    .filter((index) => index >= 0)
  if (offsetIdx.length >= 2) {
    const split = offsetIdx[0] + 1
    return {
      start: parseRangePoint(tokens.slice(0, split).join(' '), 'cover', '0%'),
      end: parseRangePoint(tokens.slice(split).join(' '), 'cover', '100%'),
      raw: '',
    }
  }
  if (tokens.length === 2 && tokens.every((t) => RANGE_NAME_KW.has(t.toLowerCase()))) {
    return {
      start: parseRangePoint(tokens[0], 'cover', '0%'),
      end: parseRangePoint(tokens[1], 'cover', '100%'),
      raw: '',
    }
  }
  return {
    start: parseRangePoint(value, 'cover', '0%'),
    end: { name: 'cover', offset: '100%', raw: '' },
    raw: '',
  }
}

export function parseAnimationRangeStart(css = '') {
  return parseRangePoint(String(css).trim(), 'cover', '0%')
}

export function parseAnimationRangeEnd(css = '') {
  return parseRangePoint(String(css).trim(), 'cover', '100%')
}

export function emitAnimationRange(range = {}) {
  if (range && range.raw) return range.raw
  const start = rangePointToString(range && range.start, 'cover', '0%')
  const end = rangePointToString(range && range.end, 'cover', '100%')
  return `${start} ${end}`
}

export function emitAnimationRangeStart(point = {}) {
  return rangePointToString(point, 'cover', '0%')
}

export function emitAnimationRangeEnd(point = {}) {
  return rangePointToString(point, 'cover', '100%')
}

// `animation-name` in scroll-driven contexts — we accept anything but only
// forward it back verbatim (no validation). Returns the trimmed string.
export function parseAnimationName(css = '') {
  const trimmed = String(css).trim()
  return trimmed
}

export function emitAnimationName(name = '') {
  return String(name || '').trim()
}

// Keyframes (private `--sight-scroll-keyframes` format): `0%: <value>, 100%: <value>`.
// `parseKeyframes` also accepts an array (so the React state round-trips
// straight through). `emitKeyframes` clamps progress to 0–100 and dedupes
// (later wins), matching what users expect when they type `100%` twice.
const STOP_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+))%\s*(?::|=>)?\s*(.+?)\s*$/

export function parseKeyframes(input = '') {
  if (Array.isArray(input)) {
    const seen = new Map()
    input
      .map((stop) => ({
        progress: Number(stop && stop.progress),
        value: String((stop && stop.value) || '').trim(),
      }))
      .filter((stop) => Number.isFinite(stop.progress) && stop.value)
      .forEach((stop) => {
        const clamped = Math.max(0, Math.min(100, stop.progress))
        seen.set(clamped, stop.value)
      })
    return [...seen.entries()].map(([progress, value]) => ({ progress, value }))
  }
  return splitTopLevel(String(input), ',').map((part) => {
    const match = part.match(STOP_RE)
    return match ? { progress: Number(match[1]), value: match[2] } : null
  }).filter(Boolean)
}

export function emitKeyframes(stops = []) {
  return parseKeyframes(stops)
    .sort((left, right) => left.progress - right.progress)
    .map((stop) => `${stop.progress}%: ${stop.value}`)
    .join(', ')
}

// Given a multi-stop list, return ONLY the first (at lowest progress) and the
// last (at highest progress). The spec only supports linear interpolation via
// `animation-range`, so middle stops cannot be honoured natively — but we keep
// them in `--sight-scroll-keyframes` for visual editor feedback. This helper
// is what the React UI calls when deciding which values to write to the actual
// CSS property.
export function firstAndLastStops(stops = []) {
  const parsed = parseKeyframes(stops).sort((a, b) => a.progress - b.progress)
  if (!parsed.length) return []
  const first = parsed[0]
  const last = parsed[parsed.length - 1]
  return first === last ? [first] : [first, last]
}