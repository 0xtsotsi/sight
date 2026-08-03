import { all } from 'known-css-properties'

// CSS Anchor Position + Popover API properties that the upstream `known-css-properties`
// list (v0.37.0) doesn't include yet. Merged + de-duped into CSS_PROPERTIES so the
// add-property autocomplete suggests them. Upgrade `known-css-properties` and drop
// this union when these names appear in `all`.
//   anchor-size — the size() function family for reading the anchor's box
//   popover — the popover attribute (auto / manual / hint)
//   closedby — <dialog>'s closedby attribute (none / any / closerequest / auto)
const ADDITIONAL_PROPERTIES: readonly string[] = ['anchor-size', 'popover', 'closedby']

// `known-css-properties` also lists @-rule descriptors (@font-face / @counter-style /
// @property / @font-palette-values) and dead IE-isms that aren't element properties —
// drop them so the list doesn't open on junk like `accelerator` / `additive-symbols`.
const NON_PROPERTIES = new Set([
  'accelerator', 'additive-symbols', 'alt', 'ascent-override', 'base-palette', 'behavior',
  'descent-override', 'fallback', 'font-display', 'inherits', 'initial-value',
  'line-gap-override', 'negative', 'override-colors', 'pad', 'prefix', 'range',
  'size-adjust', 'speak-as', 'src', 'suffix', 'symbols', 'syntax', 'system',
  'unicode-range',
])

// Every standard CSS property (plus the still-widely-used `-webkit-` set) for the
// add-property autocomplete. Custom-property tokens (`--*`) and the other vendor
// prefixes (`-moz-`/`-ms-`/`-o-`/`-epub-`/`-internal-`/…) are dropped as noise — the
// standard property name already covers those. Sorted + de-duped once at load.
export const CSS_PROPERTIES: readonly string[] = Object.freeze(
  [...new Set([
    ...all.filter((prop) => !prop.startsWith('--') && !NON_PROPERTIES.has(prop) && (!prop.startsWith('-') || prop.startsWith('-webkit-'))),
    ...ADDITIONAL_PROPERTIES,
  ])].sort((a, b) => {
    // Standard properties first (a leading `-` otherwise sorts the 260+ `-webkit-` names
    // to the very top, burying accent-color/align-*); alphabetical within each group.
    const av = a.startsWith('-') ? 1 : 0
    const bv = b.startsWith('-') ? 1 : 0
    return av - bv || a.localeCompare(b)
  }),
)

// Filter the property list for a typed query: prefix matches first (they're what you
// usually want), then substring matches, each keeping alphabetical order. An empty
// query returns the whole list so the field opens showing everything.
export function filterCssProperties(query: string): readonly string[] {
  const q = query.trim().toLowerCase()
  if (!q) return CSS_PROPERTIES
  const prefix: string[] = []
  const substring: string[] = []
  for (const prop of CSS_PROPERTIES) {
    const at = prop.indexOf(q)
    if (at === 0) prefix.push(prop)
    else if (at > 0) substring.push(prop)
  }
  return [...prefix, ...substring]
}
