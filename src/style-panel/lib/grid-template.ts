// Model for editing grid-template-columns / -rows as an ordered list of tracks, with
// per-track sizing (a "default" single size, or a minmax(min, max) pair). Reading
// expands `repeat(n, …)` and drops [line-name] tokens so the list is one entry per
// visible track; writing emits an explicit space-separated list (Webflow's native
// API drops some CSS functions, so we avoid repeat() on write).

/** Split a track list on TOP-LEVEL whitespace (parens / brackets protect commas,
 *  minmax(), repeat(), and [line names]). */
export function splitTracks(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value.trim()) {
    if (ch === '(' || ch === '[') { depth += 1; cur += ch }
    else if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); cur += ch }
    else if (/\s/.test(ch) && depth === 0) { if (cur) { parts.push(cur); cur = '' } }
    else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

/** The visible tracks a grid-template value defines — `repeat(n, a b)` expands to n×
 *  its sub-tracks; [line-name] tokens are dropped. Empty for none / unset. */
export function parseTrackList(value: string): string[] {
  const v = value.trim()
  if (!v || v.toLowerCase() === 'none') return []
  const out: string[] = []
  for (const t of splitTracks(v)) {
    if (t.startsWith('[')) continue
    const rep = t.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/is)
    if (rep) {
      const n = parseInt(rep[1], 10)
      const sub = splitTracks(rep[2]).filter((x) => !x.startsWith('['))
      for (let i = 0; i < n && sub.length; i += 1) out.push(...sub)
    } else out.push(t)
  }
  return out
}

/** Join tracks back to a grid-template value ('' → clear the property). */
export function serializeTrackList(tracks: string[]): string {
  return tracks.length ? tracks.map((t) => t.trim()).filter(Boolean).join(' ') : ''
}

export type TrackSize =
  | { mode: 'default'; value: string }
  | { mode: 'minmax'; min: string; max: string }

/** Parse a single track into its sizing (a minmax pair, or a single value). */
export function parseTrackSize(track: string): TrackSize {
  const m = track.trim().match(/^minmax\(\s*(.+?)\s*,\s*(.+?)\s*\)$/is)
  if (m) return { mode: 'minmax', min: m[1].trim(), max: m[2].trim() }
  return { mode: 'default', value: track.trim() }
}

export function serializeTrackSize(size: TrackSize): string {
  if (size.mode === 'minmax') return `minmax(${size.min.trim() || 'auto'}, ${size.max.trim() || '1fr'})`
  return size.value.trim() || 'auto'
}

export type TrackKind = 'auto' | 'fr' | 'length' | 'minmax' | 'content' | 'other'

/** Coarse classification for the row icon. */
export function trackKind(track: string): TrackKind {
  const t = track.trim().toLowerCase()
  if (/^minmax\(/.test(t) || /^fit-content\(/.test(t)) return 'minmax'
  if (t === 'auto') return 'auto'
  if (t === 'min-content' || t === 'max-content') return 'content'
  if (/^-?[\d.]+fr$/.test(t)) return 'fr'
  if (/^-?[\d.]+(px|%|rem|em|vw|vh|ch|vmin|vmax|pt|cm|mm|in)$/.test(t)) return 'length'
  return 'other'
}

/**
 * Whether a track is a `<fixed-size>` — the only track shape CSS permits inside an
 * auto-fit / auto-fill `repeat()`. Per the Grid spec that's:
 *   • a fixed `<length-percentage>` (20rem, 50%, …), OR
 *   • `minmax(<fixed-breadth>, <track-breadth>)` — a FIXED min, any max (so
 *     `minmax(20rem, 1fr)`, the canonical responsive pattern, qualifies), OR
 *   • `minmax(<inflexible-breadth>, <fixed-breadth>)` — an inflexible min (fixed /
 *     auto / min|max-content, but NOT fr) and a FIXED max.
 * Bare `fr`, `auto`, `min|max-content`, and `fit-content()` are NOT fixed-size.
 */
export function isFixedSizeTrack(track: string): boolean {
  const isFixedBreadth = (s: string) => trackKind(s) === 'length'
  const isInflexibleBreadth = (s: string) => ['length', 'auto', 'content'].includes(trackKind(s))
  const size = parseTrackSize(track)
  if (size.mode === 'default') return isFixedBreadth(size.value)
  return isFixedBreadth(size.min) || (isInflexibleBreadth(size.min) && isFixedBreadth(size.max))
}

/** Short human label for a track row (Webflow-style). */
export function trackLabel(track: string): string {
  const s = parseTrackSize(track)
  if (s.mode === 'minmax') return `Min/Max: ${s.min} / ${s.max}`
  const t = s.value.trim()
  return t.toLowerCase() === 'auto' || !t ? 'Auto' : t
}

// ── grid-template-areas ──
// A named area addressed by its 1-based, inclusive cell span (start/end column and
// start/end row) — the shape Webflow's Areas editor exposes.
export type GridArea = { name: string; colStart: number; colEnd: number; rowStart: number; rowEnd: number }

/** Parse a `grid-template-areas` value into its named areas (in first-appearance
 *  order), each as the bounding box of the cells its name occupies. `.` = empty. */
export function parseAreas(value: string): GridArea[] {
  const v = value.trim()
  if (!v || v.toLowerCase() === 'none') return []
  const rowStrings = v.match(/"[^"]*"|'[^']*'/g)
  if (!rowStrings) return []
  const grid = rowStrings.map((r) => r.slice(1, -1).trim().split(/\s+/).filter(Boolean))
  const bounds = new Map<string, { r0: number; r1: number; c0: number; c1: number }>()
  const order: string[] = []
  grid.forEach((cells, r) => cells.forEach((name, c) => {
    if (name === '.') return
    const b = bounds.get(name)
    if (!b) { bounds.set(name, { r0: r, r1: r, c0: c, c1: c }); order.push(name) }
    else { b.r0 = Math.min(b.r0, r); b.r1 = Math.max(b.r1, r); b.c0 = Math.min(b.c0, c); b.c1 = Math.max(b.c1, c) }
  }))
  return order.map((name) => {
    const b = bounds.get(name)!
    return { name, colStart: b.c0 + 1, colEnd: b.c1 + 1, rowStart: b.r0 + 1, rowEnd: b.r1 + 1 }
  })
}

/** Emit a `grid-template-areas` value from named areas — paints each area's rectangle
 *  into a grid sized to the furthest extent, `.` for uncovered cells ('' → clear). */
export function serializeAreas(areas: GridArea[]): string {
  const valid = areas.filter((a) => a.name.trim() && a.colStart >= 1 && a.rowStart >= 1)
  if (!valid.length) return ''
  const rows = Math.max(...valid.map((a) => Math.max(a.rowStart, a.rowEnd)))
  const cols = Math.max(...valid.map((a) => Math.max(a.colStart, a.colEnd)))
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '.'))
  for (const a of valid) {
    const r0 = Math.min(a.rowStart, a.rowEnd), r1 = Math.max(a.rowStart, a.rowEnd)
    const c0 = Math.min(a.colStart, a.colEnd), c1 = Math.max(a.colStart, a.colEnd)
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) grid[r - 1][c - 1] = a.name.trim()
  }
  return grid.map((row) => `"${row.join(' ')}"`).join(' ')
}

/** The list-row label: `{name} Row {rowStart} / Col {colStart}` (Webflow-style). */
export function areaLabel(a: GridArea): string {
  return `${a.name} Row ${a.rowStart} / Col ${a.colStart}`
}

/** A unique `Area` / `Area-2` / … name not already used. */
export function nextAreaName(areas: GridArea[]): string {
  const used = new Set(areas.map((a) => a.name))
  if (!used.has('Area')) return 'Area'
  let n = 2
  while (used.has(`Area-${n}`)) n += 1
  return `Area-${n}`
}
