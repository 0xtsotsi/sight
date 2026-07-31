// CSS anchor positioning (Baseline 2025) gives an element a 1:1 relationship to a
// named "anchor" element so it can size/place itself relative to it. The relevant
// longhands are `anchor-name` (on the anchor), `position-anchor` (on the target),
// `inset-area` (a named region of the anchor's box), and the `anchor-size()`
// function used inside `width`/`height`/`inset-area` to read the anchor's size.
//
// `anchor-name` value: a comma-separated list of identifiers prefixed with `--`
// (the dashed-ident convention CSS uses for "user-defined names"). Empty `none` is
// the default. Inline values like `var(--button)` and `inherit` / `initial` /
// `unset` / `revert` / `revert-layer` are preserved as-is when round-tripping.
//
// `position-anchor` value: a single dashed-ident or `none` / `auto` / a global
// keyword. We surface the raw trimmed value back — the user knows what they wrote.
//
// `inset-area` value: one of the named areas from the spec (`top`, `bottom`, `left`,
// `right`, `center`, the four corners, plus the `start`/`end` logical variants and
// `block-start`, etc.), or a pair like `top left`, or `none`. We strip and re-join
// preserving the order the user typed.
//
// `anchor-size()` appears inside `width`/`height`/`inset-area`; the panel's
// position section feeds the raw value straight through, but we expose helpers
// here so the field can detect `anchor-size()` and offer a preset pick.

const ANCHOR_NAME_KEYWORDS = new Set(['none', 'inherit', 'initial', 'unset', 'revert', 'revert-layer'])
const POSITION_ANCHOR_KEYWORDS = new Set(['none', 'auto', 'inherit', 'initial', 'unset', 'revert', 'revert-layer'])
const INSET_AREA_KEYWORDS = new Set([
  'none',
  'center', 'top', 'bottom', 'left', 'right',
  'start', 'end',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'block-start', 'block-end', 'inline-start', 'inline-end',
  'block-start-start', 'block-start-end', 'block-end-start', 'block-end-end',
  'inline-start-start', 'inline-start-end', 'inline-end-start', 'inline-end-end',
  'span-start', 'span-end', 'span-block-start', 'span-block-end', 'span-inline-start', 'span-inline-end',
  'span-all', 'span-self-block-start', 'span-self-block-end', 'span-self-inline-start', 'span-self-inline-end',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer',
])
const DASHED_IDENT = /^--[A-Za-z_][\w-]*$/

/** Whether a token is a CSS dashed-ident (the `--name` form used for anchor names). */
export function isDashedIdent(token) {
  return DASHED_IDENT.test(token.trim())
}

/** Parse a comma-separated `anchor-name` value into a list of named identifiers. */
export function parseAnchorNames(value) {
  const v = (value ?? '').trim()
  if (!v) return { kind: 'keyword', value: 'none' }
  if (ANCHOR_NAME_KEYWORDS.has(v.toLowerCase())) return { kind: 'keyword', value: v.toLowerCase() }
  const names = v.split(',').map((s) => s.trim()).filter(Boolean)
  return { kind: 'names', names }
}

/** Serialize an anchor-name model back to a CSS value ('' when empty). */
export function emitAnchorNames(parsed) {
  if (!parsed) return ''
  if (parsed.kind === 'keyword') return parsed.value
  return parsed.names.join(', ')
}

/** Parse a `position-anchor` value. Single dashed-ident or keyword. */
export function parsePositionAnchor(value) {
  const v = (value ?? '').trim()
  if (!v) return { kind: 'keyword', value: 'none' }
  if (POSITION_ANCHOR_KEYWORDS.has(v.toLowerCase())) return { kind: 'keyword', value: v.toLowerCase() }
  if (isDashedIdent(v)) return { kind: 'ident', value: v }
  return { kind: 'raw', value: v }
}

/** Serialize a position-anchor model back to a CSS value. */
export function emitPositionAnchor(parsed) {
  if (!parsed) return ''
  return parsed.value
}

/** Parse an `inset-area` value. A single named area, a two-area pair, or a keyword. */
export function parseInsetArea(value) {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return { kind: 'keyword', value: 'none' }
  if (v === 'none') return { kind: 'keyword', value: 'none' }
  if (INSET_AREA_KEYWORDS.has(v)) return { kind: 'keyword', value: v }
  // Two-area pairs come in any order but the spec canonical reading is "row col".
  const parts = v.split(/\s+/).filter(Boolean)
  if (parts.length === 2 && parts.every((p) => INSET_AREA_KEYWORDS.has(p))) {
    return { kind: 'pair', row: parts[0], col: parts[1] }
  }
  return { kind: 'raw', value: v }
}

/** Serialize an inset-area model back to a CSS value. */
export function emitInsetArea(parsed) {
  if (!parsed) return ''
  if (parsed.kind === 'pair') return `${parsed.row} ${parsed.col}`
  return parsed.value
}

/** The named preset areas surfaced in the picker (the ones a user actually picks). */
export const INSET_AREA_PRESETS = [
  'none', 'center', 'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'start', 'end',
  'span-start', 'span-end', 'span-all',
]

/** The three values popover takes (Baseline 2024). */
export const POPOVER_MODES = ['auto', 'manual', 'hint']
/** The closedby values <dialog> takes (Baseline 2026; some browsers still only ship `none`). */
export const CLOSEDBY_MODES = ['none', 'any', 'closerequest', 'auto']

/** Whether the given CSS value contains an `anchor-size()` call. */
export function usesAnchorSize(value) {
  return /anchor-size\s*\(/i.test(value ?? '')
}
