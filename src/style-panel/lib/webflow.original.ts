// Webflow Designer integration for the Embed Editor.
//
// Responsibilities:
//   • Read the selected element's identity (tag, id, classes, attributes) and
//     build its ancestor chain (the API has no getParent(), so we DFS the
//     current context once and keep a child→parent map).
//   • Find every HtmlEmbed that injects page-global CSS: the ones on the page
//     plus the ones inside each component used on the page (read non-destructively
//     via instance.getComponent() → component.getRootElement()).
//   • Read / write an embed's code through getSettings()/setSettings({code}).
//
// We use deliberately loose local interfaces over the Designer's huge generated
// union types — the runtime methods are all optional-chained and timeout-guarded.

import { collectRules, parseRegion, renderEmbed, splitEmbed } from './css'
import { isVariableModeProp } from './variable-modes'
import { BREAKPOINTS, nativeContextKey, readOptionsFor, type NativeStyleOptions } from './native-styles'
import type { StateKey } from './resolved'
import type { BreakpointId, ElementSnapshot, NativeModel, NativeProp, NativeStyle, ParsedRule, StyleRegion } from './types'
import type { MatchTarget, TreeView } from './selectors'

// ─────────────────────────── Loose API surface ───────────────────────────

type FullElementId = { component?: unknown; element?: unknown }

type NamedValue = { name?: unknown; value?: unknown }

// A native Webflow class style. Only the members the tool uses are declared; the
// runtime object is the Designer's full Style. getProperties may return literal
// strings or Variable objects (which expose an async getName()).
type StyleHandle = {
  id?: unknown
  getName?: () => Promise<string>
  getProperties?: (options?: NativeStyleOptions) => Promise<Record<string, unknown> | null>
  getProperty?: (prop: string, options?: NativeStyleOptions) => Promise<unknown>
  setProperties?: (props: Record<string, string>, options?: NativeStyleOptions) => Promise<unknown>
  setProperty?: (prop: string, value: string, options?: NativeStyleOptions) => Promise<unknown>
  removeProperty?: (prop: string, options?: NativeStyleOptions) => Promise<unknown>
  // Variable-mode bindings are applied through their own API, NOT setProperty (the
  // `--…collection-<id>` custom property is rejected as an invalid style property).
  setVariableMode?: (collection: unknown, mode: unknown, options?: NativeStyleOptions) => Promise<unknown>
  removeVariableMode?: (collection: unknown, options?: NativeStyleOptions) => Promise<unknown>
}

type AnyEl = {
  id?: FullElementId | unknown
  type?: unknown
  plugin?: unknown
  getChildren?: () => Promise<AnyEl[] | null>
  getStyles?: () => Promise<Array<StyleHandle | null> | null>
  setStyles?: (styles: StyleHandle[]) => Promise<unknown>
  getTag?: () => Promise<unknown>
  getDomId?: () => Promise<unknown>
  getAllCustomAttributes?: () => Promise<Array<NamedValue> | null>
  getAllAttributes?: () => Promise<Array<NamedValue> | null>
  getAttributeValue?: (name: string) => Promise<unknown>
  getResolvedAttributeValue?: (name: string) => Promise<unknown>
  getSettings?: () => Promise<Record<string, unknown> | null>
  setSettings?: (settings: Record<string, unknown>) => Promise<unknown>
  getComponent?: () => Promise<CompDef | null>
  getSlots?: () => Promise<SlotEl[] | null>
}

// A slot prop on a component instance. Its children are the content PLACED into
// the slot on the page (instance-specific, selectable/stylable) — distinct from
// the component's opaque internal definition.
type SlotEl = {
  getChildren?: () => Promise<AnyEl[] | null>
}

type CompDef = {
  id?: unknown
  getName?: () => Promise<string>
  getRootElement?: () => Promise<AnyEl | null>
}

type WF = {
  getSelectedElement?: () => Promise<AnyEl | null>
  setSelectedElement?: (element: AnyEl) => Promise<unknown>
  enterComponent?: (instance: AnyEl) => Promise<unknown>
  getRootElement?: () => Promise<AnyEl | null>
  getAllElements?: () => Promise<AnyEl[]>
  getCurrentComponent?: () => Promise<CompDef | null>
  getAllComponents?: () => Promise<CompDef[]>
  getMediaQuery?: () => Promise<string>
  getStyleByName?: (nameOrPath: string | string[]) => Promise<StyleHandle | null>
  getAllStyles?: () => Promise<StyleHandle[]>
  createStyle?: (name: string, options?: { parent?: StyleHandle }) => Promise<StyleHandle | null>
  getDefaultVariableCollection?: () => Promise<VarCollectionLite | null>
  getAllVariableCollections?: () => Promise<VarCollectionFull[]>
  getVariableCollectionById?: (id: string) => Promise<VarCollectionFull | null>
  getAllAssets?: () => Promise<AssetLite[]>
  subscribe?: (event: 'selectedelement' | 'mediaquery', cb: (payload: unknown) => void) => (() => void) | undefined
}

// Minimal shapes for the Variables API — only what the font-family reader touches.
type VarGetOptions = { customValues?: boolean }
type VarLite = {
  type?: string
  getName?: () => Promise<string>
  get?: (options?: VarGetOptions) => Promise<unknown>
  getBinding?: () => Promise<string>
}
type VarCollectionLite = { getAllVariables?: () => Promise<VarLite[]> }
// A mode ("Light"/"Dark") within a collection, and a collection with named modes —
// what the mode-property resolver reads.
type VarModeLite = { id?: string; getName?: () => Promise<string> }
type VarCollectionFull = VarCollectionLite & {
  id?: string
  getName?: () => Promise<string>
  getAllVariableModes?: () => Promise<VarModeLite[]>
  getVariableModeById?: (id: string) => Promise<VarModeLite | null>
}

// Minimal Asset shape — only what the background image picker reads.
type AssetLite = { id?: string; getUrl?: () => Promise<string>; getName?: () => Promise<string>; getMimeType?: () => Promise<string> }

export function webflowApi(): WF | null {
  if (typeof webflow === 'undefined') return null
  return webflow as unknown as WF
}

const READ_TIMEOUT_MS = 4000

// Designer reads are round-trips to the Designer bridge. Firing every read at
// once (a fully parallel scan) is far faster than one-at-a-time, but an
// unbounded fan-out over a large tree could flood the bridge — so cap the number
// of in-flight reads with a small semaphore and let the rest queue.
const SCAN_CONCURRENCY = 24

function createLimiter(max: number) {
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active += 1
        resolve()
      } else {
        waiters.push(resolve)
      }
    })
  const release = () => {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }
  return async function run<T>(fn: () => Promise<T> | T): Promise<T> {
    await acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

const readLimiter = createLimiter(SCAN_CONCURRENCY)

async function readOptional<T>(fn: (() => Promise<T> | T) | undefined, timeoutMs = READ_TIMEOUT_MS): Promise<T | null> {
  if (!fn) return null
  // Acquire a slot first, then time-box the actual call — so queue time never
  // counts against the per-read timeout.
  return readLimiter(async () => {
    try {
      const value = await Promise.race<T | null>([
        Promise.resolve().then(() => fn()),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ])
      return value ?? null
    } catch {
      return null
    }
  })
}

// ─────────────────────────── Identity helpers ───────────────────────────

export function elementType(el: AnyEl | null | undefined): string {
  return typeof el?.type === 'string' ? el.type : 'Unknown'
}

export function isEmbed(el: AnyEl | null | undefined): boolean {
  // Only HtmlEmbed injects live page CSS. CodeBlock renders code visibly; it
  // does not style the page, so it is excluded from matching.
  return elementType(el) === 'HtmlEmbed'
}

export function isComponentInstance(el: AnyEl | null | undefined): boolean {
  return elementType(el) === 'ComponentInstance'
}

export function serializeElementId(id: unknown): string {
  const full = id as FullElementId | undefined
  if (full && (full.element != null || full.component != null)) {
    return `${full.component ?? ''}::${full.element ?? ''}`
  }
  try {
    return JSON.stringify(id)
  } catch {
    return String(id)
  }
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return (value as { value: string }).value
  }
  return null
}

// Webflow's read APIs can both collapse an authored calc(var(...)) to the inner
// Variable object. Retain wrapped values Moden writes so subsequent scans (and dev
// iframe reloads) can reconstruct the exact expression. Keys are scoped to the native
// style, property, breakpoint, and pseudo state.
const AUTHORED_FUNCTIONS_KEY = 'moden:native-authored-functions:v1'
let authoredFunctions: Record<string, string> | null = null
function authoredFunctionStore(): Record<string, string> {
  if (authoredFunctions) return authoredFunctions
  try {
    const parsed = JSON.parse(localStorage.getItem(AUTHORED_FUNCTIONS_KEY) ?? '{}')
    authoredFunctions = parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch { authoredFunctions = {} }
  return authoredFunctions
}
function authoredFunctionKey(style: StyleHandle, prop: string, options?: NativeStyleOptions): string {
  const id = asString(style.id) ?? ''
  if (!id) return ''
  return [id, options?.breakpoint ?? 'main', options?.pseudo ?? '', prop].join('|')
}
function authoredFunction(style: StyleHandle, prop: string, options?: NativeStyleOptions, binding?: string | null): string | null {
  const key = authoredFunctionKey(style, prop, options)
  const store = authoredFunctionStore()
  const exact = key ? store[key] ?? null : null
  if (exact || !binding) return exact
  // getStyleByName() and element.getStyles() can expose different handle ids for the
  // same class. When Webflow collapses calc(var(...)) to the inner Variable, recover a
  // uniquely matching authored expression by its stable variable binding + context.
  const suffix = `|${options?.breakpoint ?? 'main'}|${options?.pseudo ?? ''}|${prop}`
  const normalizedBinding = binding.replace(/\s+/g, '').toLowerCase()
  const matches = new Set(Object.entries(store)
    .filter(([storedKey, value]) => storedKey.endsWith(suffix)
      && value.replace(/\s+/g, '').toLowerCase().includes(normalizedBinding))
    .map(([, value]) => value))
  return matches.size === 1 ? [...matches][0] : null
}
function rememberAuthoredFunction(style: StyleHandle, prop: string, value: string | null, options?: NativeStyleOptions): void {
  const key = authoredFunctionKey(style, prop, options)
  if (!key) return
  const store = authoredFunctionStore()
  if (value && isWrappedFunctionValue(value)) store[key] = value
  else delete store[key]
  try { localStorage.setItem(AUTHORED_FUNCTIONS_KEY, JSON.stringify(store)) } catch { /* best effort */ }
}

/** Normalize a Webflow class display name into its compiled CSS form. */
export function webflowClassToCss(name: string): string {
  const compiled = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-')
  // Webflow prefixes a class that starts with a digit with an underscore
  // (`2 col` → `_2-col`), since a CSS class can't legally begin with a number.
  return /^[0-9]/.test(compiled) ? `_${compiled}` : compiled
}

function splitClassTokens(value: string | null): string[] {
  if (!value) return []
  return value.trim().split(/\s+/).filter(Boolean)
}

// Common Webflow element types → HTML tag, used as a fallback when getTag()
// isn't available so type selectors can be matched reliably (precision relies
// on knowing the tag).
const TYPE_TAG: Record<string, string> = {
  Body: 'body',
  Block: 'div',
  BlockContainer: 'div',
  Container: 'div',
  Section: 'section',
  Grid: 'div',
  Row: 'div',
  Column: 'div',
  Cell: 'div',
  VFlex: 'div',
  HFlex: 'div',
  QuickStack: 'div',
  Layout: 'div',
  RichText: 'div',
  DynamoWrapper: 'div',
  DynamoList: 'div',
  DynamoItem: 'div',
  DynamoEmpty: 'div',
  Paragraph: 'p',
  Blockquote: 'blockquote',
  Link: 'a',
  TextLink: 'a',
  LinkBlock: 'a',
  Button: 'a',
  List: 'ul',
  ListItem: 'li',
  Image: 'img',
  Video: 'div',
  Span: 'span',
  TextSpan: 'span',
  FormWrapper: 'div',
  FormForm: 'form',
  FormTextInput: 'input',
  FormTextarea: 'textarea',
  FormButton: 'input',
  FormSelect: 'select',
  FormCheckboxInput: 'input',
  FormRadioInput: 'input',
  FormInlineLabel: 'label',
  Label: 'label',
  NavbarWrapper: 'div',
  Heading: 'h2',
  HtmlEmbed: 'div',
}

// Webflow injects system classes at render time that the Designer API doesn't
// report via getStyles() or the class attribute. Add them by element type so
// selectors targeting them (e.g. `.w-dyn-item`, `.w-richtext`) match correctly.
const TYPE_IMPLICIT_CLASSES: Record<string, string[]> = {
  DynamoWrapper: ['w-dyn-list'],
  DynamoList: ['w-dyn-items'],
  DynamoItem: ['w-dyn-item'],
  DynamoEmpty: ['w-dyn-empty'],
  RichText: ['w-richtext'],
  HtmlEmbed: ['w-embed'],
}

// Elements whose real tag is variable and not exposed via getTag() (e.g. a
// DropTarget can be div / section / article / …). Their tag is carried in
// element settings under the `tag` key; when even that is absent they render as
// a plain container, so default to div rather than the (non-tag) element type.
const VARIABLE_TAG_TYPES = new Set(['DropTarget', 'DOM'])

/** Pull the `tag` value out of an element-settings map, unwrapping value shapes. */
function tagFromSettings(settings: Record<string, unknown> | null | undefined): string | null {
  if (!settings) return null
  const raw = (settings as Record<string, unknown>).tag
  const direct = asString(raw)
  if (direct) return direct
  // Some settings values are wrapped, e.g. { value: 'section' } or a static prop.
  if (raw && typeof raw === 'object') return asString((raw as { value?: unknown }).value)
  return null
}

async function resolveTag(el: AnyEl): Promise<string | null> {
  // 1. getTag() — authoritative for elements that support it (Block, Section,
  //    Heading, List, Link, DOM, …).
  const direct = asString(await readOptional(() => el.getTag?.()))
  if (direct) return direct.toLowerCase()

  // 2. Fixed structural types map straight to their tag (and bring their own
  //    implicit classes) — no settings read needed.
  const type = elementType(el)
  const known = TYPE_TAG[type]
  if (known) return known

  // 3. Variable-tag elements (DropTarget/DOM) keep the real tag in settings.
  const fromSettings = tagFromSettings(await readOptional(() => el.getSettings?.()))
  if (fromSettings) return fromSettings.toLowerCase()

  // 4. A variable-tag element with no explicit tag renders as a plain div;
  //    genuinely unknown types stay null rather than asserting a wrong tag.
  return VARIABLE_TAG_TYPES.has(type) ? 'div' : null
}

/** Read an element's identity for selector matching. */
export async function buildSnapshot(el: AnyEl): Promise<ElementSnapshot> {
  const [tag, domId, styles, classAttr, resolvedClassAttr, customAttrs, allAttrs] = await Promise.all([
    resolveTag(el),
    readOptional(() => el.getDomId?.()),
    readOptional(() => el.getStyles?.()),
    readOptional(() => el.getAttributeValue?.('class')),
    readOptional(() => el.getResolvedAttributeValue?.('class')),
    readOptional(() => el.getAllCustomAttributes?.()),
    readOptional(() => el.getAllAttributes?.()),
  ])

  const classes = new Set<string>()
  // Ordered, compiled class list (primary first) for building scaffold selectors.
  const classList: string[] = []
  const pushClass = (raw: string) => {
    const compiled = webflowClassToCss(raw)
    if (compiled && !classList.includes(compiled)) classList.push(compiled)
  }

  // Webflow's render-time system classes for CMS/rich-text elements aren't
  // reported by the API — inject them by type so `.w-dyn-item` etc. match.
  ;(TYPE_IMPLICIT_CLASSES[elementType(el)] ?? []).forEach((c) => classes.add(c))

  // Native Webflow style classes first (the Styles-panel classes), in applied
  // order — so they lead the token list ahead of anything the `class` attribute
  // adds. Keep both raw and normalized to bridge naming, and record the compiled
  // order for scaffold selectors.
  if (Array.isArray(styles)) {
    const names = await Promise.all(
      styles.map((style) => (style ? readOptional(() => style.getName?.()) : null)),
    )
    names.forEach((name) => {
      if (typeof name === 'string' && name.trim()) {
        classes.add(name.trim())
        classes.add(webflowClassToCss(name))
        pushClass(name)
      }
    })
  }

  // Then classes contributed by the `class` attribute (set in element settings /
  // custom code) — added after the native classes so those show first. Insertion
  // order is preserved by the Set, and already-seen native classes don't reorder.
  splitClassTokens(asString(classAttr)).forEach((c) => classes.add(c))
  splitClassTokens(asString(resolvedClassAttr)).forEach((c) => classes.add(c))

  // Fall back to the class attribute order when the element exposes no styles.
  if (!classList.length) {
    splitClassTokens(asString(resolvedClassAttr) ?? asString(classAttr)).forEach(pushClass)
  }

  // Merge custom attributes (most element types) and plain attributes (DOM
  // elements) so [data-*] / [attr] selectors can be matched either way.
  const attributes: Record<string, string> = {}
  const addAttrs = (list: Array<NamedValue> | null | undefined) => {
    if (!Array.isArray(list)) return
    list.forEach((attr) => {
      if (typeof attr?.name === 'string') {
        attributes[attr.name.toLowerCase()] = asString(attr.value) ?? ''
      }
    })
  }
  addAttrs(customAttrs)
  addAttrs(allAttrs)
  const id = asString(domId)
  if (id) attributes.id = id
  if (classes.size) attributes.class = [...classes].join(' ')

  return {
    tag,
    webflowType: elementType(el),
    id,
    classes: [...classes],
    classList,
    attributes,
  }
}

// ─────────────────────────── Context scan ───────────────────────────

export type EmbedSource = {
  key: string
  label: string
  classNames: string[]
  fromComponent: boolean
  componentName: string | null
  /** Order index approximating the embed's document position for the cascade. */
  order: number
  element: AnyEl
  /** The page instance to enter when opening a component embed in the Designer. */
  instance?: AnyEl
}

/**
 * The expensive, selection-independent scan: the page/component element tree
 * (for ancestor chains) plus every embed. Cache this and re-match cheaply as the
 * selection changes; only rebuild it when embeds might have changed.
 */
export type EmbedScan = {
  parentByKey: Map<string, string>
  childrenByKey: Map<string, string[]>
  elementByKey: Map<string, AnyEl>
  embeds: EmbedSource[]
  inComponentContext: boolean
}

type DfsResult = {
  parentByKey: Map<string, string>
  childrenByKey: Map<string, string[]>
  elementByKey: Map<string, AnyEl>
  embeds: AnyEl[]
  instances: AnyEl[]
}

const MAX_DFS_NODES = 5000

async function dfsContext(root: AnyEl): Promise<DfsResult> {
  const parentByKey = new Map<string, string>()
  const childrenByKey = new Map<string, string[]>()
  const elementByKey = new Map<string, AnyEl>()
  let visited = 0

  // Read a node's children in parallel with its siblings (bounded by the read
  // limiter) but return embeds/instances in document order so the cascade stays
  // deterministic: each subtree resolves to an ordered list, then they concat in
  // child order.
  const walk = async (el: AnyEl, parentKey: string | null): Promise<{ embeds: AnyEl[]; instances: AnyEl[] }> => {
    if (visited >= MAX_DFS_NODES) return { embeds: [], instances: [] }
    visited += 1
    const key = serializeElementId(el.id)
    elementByKey.set(key, el)
    if (parentKey) parentByKey.set(key, parentKey)

    if (isEmbed(el)) return { embeds: [el], instances: [] }

    // A component instance's own internals are opaque on the page (read separately,
    // shared by every instance). But content placed into its SLOTS lives on THIS
    // page — it's selectable and stylable — so descend into slot children only. That
    // links a slot child's ancestor chain to the instance (resolved to its component
    // root when matched), so `.u-section .u-heading` matches a heading slotted into a
    // `.u-section` component. Non-slot descendants stay hidden behind the boundary.
    const embeds: AnyEl[] = []
    const instances: AnyEl[] = []
    if (isComponentInstance(el)) {
      instances.push(el)
      const slots = await readOptional(() => el.getSlots?.())
      if (!Array.isArray(slots)) return { embeds, instances }
      const slotChildren: AnyEl[] = []
      for (const slot of slots) {
        const kids = await readOptional(() => slot?.getChildren?.())
        if (Array.isArray(kids)) slotChildren.push(...kids.filter((c): c is AnyEl => Boolean(c)))
      }
      if (!slotChildren.length) return { embeds, instances }
      childrenByKey.set(key, slotChildren.map((child) => serializeElementId(child.id)))
      const slotResults = await Promise.all(slotChildren.map((child) => walk(child, key)))
      for (const result of slotResults) {
        embeds.push(...result.embeds)
        instances.push(...result.instances)
      }
      return { embeds, instances }
    }

    const children = await readOptional(() => el.getChildren?.())
    if (!Array.isArray(children)) return { embeds, instances }

    // Record ordered child keys so siblings / :has() can be evaluated later.
    childrenByKey.set(key, children.filter(Boolean).map((child) => serializeElementId((child as AnyEl).id)))

    const results = await Promise.all(children.map((child) => (child ? walk(child, key) : null)))
    for (const result of results) {
      if (!result) continue
      embeds.push(...result.embeds)
      instances.push(...result.instances)
    }
    return { embeds, instances }
  }

  const { embeds, instances } = await walk(root, null)
  return { parentByKey, childrenByKey, elementByKey, embeds, instances }
}

/**
 * Generic embed label — "Embed", suffixed with a 1-based number when its scope
 * (component or page) holds several. The component name is carried separately
 * (source.componentName) and shown as the dropdown's group subheader, so the
 * label itself never repeats it.
 */
function embedLabel(index: number, total: number): string {
  return `Embed${total > 1 ? ` #${index + 1}` : ''}`
}

function embedClassSuffix(classNames: string[]): string {
  return classNames.length ? ` · ${classNames.map((name) => `.${name}`).join(' ')}` : ''
}

export function embedSourceClassSuffix(source: EmbedSource): string {
  return embedClassSuffix(source.classNames)
}

async function embedClassNames(embed: AnyEl): Promise<string[]> {
  const [styles, classAttr, resolvedClassAttr] = await Promise.all([
    readOptional(() => embed.getStyles?.()),
    readOptional(() => embed.getAttributeValue?.('class')),
    readOptional(() => embed.getResolvedAttributeValue?.('class')),
  ])
  const names: string[] = []
  const add = (raw: string) => {
    const compiled = webflowClassToCss(raw)
    if (compiled && compiled !== 'w-embed' && !names.includes(compiled)) names.push(compiled)
  }

  if (Array.isArray(styles)) {
    const styleNames = await Promise.all(
      styles.map((style) => style ? readOptional(() => style.getName?.()) : null),
    )
    styleNames.forEach((name) => {
      if (typeof name === 'string' && name.trim()) add(name)
    })
  }
  splitClassTokens(asString(classAttr)).forEach(add)
  splitClassTokens(asString(resolvedClassAttr)).forEach(add)
  return names
}

/**
 * Every embed inside every site component, read via getAllComponents() — so a
 * component's rules are available regardless of whether it's placed on the current
 * page (component embed code is global, shared by every instance). Ordered after
 * page embeds; within the set, in Components-panel order for a stable cascade.
 * Nested components aren't walked into: getAllComponents already lists every
 * definition, each read from its own root, so their embeds arrive as their own entry.
 */
export async function scanAllComponents(
  onEmbeds?: (embeds: EmbedSource[]) => void | Promise<void>,
): Promise<EmbedSource[]> {
  const api = webflowApi()
  const components = (await readOptional(() => api?.getAllComponents?.())) ?? []
  const out: EmbedSource[] = []
  // Scan components in parallel (bounded by the read limiter) and emit each one's
  // embeds via onEmbeds as it resolves, so its rules can load and render without
  // waiting for every component to finish. Order is derived from the component's
  // panel index — NOT arrival order — so the cascade stays deterministic. (≤1000
  // embeds per component assumed for the order block; far beyond any real component.)
  await Promise.all(
    components.map(async (comp, compIndex) => {
      const name = (await readOptional(() => comp.getName?.())) ?? 'Component'
      const root = await readOptional(() => comp.getRootElement?.())
      if (!root) return
      const dfs = await dfsContext(root)
      if (!dfs.embeds.length) return
      const base = 1_000_000 + compIndex * 1_000 // after page embeds, per-component block
      const embeds: EmbedSource[] = await Promise.all(dfs.embeds.map(async (embed, index) => {
        const classNames = await embedClassNames(embed)
        return {
          key: serializeElementId(embed.id),
          label: `${embedLabel(index, dfs.embeds.length)}${embedClassSuffix(classNames)}`,
          classNames,
          fromComponent: true,
          componentName: name,
          order: base + index,
          element: embed,
        }
      }))
      out.push(...embeds)
      if (onEmbeds) await onEmbeds(embeds)
    }),
  )
  return out
}

/** The page tree + its own (page-level) embeds. The fast first half of a scan. */
export type PageScan = {
  parentByKey: Map<string, string>
  childrenByKey: Map<string, string[]>
  elementByKey: Map<string, AnyEl>
  pageEmbeds: EmbedSource[]
  instances: AnyEl[]
  inComponentContext: boolean
}

/**
 * Scan the current context's element tree and its directly-placed embeds. This
 * is the part needed to resolve ancestor chains and show page-level rules, so it
 * can be rendered before the (potentially slower) component embeds load.
 */
export async function scanPage(): Promise<PageScan> {
  const api = webflowApi()
  const currentComponent = await readOptional(() => api?.getCurrentComponent?.())
  const inComponentContext = currentComponent != null

  // Inside a component, scan that component's own root so its embeds are found —
  // webflow.getRootElement() can return the page root (or null) in this mode,
  // which misses the component's internals. Fall back to the page root.
  const root =
    (currentComponent ? await readOptional(() => currentComponent.getRootElement?.()) : null) ??
    (await readOptional(() => api?.getRootElement?.()))
  const dfs: DfsResult = root
    ? await dfsContext(root)
    : { parentByKey: new Map(), childrenByKey: new Map(), elementByKey: new Map(), embeds: [], instances: [] }

  // Embeds are labeled generically ("Embed", numbered when several share a scope);
  // when we're inside a component, they record its name for the dropdown grouping.
  const currentComponentName = currentComponent
    ? (await readOptional(() => currentComponent.getName?.())) ?? 'Component'
    : null
  const total = dfs.embeds.length
  const pageEmbeds: EmbedSource[] = await Promise.all(dfs.embeds.map(async (embed, index) => {
    const classNames = await embedClassNames(embed)
    return {
      key: serializeElementId(embed.id),
      label: `${embedLabel(index, total)}${embedClassSuffix(classNames)}`,
      classNames,
      fromComponent: currentComponentName != null,
      componentName: currentComponentName,
      order: index,
      element: embed,
    }
  }))

  return {
    parentByKey: dfs.parentByKey,
    childrenByKey: dfs.childrenByKey,
    elementByKey: dfs.elementByKey,
    pageEmbeds,
    instances: dfs.instances,
    inComponentContext,
  }
}

/** Dedup embed sources by element key, keeping first occurrence + order. */
export function dedupeByKey(sources: EmbedSource[]): EmbedSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    if (seen.has(source.key)) return false
    seen.add(source.key)
    return true
  })
}

/** True when a selected element belongs to this scan's context (cheap check). */
export function scanHasElement(scan: EmbedScan, selected: AnyEl): boolean {
  return scan.elementByKey.has(serializeElementId(selected.id))
}

/** A component instance's matchable identity is its component's root element. */
export async function resolveIdentityElement(selected: AnyEl): Promise<AnyEl> {
  if (!isComponentInstance(selected)) return selected
  const comp = await readOptional(() => selected.getComponent?.())
  const root = comp ? await readOptional(() => comp.getRootElement?.()) : null
  return root ?? selected
}

/**
 * A read-only TreeView over a scan: navigate parents/children synchronously and
 * read element snapshots (identity) lazily, cached per view. `seed` pre-loads a
 * key's snapshot — used to give a selected component instance its component
 * root's identity.
 */
function createTreeView(scan: EmbedScan, seed?: { key: string; snapshot: ElementSnapshot }): TreeView {
  const cache = new Map<string, ElementSnapshot | null>()
  if (seed) cache.set(seed.key, seed.snapshot)
  return {
    truncated: scan.inComponentContext,
    parentKey: (key) => scan.parentByKey.get(key) ?? null,
    childKeys: (key) => scan.childrenByKey.get(key) ?? [],
    snapshot: async (key) => {
      if (cache.has(key)) return cache.get(key) ?? null
      const el = scan.elementByKey.get(key)
      // Read a component-instance ancestor via its component root, not the opaque
      // instance wrapper (which reports no classes) — so an ancestor compound like
      // `.u-section` matches when `.u-section` is itself a component. Mirrors the
      // seed's identity resolution for the selected element (see resolveTarget).
      const snap = el ? await buildSnapshot(await resolveIdentityElement(el)) : null
      cache.set(key, snap)
      return snap
    },
  }
}

/**
 * The cheap, per-selection step: build a match target (root key + tree view) for
 * the selected element, plus its identity snapshot for the header. Reads only
 * the element + whatever the matched selectors actually navigate to.
 */
export async function resolveTarget(
  selected: AnyEl,
  scan: EmbedScan,
): Promise<{ target: MatchTarget; rootSnapshot: ElementSnapshot }> {
  // When a component instance is selected, the embed CSS targets the component's
  // ROOT element, not the instance wrapper — resolve its identity by reading the
  // component root without opening the component, and seed it at the root key.
  const identityElement = await resolveIdentityElement(selected)
  const rootSnapshot = await buildSnapshot(identityElement)
  const rootKey = serializeElementId(selected.id)
  const view = createTreeView(scan, { key: rootKey, snapshot: rootSnapshot })
  return { target: { rootKey, view }, rootSnapshot }
}

// ─────────────────────────── Rule collection ───────────────────────────

export type EmbedDoc = {
  source: EmbedSource
  code: string
  /** Immutable HTML chunks around the style regions (regions.length + 1). */
  segments: string[]
  regions: StyleRegion[]
}

export type CollectedRules = {
  rules: ParsedRule[]
  docs: EmbedDoc[]
  errors: Array<{ label: string; message: string }>
}

function codeFromSettings(settings: Record<string, unknown> | null | undefined): string | null {
  if (!settings) return null
  return asString(settings.code)
}

/**
 * Read each embed's code and parse its `<style>` blocks into live regions.
 * Reads run concurrently (bounded by the read limiter); `onDoc` fires the moment
 * each embed is parsed so callers can stream results in rather than waiting for
 * the whole batch, while the returned arrays stay in stable source order.
 */
export async function loadEmbedDocs(
  sources: EmbedSource[],
  onDoc?: (doc: EmbedDoc) => void,
): Promise<{ docs: EmbedDoc[]; errors: Array<{ label: string; message: string }> }> {
  const loaded = await Promise.all(
    sources.map(async (source): Promise<{ doc: EmbedDoc | null; errors: Array<{ label: string; message: string }> }> => {
      const settings = await readOptional(() => source.element.getSettings?.())
      const code = codeFromSettings(settings)
      if (code == null) {
        return { doc: null, errors: [{ label: source.label, message: 'Could not read embed code.' }] }
      }
      const { segments, regions } = splitEmbed(code)
      const errors: Array<{ label: string; message: string }> = []
      regions.forEach((region) => {
        parseRegion(region)
        if (region.parseError) errors.push({ label: source.label, message: region.parseError })
      })
      const doc: EmbedDoc = { source, code, segments, regions }
      onDoc?.(doc)
      return { doc, errors }
    }),
  )

  const docs: EmbedDoc[] = []
  const errors: Array<{ label: string; message: string }> = []
  for (const entry of loaded) {
    if (entry.doc) docs.push(entry.doc)
    errors.push(...entry.errors)
  }

  return { docs, errors }
}

/**
 * Walk the (already-parsed) docs into ParsedRule[] in cascade order. Cheap and
 * pure — call it again after any in-memory AST edit to refresh the rule list
 * without re-reading from the Designer.
 */
export function rebuildRules(docs: EmbedDoc[]): ParsedRule[] {
  const rules: ParsedRule[] = []
  const order = { n: 0 }
  const ordered = [...docs].sort((a, b) => a.source.order - b.source.order)

  for (const doc of ordered) {
    doc.regions.forEach((region, regionIndex) => {
      if (!region.root) return
      rules.push(...collectRules(region, {
        embedKey: doc.source.key,
        embedLabel: doc.source.label,
        fromComponent: doc.source.fromComponent,
        componentName: doc.source.componentName,
        regionIndex,
        idSeed: doc.source.key,
        order,
      }))
    })
  }
  return rules
}

/** Read each embed's code, parse its `<style>` blocks, and collect all rules. */
export async function collectRulesFromEmbeds(sources: EmbedSource[]): Promise<CollectedRules> {
  const { docs, errors } = await loadEmbedDocs(sources)
  return { rules: rebuildRules(docs), docs, errors }
}

/** Persist an embed doc's regions back into its element via setSettings. */
export async function writeEmbedDoc(doc: EmbedDoc): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  // Rebuild from immutable segments + live region roots — correct for any
  // number of <style> blocks and stable across repeated edits.
  const code = renderEmbed(doc.segments, doc.regions)
  try {
    const setter = doc.source.element.setSettings
    if (!setter) return { ok: false, error: 'This embed does not support editing (no setSettings).' }
    await setter.call(doc.source.element, { code })
    doc.code = code
    return { ok: true, code }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Select an embed in the Designer so the user can see it in context. For a
 * component embed, enter the owning instance's component first. (The Designer
 * exposes no API to open the native code editor, so we pair this with the
 * in-panel full-embed editor.)
 */
export async function openEmbedSource(source: EmbedSource): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = webflowApi()
  if (!api?.setSelectedElement) return { ok: false, error: 'Selection API unavailable.' }
  try {
    if (source.fromComponent && source.instance && api.enterComponent) {
      await api.enterComponent(source.instance)
    }
    await api.setSelectedElement(source.element)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Navigate to an embed on the canvas. A page embed is selected directly; a
 * component embed (read globally, so it carries no page instance) is reached by
 * finding an instance of its component on the current page, entering it, then
 * selecting the embed inside. Returns a helpful error when the component isn't
 * placed on any page (there's nothing to enter).
 */
export async function navigateToEmbed(
  source: EmbedSource,
  pageInstances: readonly unknown[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = webflowApi()
  if (!api?.setSelectedElement) return { ok: false, error: 'Selection API unavailable.' }
  try {
    if (source.fromComponent) {
      let instance = source.instance ?? null
      if (!instance && source.componentName) {
        for (const inst of pageInstances as AnyEl[]) {
          const comp = await readOptional(() => inst.getComponent?.())
          const name = comp ? await readOptional(() => comp.getName?.()) : null
          if (name === source.componentName) { instance = inst; break }
        }
      }
      if (!instance) {
        return { ok: false, error: `Place an instance of "${source.componentName ?? 'the component'}" on this page to open its embed.` }
      }
      if (api.enterComponent) await api.enterComponent(instance)
    }
    await api.setSelectedElement(source.element)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read an embed's full code (the whole HTML/CSS, not just matched rules). */
export async function readEmbedCode(source: EmbedSource): Promise<string | null> {
  const settings = await readOptional(() => source.element.getSettings?.())
  return codeFromSettings(settings)
}

/** Overwrite an embed's full code via setSettings. */
export async function writeEmbedCode(source: EmbedSource, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const setter = source.element.setSettings
  if (!setter) return { ok: false, error: 'This embed does not support editing (no setSettings).' }
  try {
    await setter.call(source.element, { code })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ─────────────────────────── Native Webflow styles ───────────────────────────

/** The Designer's current breakpoint (drives the default context on load). */
export async function getCurrentBreakpoint(): Promise<BreakpointId> {
  const api = webflowApi()
  const bp = asString(await readOptional(() => api?.getMediaQuery?.()))
  return (bp as BreakpointId | null) ?? 'main'
}

// Resolve a raw PropertyMap into displayable values — literals pass through;
// Properties whose value Webflow returns as an image Asset OBJECT rather than a
// string. We resolve these to `url(<cdn>)` so the value is valid CSS the tool can
// preview — the bare asset name / @img_<id> reference is not.
const IMAGE_PROPS = new Set(['background-image', 'mask-image', '-webkit-mask-image', 'border-image-source', 'list-style-image'])

// In a multi-layer value (a comma list, or the `background` shorthand) Webflow
// hands the image back as an ASSET REFERENCE token, e.g. `@img_6a3ed91bc…`, not a
// url(). Swap each ref for `url(<cdn>)` by looking the asset up by id, so stacks
// like "gradient + image" preview instead of showing the raw id. Ids come back in
// a couple of shapes (`img_<hash>` or the bare `<hash>`), so we key on both.
async function resolveAssetRefs(value: string): Promise<string> {
  // The ref token is `@img_<name>` where <name> is an asset hash OR an image-variable
  // name-slug (which can contain `_`/`-`) — so match past the first underscore.
  if (!/@img[_-][a-z0-9_-]+/i.test(value)) return value
  const [assets, imageVars] = await Promise.all([getImageAssets(), getImageVariables()])
  if (!assets.length && !imageVars.length) return value
  const byRef = new Map<string, string>()
  for (const a of assets) {
    const bare = a.id.replace(/^img_/i, '').toLowerCase()
    byRef.set(a.id.toLowerCase(), a.url)
    byRef.set(bare, a.url)
    byRef.set(`img_${bare}`, a.url)
  }
  // Image variables key on their name-slug (plus a separator-stripped variant, so a
  // token written with `-` still matches a `_` slug and vice versa).
  const bySlug = new Map<string, string>()
  for (const v of imageVars) {
    bySlug.set(v.slug, v.url)
    bySlug.set(v.slug.replace(/[_-]/g, ''), v.url)
  }
  return value.replace(/@(img[_-][a-z0-9_-]+)/gi, (full, ref: string) => {
    const key = ref.toLowerCase()
    const bare = key.replace(/^img[_-]/i, '')
    // Match an image variable by slug first, then an asset by id (either shape), then
    // the CDN url (which typically embeds the asset hash) so a raw hash ref resolves.
    const url =
      bySlug.get(bare) ?? bySlug.get(bare.replace(/[_-]/g, '')) ??
      byRef.get(key) ?? byRef.get(bare) ??
      assets.find((a) => a.url.toLowerCase().includes(bare))?.url
    return url ? `url("${url}")` : full
  })
}

// Variable objects (which expose an async getName()) become their name, tagged.
async function resolveNativeProps(
  raw: Record<string, unknown>,
  readProperty?: (prop: string) => Promise<unknown>,
  recalledProperty?: (prop: string, binding?: string | null) => string | null,
): Promise<Map<string, NativeProp>> {
  const out = new Map<string, NativeProp>()
  await Promise.all(
    Object.entries(raw).map(async ([prop, value]) => {
      if (typeof value === 'string') {
        if (value !== '') out.set(prop, { value: await resolveAssetRefs(value), isVariable: false })
        return
      }
      if (value == null) return
      const getName = (value as { getName?: () => Promise<string> } | null)?.getName
      if (typeof getName === 'function') {
        // Bulk getProperties() can collapse `calc(var(--x) * 2)` to the inner Variable
        // object. The single-property API retains the authored function, so prefer it
        // when available; otherwise this model would display/name it as a bare variable.
        const precise = readProperty ? asString(await readProperty(prop)) : null
        if (precise && isWrappedFunctionValue(precise)) {
          out.set(prop, { value: precise, isVariable: false })
          return
        }
        const getBinding = (value as { getBinding?: () => Promise<string> }).getBinding
        const binding = typeof getBinding === 'function'
          ? asString(await readOptional(() => getBinding.call(value)))
          : null
        const recalled = recalledProperty?.(prop, binding)
        if (recalled && isWrappedFunctionValue(recalled)) {
          out.set(prop, { value: recalled, isVariable: false })
          return
        }
        // An image property's value is an Asset — prefer its CDN url so we store a
        // usable `url(...)` instead of the asset name / @img_<id> ref (invalid CSS,
        // shows as "No image"). Re-resolving getUrl() each read keeps the link right.
        if (IMAGE_PROPS.has(prop)) {
          const getUrl = (value as { getUrl?: () => Promise<string> } | null)?.getUrl
          if (typeof getUrl === 'function') {
            const url = asString(await readOptional(() => getUrl.call(value)))
            if (url) { out.set(prop, { value: `url("${url}")`, isVariable: false }); return }
          }
        }
        const name = asString(await readOptional(() => getName.call(value))) ?? ''
        if (name) out.set(prop, { value: name, isVariable: true })
        return
      }
      // Some values arrive as wrapper objects (e.g. { value: 'Arial' }) rather than a
      // bare string or a Variable — pull a string out so props like font-family aren't
      // silently dropped from the native model.
      const str = asString(value)
      if (str) out.set(prop, { value: str, isVariable: false })
    }),
  )
  return out
}

/** Read one style's properties bucketed by (breakpoint, state) across every breakpoint. */
type PropsByContext = Map<string, Map<string, NativeProp>>

/** Whether two (breakpoint,state)→prop→value maps hold exactly the same values. */
function samePropsByContext(a: PropsByContext, b: PropsByContext): boolean {
  if (a.size !== b.size) return false
  for (const [ctx, am] of a) {
    const bm = b.get(ctx)
    if (!bm || bm.size !== am.size) return false
    for (const [prop, av] of am) {
      const bv = bm.get(prop)
      if (!bv || bv.value !== av.value) return false
    }
  }
  return true
}

async function readStyleContexts(
  style: StyleHandle,
  states: readonly StateKey[],
): Promise<Map<string, Map<string, NativeProp>>> {
  const propsByContext = new Map<string, Map<string, NativeProp>>()
  await Promise.all(
    BREAKPOINTS.flatMap((bp) =>
      states.map(async (state) => {
        const options = readOptionsFor(bp.id, state)
        // getProperties({}) reads the DESIGNER'S CURRENT breakpoint, not base — pass
        // no argument for base (main + no pseudo) so it reads the base bucket.
        const raw = await readOptional(() =>
          options && Object.keys(options).length ? style.getProperties?.(options) : style.getProperties?.())
        if (!raw || typeof raw !== 'object') return
        const resolved = await resolveNativeProps(
          raw as Record<string, unknown>,
          async (prop) => readOptional(() =>
            options && Object.keys(options).length
              ? style.getProperty?.(prop, options)
              : style.getProperty?.(prop)),
          (prop, binding) => authoredFunction(style, prop, options, binding),
        )
        if (resolved.size) propsByContext.set(nativeContextKey(bp.id, state), resolved)
      }),
    ),
  )
  return propsByContext
}

// The project's FontFamily variables — the only font list the Designer API exposes
// (there's no getAllFonts). We read each variable's resolved value (the actual font
// family string). Cached once per session; the Typography picker merges these with
// common web families and a Custom option. Empty when the project defines no font
// variables — the picker still offers the generics + Custom.
// The primary family of a font-family value (first list entry, unquoted).
function primaryFamilyName(value: string): string {
  const first = value.split(',')[0] ?? value
  return first.trim().replace(/^['"]|['"]$/g, '').trim()
}

// Values that appear as a style's font-family but are NOT a real font name — CSS-wide
// keywords, generic families, and functional/variable values. Excluded so the Custom
// fonts group lists only actual fonts (never "inherit"/"unset"/"sans-serif").
const NON_FONT_VALUES = new Set([
  '', 'inherit', 'unset', 'initial', 'revert', 'revert-layer', 'none', 'auto',
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
])
function isRealFontName(name: string): boolean {
  const n = name.trim().toLowerCase()
  if (NON_FONT_VALUES.has(n)) return false
  if (n.includes('(') || n.includes('var')) return false // var()/calc()/etc.
  return true
}

// The project's image assets — for the background image picker. There's no asset
// picker dialog exposed, so we list them ourselves: getAllAssets() filtered to image
// mime types, each resolved to its CDN url + name. Cached once (assets rarely change
// mid-session); loaded lazily when the picker first opens.
export type ImageAsset = { id: string; name: string; url: string }
let imageAssetsCache: ImageAsset[] | null = null
export function invalidateImageAssets(): void { imageAssetsCache = null }
export async function getImageAssets(): Promise<ImageAsset[]> {
  if (imageAssetsCache) return imageAssetsCache
  const api = webflowApi()
  const assets = api?.getAllAssets ? ((await readOptional(() => api.getAllAssets!())) ?? []) : []
  const built = await Promise.all(
    assets.map(async (a): Promise<ImageAsset | null> => {
      const mime = (await readOptional(() => a?.getMimeType?.())) ?? ''
      if (!/^image\//i.test(mime)) return null
      const url = asString(await readOptional(() => a?.getUrl?.()))
      if (!url) return null
      const name = asString(await readOptional(() => a?.getName?.())) ?? url.split('/').pop() ?? 'Image'
      return { id: String(a?.id ?? url), name, url }
    }),
  )
  imageAssetsCache = built
    .filter((x): x is ImageAsset => x != null)
    .sort((a, b) => a.name.localeCompare(b.name))
  return imageAssetsCache
}

// The project's IMAGE variables (Webflow's asset variables). A background-image that
// references one comes back as an `@img_<name-slug>` token (e.g. a variable "example
// bg" → `@img_example_bg`), which we resolve to the bound asset's CDN url so the layer
// previews and reads its file name. Cached per session; we probe each variable's value
// for an Asset (has getUrl) rather than depend on the exact variable `type` string.
export type ImageVariable = { slug: string; name: string; url: string }
let imageVariablesCache: ImageVariable[] | null = null
export function invalidateImageVariables(): void { imageVariablesCache = null }

// A variable name → its `@img_<slug>` token form: lowercase, non-alphanumerics → `_`.
function variableSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

async function getImageVariables(): Promise<ImageVariable[]> {
  if (imageVariablesCache) return imageVariablesCache
  const api = webflowApi()
  const collection = await readOptional(() => api?.getDefaultVariableCollection?.())
  const vars = collection ? ((await readOptional(() => collection.getAllVariables?.())) ?? []) : []
  const built = await Promise.all(
    vars.map(async (v): Promise<ImageVariable | null> => {
      const name = asString(await readOptional(() => v?.getName?.()))
      if (!name) return null
      const val = await readOptional(() => v?.get?.())
      const getUrl = (val as { getUrl?: () => Promise<string> } | null)?.getUrl
      if (typeof getUrl !== 'function') return null // not an image variable
      const url = asString(await readOptional(() => getUrl.call(val)))
      if (!url) return null
      return { slug: variableSlug(name), name, url }
    }),
  )
  imageVariablesCache = built.filter((x): x is ImageVariable => x != null)
  return imageVariablesCache
}

let projectFontsCache: string[] | null = null
export function invalidateProjectFonts(): void { projectFontsCache = null }
export async function getProjectFontFamilies(): Promise<string[]> {
  if (projectFontsCache) return projectFontsCache
  const api = webflowApi()
  const names = new Set<string>()
  // 1. FontFamily variables — their resolved font value (else the variable name).
  const collection = await readOptional(() => api?.getDefaultVariableCollection?.())
  const vars = collection ? ((await readOptional(() => collection.getAllVariables?.())) ?? []) : []
  const add = (raw: string | null | undefined) => {
    if (!raw) return
    const fam = primaryFamilyName(raw)
    if (isRealFontName(fam)) names.add(fam)
  }
  // Resolve a value that may be a literal string or a Variable object into the actual
  // font family — via the variable's VALUE (`get()`), never its NAME (that's the CSS
  // variable, not the font).
  const resolveFont = async (raw: unknown): Promise<string | null> => {
    const str = asString(raw)
    if (str) return str
    const getVal = (raw as { get?: () => Promise<unknown> } | null)?.get
    if (typeof getVal === 'function') return asString(await readOptional(() => getVal.call(raw)))
    return null
  }
  await Promise.all(
    vars.map(async (v) => {
      if (v?.type !== 'FontFamily') return
      add(await resolveFont(v))
    }),
  )
  // 2. font-family values actually assigned on any site style. There's no getAllFonts,
  //    so this is how uploaded CUSTOM fonts (e.g. "Geist") surface — a font shows up if
  //    it's used anywhere in the project. A variable-bound value comes back as a Variable
  //    object; resolve it to the underlying font (its value), not the variable name.
  const styles = api?.getAllStyles ? ((await readOptional(() => api.getAllStyles!())) ?? []) : []
  await Promise.all(
    styles.map(async (st) => {
      add(await resolveFont(await readOptional(() => st?.getProperty?.('font-family'))))
    }),
  )
  projectFontsCache = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b))
  return projectFontsCache
}

// Every variable collection + mode in the project, id → name — so the panel can
// resolve Webflow's opaque `…collection-<id>: mode-<id>` custom properties into a
// readable "Collection = Mode". Cached once per session; empty on any failure.
export type VariableModeIndex = {
  collections: Array<{ id: string; name: string }>
  modes: Array<{ id: string; name: string; collectionId: string }>
}
let variableModeIndexCache: VariableModeIndex | null = null
export function invalidateVariableModeIndex(): void { variableModeIndexCache = null }
export async function getVariableModeIndex(): Promise<VariableModeIndex> {
  if (variableModeIndexCache) return variableModeIndexCache
  const api = webflowApi()
  const collections = (await readOptional(() => api?.getAllVariableCollections?.())) ?? []
  const out: VariableModeIndex = { collections: [], modes: [] }
  await Promise.all(collections.map(async (c) => {
    const id = typeof c?.id === 'string' ? c.id : ''
    const name = (await readOptional(() => c?.getName?.())) ?? ''
    if (id && name) out.collections.push({ id, name })
    const modes = (await readOptional(() => c?.getAllVariableModes?.())) ?? []
    await Promise.all(modes.map(async (m) => {
      const mid = typeof m?.id === 'string' ? m.id : ''
      const mname = (await readOptional(() => m?.getName?.())) ?? ''
      if (mid && mname) out.modes.push({ id: mid, name: mname, collectionId: id })
    }))
  }))
  variableModeIndexCache = out
  return out
}

// A project variable for the "connect to variable" picker: its group (the name prefix
// before the last `/`), leaf name, human-readable value, and the `var(--…)` binding to
// write. `binding` is what Webflow's own API returns (`variable.getBinding()`).
// `type` is Webflow's variable type ('Color' | 'Size' | 'Number' | 'Percentage' |
// 'FontFamily'), used to pick the row icon in the picker.
export type ProjectVariable = { collection: string; group: string; name: string; value: string; binding: string; type: string }
let projectVariablesCache: ProjectVariable[] | null = null
export function invalidateProjectVariables(): void { projectVariablesCache = null }
export async function getProjectVariables(): Promise<ProjectVariable[]> {
  if (projectVariablesCache) return projectVariablesCache
  const api = webflowApi()
  const collections = (await readOptional(() => api?.getAllVariableCollections?.())) ?? []
  const out: ProjectVariable[] = []
  await Promise.all(collections.map(async (collectionHandle) => {
    const collName = (await readOptional(() => collectionHandle?.getName?.())) ?? ''
    const vars = (await readOptional(() => collectionHandle?.getAllVariables?.())) ?? []
    await Promise.all(vars.map(async (variable) => {
      const fullName = (await readOptional(() => variable?.getName?.())) ?? ''
      const binding = (await readOptional(() => variable?.getBinding?.())) ?? ''
      if (!fullName || !binding) return
      const value = await resolveVarValue(variable)
      const slash = fullName.lastIndexOf('/')
      const collection = collName || 'Variables'
      const group = slash >= 0 ? fullName.slice(0, slash) : ''
      const name = slash >= 0 ? fullName.slice(slash + 1) : fullName
      const type = typeof variable?.type === 'string' ? variable.type : ''
      out.push({ collection, group, name, value, binding, type })
    }))
  }))
  // Group order first-seen, names alphabetical within a group.
  out.sort((a, b) => a.name.localeCompare(b.name))
  projectVariablesCache = out
  return out
}

// Streaming variant: invokes `onAdd` for each variable the moment its name/binding/
// value resolve, rather than blocking on the whole project. Every variable is read
// concurrently (collections × variables all in flight at once), so the picker fills
// in as fast as the Designer bridge answers. Returns the full (sorted, cached) list
// once everything settles. `isCancelled` lets a closed picker stop emitting.
export async function streamProjectVariables(
  onAdd: (v: ProjectVariable) => void,
  isCancelled: () => boolean = () => false,
): Promise<ProjectVariable[]> {
  if (projectVariablesCache) {
    for (const v of projectVariablesCache) { if (isCancelled()) break; onAdd(v) }
    return projectVariablesCache
  }
  const api = webflowApi()
  const collections = (await readOptional(() => api?.getAllVariableCollections?.())) ?? []
  const out: ProjectVariable[] = []
  await Promise.all(collections.map(async (collectionHandle) => {
    const collName = (await readOptional(() => collectionHandle?.getName?.())) ?? ''
    const vars = (await readOptional(() => collectionHandle?.getAllVariables?.())) ?? []
    await Promise.all(vars.map(async (variable) => {
      const fullName = (await readOptional(() => variable?.getName?.())) ?? ''
      const binding = (await readOptional(() => variable?.getBinding?.())) ?? ''
      if (!fullName || !binding) return
      const value = await resolveVarValue(variable)
      const slash = fullName.lastIndexOf('/')
      const collection = collName || 'Variables'
      const group = slash >= 0 ? fullName.slice(0, slash) : ''
      const name = slash >= 0 ? fullName.slice(slash + 1) : fullName
      const type = typeof variable?.type === 'string' ? variable.type : ''
      const entry = { collection, group, name, value, binding, type }
      out.push(entry)
      if (!isCancelled()) onAdd(entry)
    }))
  }))
  out.sort((a, b) => a.name.localeCompare(b.name))
  projectVariablesCache = out
  return out
}
// A variable value read via `variable.get()` may be a literal string/number or a
// Variable-like object; render it as a readable CSS-ish string for the picker.
function varValueString(raw: unknown): string {
  const s = asString(raw)
  if (s) return s
  if (typeof raw === 'number') return String(raw)
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (typeof o.value === 'number' || typeof o.value === 'string') return `${o.value}${typeof o.unit === 'string' ? o.unit : ''}`
    // Webflow color object → rgba()/hex. Channels may be 0–255 ints or 0–1 floats.
    if (typeof o.red === 'number' && typeof o.green === 'number' && typeof o.blue === 'number') {
      const ch = (n: number) => Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)))
      const a = typeof o.alpha === 'number' ? o.alpha : 1
      const [r, g, b] = [o.red, o.green, o.blue].map((n) => ch(n as number))
      return a < 1
        ? `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`
        : `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
    }
    if (typeof o.type === 'string' && typeof o.value !== 'undefined') return String(o.value)
  }
  return '' // never render a raw "[object Object]"
}

// Resolve a variable's displayable value: an ALIAS variable's get() returns the referenced
// Variable (not a value), so follow that chain to a literal before stringifying. Falls back
// to the referenced variable's NAME rather than "[object Object]" if it can't be reduced.
async function resolveVarValue(variable: VarLite | undefined): Promise<string> {
  // `customValues: true` makes get() return CustomValue ({type:'custom', value:'calc(…)'})
  // for expression variables (calc / color-mix / clamp); without it they resolve to null.
  const opts: VarGetOptions = { customValues: true }
  let cur: unknown = await readOptional(() => variable?.get?.(opts))
  for (let i = 0; i < 6 && cur && typeof cur === 'object' && typeof (cur as VarLite).get === 'function'; i += 1) {
    cur = await readOptional(() => (cur as VarLite).get!(opts))
  }
  if (cur && typeof cur === 'object' && typeof (cur as VarLite).getName === 'function') {
    return (await readOptional(() => (cur as VarLite).getName!())) ?? ''
  }
  return varValueString(cur)
}

// Apply (modeId set) or remove (modeId null) a variable mode on a NATIVE style, via
// the dedicated Style API — the `--…collection-<id>` custom property can't be
// written with setProperty (Webflow rejects it as an invalid property). Resolves the
// collection + mode objects the API expects. Returns false if anything's missing, so
// the caller never silently falls back to an embed.
export async function setNativeVariableMode(
  style: unknown,
  collectionId: string,
  modeId: string | null,
  options?: NativeStyleOptions,
): Promise<boolean> {
  const handle = style as StyleHandle | null
  const api = webflowApi()
  const collection = await readOptional(() => api?.getVariableCollectionById?.(collectionId))
  if (!collection) return false
  if (modeId == null) {
    if (typeof handle?.removeVariableMode !== 'function') return false
    await handle.removeVariableMode(collection, options)
    return true
  }
  const mode = await readOptional(() => collection.getVariableModeById?.(modeId))
  if (!mode) return false
  if (typeof handle?.setVariableMode !== 'function') return false
  await handle.setVariableMode(collection, mode, options)
  return true
}

// A global compiled-name → Style handle map from getAllStyles(). Direct Style
// objects resolve their props site-wide, unlike getStyleByName(path). Handles are
// live references (getProperties stays fresh), so we build the map once per session.
let siteStyleHandles: Map<string, StyleHandle> | null = null
export function invalidateSiteStyleHandles(): void { siteStyleHandles = null }
async function getSiteStyleHandles(): Promise<Map<string, StyleHandle>> {
  if (siteStyleHandles) return siteStyleHandles
  const api = webflowApi()
  const all = api?.getAllStyles ? ((await readOptional(() => api.getAllStyles!())) ?? []) : []
  const map = new Map<string, StyleHandle>()
  await Promise.all(all.map(async (st) => {
    const nm = asString(await readOptional(() => st?.getName?.()))
    if (nm) map.set(webflowClassToCss(nm), st)
  }))
  siteStyleHandles = map
  return map
}

// Read a class's props from every handle that might resolve it, then merge per
// context. Sources disagree by canvas context: the element getStyles() handle can be
// empty inside a component; getStyleByName(path) can't resolve a combo when the
// element is a component-internal viewed from outside its component (only the base
// resolves); getStyleByName(leaf) and the getAllStyles() object can still reach the
// combo. A path lookup is preferred only when it resolves the requested leaf style;
// Webflow can return the base style for a combo path, which would otherwise replace
// the combo's values with unrelated base-class values.
async function readStyleContextsMerged(
  elementHandle: StyleHandle,
  namePath: string[],
  states: readonly StateKey[],
): Promise<Map<string, Map<string, NativeProp>>> {
  const api = webflowApi()
  const byNameCandidate = (api?.getStyleByName && namePath.length)
    ? ((await readOptional(() => api.getStyleByName!(namePath.length > 1 ? namePath : namePath[0]))) as StyleHandle | null)
    : null
  const expectedName = namePath[namePath.length - 1] ?? ''
  const resolvedName = byNameCandidate
    ? asString(await readOptional(() => byNameCandidate.getName?.())) ?? ''
    : ''
  const byName = resolvedName && webflowClassToCss(resolvedName) === webflowClassToCss(expectedName)
    ? byNameCandidate
    : null
  const [fromElement, fromName] = await Promise.all([
    readStyleContexts(elementHandle, states),
    byName?.getProperties ? readStyleContexts(byName, states) : Promise.resolve(new Map<string, Map<string, NativeProp>>()),
  ])
  const merged = new Map<string, Map<string, NativeProp>>()
  for (const [ctx, props] of fromElement) if (props.size) merged.set(ctx, new Map(props))
  // A valid path handle is canonical, but merge it per property. Replacing the whole
  // context loses values that only the element's applied handle exposes.
  for (const [ctx, props] of fromName) {
    if (!props.size) continue
    const dest = merged.get(ctx) ?? new Map<string, NativeProp>()
    for (const [prop, value] of props) dest.set(prop, value)
    merged.set(ctx, dest)
  }
  return merged
}

/**
 * Read the native class styles available to an element, each with its properties
 * bucketed by (breakpoint, state) for the requested states. Two sources:
 *   1. getStyles() — the applied Styles-panel chain (base first, then combos).
 *   2. Project styles resolved by name for classes the element carries only via
 *      its `class` attribute (set in element settings / custom code), which never
 *      appear in getStyles(). This is what lets a class like `u-theme-brand` added
 *      through the class attribute edit its real Webflow class of the same name.
 * Bounded by the read limiter.
 */
export async function readNativeStyles(
  el: AnyEl,
  states: readonly StateKey[],
  // Called with a growing model after each scan phase, so the panel can show the
  // selected element's OWN class styles right away and fill in the standalone /
  // combo-base / global-merged styles as they resolve — instead of blocking the UI
  // until the whole (multi-phase) scan finishes.
  onPartial?: (model: NativeModel) => void,
): Promise<NativeModel> {
  const styles = await readOptional(() => el.getStyles?.())
  const appliedList = Array.isArray(styles) ? styles : null

  const built: NativeStyle[] = []
  // A fresh array each emit so React re-renders; the NativeStyle objects are shared
  // (later phases only ADD info), and the next emit reflects any in-place refinement.
  const emit = () => onPartial?.({ styles: built.slice(), read: appliedList != null })

  if (appliedList) {
    const names = await Promise.all(appliedList.map((s) => (s ? readOptional(() => s.getName?.()) : null)))
    const displayNames = names.map((n) => asString(n) ?? '')
    // The display-name path up to each index (base → … → this class), skipping any
    // gaps, used to fetch a writable handle for combos.
    const prefixPath: string[][] = []
    const run: string[] = []
    displayNames.forEach((name) => {
      if (name) run.push(name)
      prefixPath.push([...run])
    })

    const appliedBuilt = await Promise.all(
      appliedList.map(async (style, index): Promise<NativeStyle | null> => {
        if (!style) return null
        const displayName = displayNames[index]
        return {
          styleId: asString(style.id) ?? `style-${index}`,
          displayName,
          className: webflowClassToCss(displayName),
          index,
          isCombo: index > 0,
          applied: true,
          namePath: prefixPath[index],
          propsByContext: await readStyleContextsMerged(style, prefixPath[index], states),
          style,
        }
      }),
    )
    built.push(...appliedBuilt.filter((style): style is NativeStyle => style != null))
  }
  emit() // the selected element's own class styles — surface these first

  // Resolve project styles for classes the element carries only via `class`.
  const api = webflowApi()
  if (api?.getStyleByName) {
    const appliedNames = new Set(built.map((style) => style.className))
    const [classAttr, resolvedClassAttr] = await Promise.all([
      readOptional(() => el.getAttributeValue?.('class')),
      readOptional(() => el.getResolvedAttributeValue?.('class')),
    ])
    const attrClasses = new Set<string>()
    splitClassTokens(asString(classAttr)).forEach((c) => attrClasses.add(webflowClassToCss(c)))
    splitClassTokens(asString(resolvedClassAttr)).forEach((c) => attrClasses.add(webflowClassToCss(c)))
    const candidates = [...attrClasses].filter((name) => name && !appliedNames.has(name))

    const standalone = await Promise.all(
      candidates.map(async (name): Promise<NativeStyle | null> => {
        const handle = (await readOptional(() => api.getStyleByName!(name))) as StyleHandle | null
        if (!handle) return null
        const displayName = asString(await readOptional(() => handle.getName?.())) ?? name
        // Guard the getStyleByName combo gotcha: only accept a base class whose
        // compiled name actually equals the class we asked for.
        if (webflowClassToCss(displayName) !== name) return null
        const propsByContext = await readStyleContexts(handle, states)
        return {
          styleId: asString(handle.id) ?? `native-${name}`,
          displayName,
          className: name,
          index: 0, // filled in below once the final order is known
          isCombo: false,
          applied: false,
          namePath: [displayName],
          propsByContext,
          style: handle,
        }
      }),
    )
    standalone.filter((style): style is NativeStyle => style != null).forEach((style) => {
      style.index = built.length
      built.push(style)
    })
  }
  emit()

  // A class used only as a combo (e.g. `.test.is-2`) may ALSO exist as a base class
  // (`.is-2`) with its own styles; resolve that base so selecting the class alone
  // shows them. `getStyleByName([leaf])` can't reliably target the base — a single
  // leaf name hits the combo gotcha and returns the COMBO whose leaf matches (same
  // props). So only accept a base whose values DIFFER from the applied combo of that
  // leaf (a genuine, distinct base); an empty base yields no props and no chip.
  if (api?.getStyleByName) {
    const have = new Set(built.filter((s) => !s.applied).map((s) => s.className))
    const combos = built.filter((s) => s.applied && s.isCombo)
    const comboLeaves = [...new Set(combos.map((s) => s.displayName))]
    const bases = await Promise.all(
      comboLeaves.map(async (displayName): Promise<NativeStyle | null> => {
        const className = webflowClassToCss(displayName)
        if (!className || have.has(className)) return null
        const handle = (await readOptional(() => api.getStyleByName!([displayName]))) as StyleHandle | null
        if (!handle) return null
        const name = asString(await readOptional(() => handle.getName?.())) ?? ''
        if (webflowClassToCss(name) !== className) return null
        const propsByContext = await readStyleContexts(handle, states)
        // Reject the combo gotcha: if the lookup read back the same values as the
        // applied combo(s) with this leaf, it's that combo, not a distinct base.
        if (!propsByContext.size) return null
        const isCombo = combos.some((c) => c.displayName === displayName && samePropsByContext(c.propsByContext, propsByContext))
        if (isCombo) return null
        return {
          styleId: asString(handle.id) ?? `base-${className}`,
          displayName,
          className,
          index: 0,
          isCombo: false,
          applied: false,
          namePath: [displayName],
          propsByContext,
          style: handle,
        }
      }),
    )
    bases.filter((s): s is NativeStyle => s != null).forEach((s) => {
      s.index = built.length
      built.push(s)
    })
  }
  emit()

  // For EVERY class the element carries, read the global getAllStyles() props (the
  // complete, canvas-independent source of truth) and let the element's own read
  // update them per-property. This way a partial or empty element read — e.g. a
  // component-internal combo selected from OUTSIDE its component, where getStyles()/
  // getStyleByName() resolve to nothing — is completed from global, while any value
  // the element did resolve still wins.
  {
    const compiled = new Set<string>()
    if (appliedList) {
      const nm = await Promise.all(appliedList.map((st) => (st ? readOptional(() => st?.getName?.()) : null)))
      nm.forEach((n) => { const c = webflowClassToCss(asString(n) ?? ''); if (c) compiled.add(c) })
    }
    const [ca, rca] = await Promise.all([
      readOptional(() => el.getAttributeValue?.('class')),
      readOptional(() => el.getResolvedAttributeValue?.('class')),
    ])
    splitClassTokens(asString(ca)).forEach((c) => { const x = webflowClassToCss(c); if (x) compiled.add(x) })
    splitClassTokens(asString(rca)).forEach((c) => { const x = webflowClassToCss(c); if (x) compiled.add(x) })

    // global as base, element props override per-property (empty contexts ignored).
    const mergeInto = (
      base: Map<string, Map<string, NativeProp>>,
      over: Map<string, Map<string, NativeProp>>,
    ): Map<string, Map<string, NativeProp>> => {
      const out = new Map<string, Map<string, NativeProp>>()
      for (const [ctx, ps] of base) out.set(ctx, new Map(ps))
      for (const [ctx, ps] of over) {
        if (!ps.size) continue
        const dest = out.get(ctx) ?? new Map<string, NativeProp>()
        for (const [k, v] of ps) dest.set(k, v)
        out.set(ctx, dest)
      }
      return out
    }

    const byClass = new Map(built.map((st) => [st.className, st]))
    const siteHandles = await getSiteStyleHandles()
    // Read every class's global props in PARALLEL (was a sequential await-in-loop —
    // the slowest phase, scaling with class count), then apply them in order.
    const globals = await Promise.all([...compiled].map(async (cls) => {
      const handle = siteHandles.get(cls)
      if (!handle?.getProperties) return null
      const globalProps = await readStyleContexts(handle, states)
      if (!globalProps.size) return null
      const isNew = !byClass.has(cls)
      const displayName = isNew ? (asString(await readOptional(() => handle.getName?.())) ?? cls) : ''
      return { cls, handle, globalProps, isNew, displayName }
    }))
    for (const g of globals) {
      if (!g) continue
      const existing = byClass.get(g.cls)
      if (existing) {
        existing.propsByContext = mergeInto(g.globalProps, existing.propsByContext)
      } else {
        built.push({
          styleId: asString(g.handle.id) ?? `global-${g.cls}`,
          displayName: g.displayName,
          className: g.cls,
          index: built.length,
          isCombo: false,
          applied: false,
          namePath: [g.displayName],
          propsByContext: g.globalProps,
          style: g.handle,
        })
      }
    }
  }
  emit()

  return { styles: built, read: appliedList != null }
}

/**
 * Read one project-level base class without requiring a selected element. This is
 * the no-selection counterpart to readNativeStyles: a selector typed into Moden can
 * still inspect and edit an existing Webflow class directly by name.
 */
export async function readNativeStyleByName(
  className: string,
  states: readonly StateKey[],
): Promise<NativeModel> {
  const compiled = webflowClassToCss(className)
  const api = webflowApi()
  if (!compiled || !api?.getStyleByName) return { styles: [], read: false }
  const handle = (await readOptional(() => api.getStyleByName!(compiled))) as StyleHandle | null
  if (!handle) return { styles: [], read: true }
  const displayName = asString(await readOptional(() => handle.getName?.())) ?? className
  // A one-name lookup can resolve a combo whose leaf happens to match. Only expose a
  // genuine base class here; combo editing still requires an element's applied chain.
  if (webflowClassToCss(displayName) !== compiled) return { styles: [], read: true }
  return {
    read: true,
    styles: [{
      styleId: asString(handle.id) ?? `native-${compiled}`,
      displayName,
      className: compiled,
      index: 0,
      isCombo: false,
      applied: false,
      namePath: [displayName],
      propsByContext: await readStyleContexts(handle, states),
      style: handle,
    }],
  }
}

/** Set a property on a native class style at the given breakpoint/pseudo. */
export async function setNativeProperty(
  handle: unknown,
  prop: string,
  value: string,
  options?: NativeStyleOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const style = handle as StyleHandle | null
  if (!style?.setProperty) return { ok: false, error: 'This class style can’t be edited here.' }
  try {
    await style.setProperty(prop, value, options)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Loose value equivalence for verifying a native write stuck (Webflow may drop a
// value silently). We DON'T require an exact value match: Webflow normalizes many
// values (colors → rgb(), `bold` → 700, shorthands), so the read-back rarely
// equals what was typed even on success. A write "applied" if the property now
// reads back as a non-empty value (or a Variable); only a null/empty read-back
// means it was dropped → fall back to an embed.
function nativeValueApplied(readBack: unknown): boolean {
  if (typeof readBack === 'string') return readBack.trim() !== ''
  // A Variable object (has getName) means Webflow stored *something* — accept it.
  return readBack != null && typeof (readBack as { getName?: unknown }).getName === 'function'
}

// Values Webflow's Style API accepts but SILENTLY DROPS (stores nothing / clears the
// prop), so the edit vanishes on the next refresh unless we verify and fall back to
// an embed. Two shapes:
//   • CSS functions — calc()/clamp()/min()/max()/env()/var()/the math funcs (round/mod/
//     sin/pow/…)… A `word(` match catches them without hitting keyword values like
//     `min-content` (no paren) or a bare `var`.
//   • CSS-wide keywords — unset/initial/inherit/revert(-layer): Webflow interprets/
//     clears these rather than storing the literal declaration (e.g. `cursor: unset`).
// When we write one, we read it back and require a round-trip match.
const CSS_FUNCTION_RE = /(?:^|[\s(,+\-*/])(?:calc|clamp|min|max|minmax|env|var|fit-content|repeat|round|mod|rem|abs|sign|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|hypot|log|exp)\s*\(/i
const CSS_WIDE_KEYWORD_RE = /^(?:unset|initial|inherit|revert|revert-layer)$/i
function isUnverifiableNativeValue(value: string): boolean {
  const v = value.trim()
  return CSS_FUNCTION_RE.test(v) || CSS_WIDE_KEYWORD_RE.test(v)
}

// A lone `var(--x)` reference (the WHOLE value) — Webflow keeps this linked in its
// custom-properties bucket, reading it back as the variable's NAME.
const LONE_VAR_RE = /^var\(\s*--[A-Za-z0-9_-]+[^)]*\)$/i
// A value that WRAPS a CSS function around its content — `calc(var(--x) + 10px)`,
// `clamp(…)`, `calc(2rem*2)`, etc. — but is NOT a bare var() reference. Webflow often
// can't store these faithfully (it mangles a wrapped var() to the resolved variable
// name, or a plain calc() to 0), so we require an exact round-trip and otherwise fall
// back to the embed, where the raw declaration renders as typed.
function isWrappedFunctionValue(value: string): boolean {
  const v = value.trim()
  if (LONE_VAR_RE.test(v)) return false
  return CSS_FUNCTION_RE.test(v)
}

function isWrappedVariableFunctionValue(value: string): boolean {
  return isWrappedFunctionValue(value) && /\bvar\(\s*--/i.test(value)
}

// Loose equality for verifying a function value round-tripped: Webflow may re-space
// a stored calc() (`1rem+1vw` ↔ `1rem + 1vw`), so compare whitespace-insensitively.
// Custom values can read back either as a bare string or as Webflow's
// `{ type: 'custom', value: 'calc(…)' }` wrapper, so unwrap the latter with the same
// helper used by the native reader. A Variable object is deliberately NOT accepted:
// that means Webflow dropped the wrapper and kept only the variable reference.
function nativeValueMatches(readBack: unknown, written: string): boolean {
  const value = asString(readBack)
  if (value == null) return false
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  return norm(value) === norm(written)
}

/**
 * Set a property natively, then read it back to confirm it actually applied.
 * Webflow's Style API accepts nearly any property/value (storing unsupported ones
 * as custom properties), but some are rejected or silently dropped — read-back is
 * the only reliable signal. `applied:false` means the caller should fall back
 * (e.g. to an embed). A thrown error is also reported as not applied.
 */
// A native write must NEVER hang the panel (the busy flag gates every control), so
// each Designer call is time-boxed. A timeout resolves to the sentinel → treated
// as "not applied" so the caller falls back to an embed instead of freezing.
const NATIVE_WRITE_TIMEOUT_MS = 4000
const TIMED_OUT = Symbol('timeout')
function timeBox<T>(run: () => Promise<T> | T): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    Promise.resolve().then(run),
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), NATIVE_WRITE_TIMEOUT_MS)),
  ])
}

export async function applyNativeProperty(
  handle: unknown,
  prop: string,
  value: string,
  options?: NativeStyleOptions,
): Promise<{ ok: true; applied: boolean; error?: string }> {
  const style = handle as StyleHandle | null
  if (!style?.setProperty) return { ok: true, applied: false, error: 'No editable Webflow class style.' }
  try {
    const result = await timeBox(() => style.setProperty!(prop, value, options))
    if (result === TIMED_OUT) return { ok: true, applied: false, error: 'Native write timed out.' }
  } catch (error) {
    // Rejected outright (e.g. InvalidStyleProperty) — treat as "not applied".
    return { ok: true, applied: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!style.getProperty) return { ok: true, applied: true } // can't verify — assume it took
  try {
    const readBack = await timeBox(() => style.getProperty!(prop, options))
    if (readBack === TIMED_OUT) return { ok: true, applied: true } // wrote but couldn't verify — assume it took
    return { ok: true, applied: nativeValueApplied(readBack) }
  } catch {
    return { ok: true, applied: true } // the write itself succeeded; only verification failed
  }
}

/** Remove a property from a native class style at the given breakpoint/pseudo. */
export async function removeNativeProperty(
  handle: unknown,
  prop: string,
  options?: NativeStyleOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const style = handle as StyleHandle | null
  if (!style?.removeProperty) return { ok: false, error: 'This class style can’t be edited here.' }
  try {
    const result = await timeBox(() => style.removeProperty!(prop, options))
    if (result === TIMED_OUT) return { ok: false, error: 'Native remove timed out.' }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Fetch the element's applied styles fresh (writable handles). A handle cached from
// an earlier read may not commit its edits — always re-read at write time.
async function freshStyles(element: AnyEl | null): Promise<StyleHandle[]> {
  if (!element?.getStyles) return []
  const styles = await readOptional(() => element.getStyles?.())
  return Array.isArray(styles) ? (styles.filter(Boolean) as StyleHandle[]) : []
}

// Re-apply the element's style list so property edits actually commit to the
// canvas — the documented final step of the Designer styling flow. Best-effort.
async function commitStyles(element: AnyEl, styles: StyleHandle[]): Promise<void> {
  if (!element.setStyles || !styles.length) return
  try {
    await timeBox(() => element.setStyles!(styles))
  } catch {
    /* the property write already landed; a failed commit just won't re-render */
  }
}

const isWritableStyle = (style: StyleHandle | null | undefined): boolean =>
  !!(style && (style.setProperties || style.setProperty))

/** Identifies which class style a native write targets. */
export type NativeWriteTarget = {
  /** Display-name path to fetch the writable handle via getStyleByName (base → … →
   *  this class for applied combos; [displayName] for a standalone class). */
  namePath: string[]
  /** Position in the applied getStyles() chain, or null for a standalone class. */
  index: number | null
}

/**
 * Resolve a WRITABLE style handle for a native write target, plus the element's
 * applied style list (for the setStyles commit). The Designer's documented write
 * flow fetches styles via webflow.getStyleByName; handles from element.getStyles()
 * aren't always writable — so prefer the by-name/path lookup, falling back to the
 * applied getStyles handle at `index` (standalone classes aren't in that list).
 */
async function writableStyleFor(
  element: AnyEl | null,
  target: NativeWriteTarget,
): Promise<{ style: StyleHandle | null; list: StyleHandle[] }> {
  const list = await freshStyles(element)
  let style: StyleHandle | null =
    target.index != null && target.index >= 0 && target.index < list.length ? list[target.index] ?? null : null
  const api = webflowApi()
  if (api?.getStyleByName && target.namePath.length) {
    const arg = target.namePath.length > 1 ? target.namePath : target.namePath[0]
    const byName = (await readOptional(() => api.getStyleByName!(arg))) as StyleHandle | null
    if (isWritableStyle(byName)) style = byName
  }
  return { style, list }
}

/**
 * Set a property on the class style at `index` of the element, following the
 * documented flow: fetch a fresh writable handle → setProperties → setStyles to
 * commit. The write is TRUSTED unless it throws or times out — Webflow accepts
 * nearly any property/value and normalizes/stores it (including as a custom
 * property), so a read-back that doesn't match the typed value is NOT a failure.
 * We only fall back to an embed when Webflow actively rejects the write. Every
 * Designer call is time-boxed so the panel can never freeze.
 */
// When writing overflow-x or overflow-y, build a payload carrying BOTH axes (the
// new value + the sibling's current value) so Webflow's overflow normalization
// keeps both. Returns null for any other property (use the single-property setter).
const OVERFLOW_SIBLING: Record<string, string> = { 'overflow-x': 'overflow-y', 'overflow-y': 'overflow-x' }

// Properties Webflow validates against a closed set and silently DROPS (no throw)
// when the value isn't recognized — so the trusted write must read them back to know
// it actually stuck. `font-family` is the case: Webflow only stores fonts that exist
// in the project, dropping an arbitrary/custom family. We presence-check ONLY (never
// an exact-value match, and never shorthands, which Webflow may split into longhands
// that read back empty) so a normalized/custom-property value still counts as applied.
const VERIFY_PRESENCE_PROPS = new Set(['font-family'])
// Grid-item placement has no dedicated slot in Webflow's Style model — Webflow files it
// under the class's Custom-properties bucket. So it must go through the custom-bucket
// write path (which re-sends every existing custom value, or the bucket rebuild wipes
// them) and be verified via getProperties — a plain setProperty + single getProperty
// reads these back empty and would wrongly treat them as "not applied".
const GRID_PLACEMENT_PROPS = new Set([
  'grid-area', 'grid-column', 'grid-row',
  'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
])
async function overflowAxisPayload(
  style: StyleHandle,
  prop: string,
  value: string,
  options?: NativeStyleOptions,
): Promise<Record<string, string> | null> {
  const sibling = OVERFLOW_SIBLING[prop]
  if (!sibling || !style.getProperties) return null
  const payload: Record<string, string> = { [prop]: value }
  const current = await readOptional(() => style.getProperties!(options))
  const siblingVal = current && typeof current === 'object' ? (current as Record<string, unknown>)[sibling] : undefined
  if (typeof siblingVal === 'string' && siblingVal.trim() !== '') payload[sibling] = siblingVal
  return payload
}

// Values Webflow can't map onto a native control land in the style's "Custom
// properties" bucket: container-query / modern-viewport units, `calc()` over them,
// CSS-wide keywords (`unset`/`inherit`/…), a raw `var()`, or a font-family fallback
// stack. These are perfectly valid natively — the catch is the Designer API rebuilds
// that bucket from a SINGLE write, so writing one alone drops the class's other custom
// properties (add line-height → the custom font-size vanishes).
const CUSTOM_UNIT_RE = /[\d.]+(cq[whib]|cqmin|cqmax|[sld]v[whib]|[sld]vmin|[sld]vmax)\b/i
const CSS_WIDE_KEYWORDS = new Set(['unset', 'inherit', 'initial', 'revert', 'revert-layer'])
function isCustomPropertyValue(prop: string, value: string): boolean {
  // Grid-item placement always lives in Webflow's Custom-properties bucket, so it
  // takes the bulk write/verify path regardless of the value.
  if (GRID_PLACEMENT_PROPS.has(prop)) return true
  if (CUSTOM_UNIT_RE.test(value)) return true
  if (CSS_WIDE_KEYWORDS.has(value.trim().toLowerCase())) return true
  if (value.includes('var(')) return true
  if (prop === 'font-family' && value.includes(',')) return true
  return false
}

// Build a write that PRESERVES the class's existing custom properties. Webflow
// rebuilds the whole custom-property bucket from a SINGLE write, so a plain
// setProperty — even of a NORMAL value — wipes any custom values the class already
// holds (write `border-width: 4px` → a custom `border-radius: 11cqw` vanishes). We
// read the current declarations and re-send every string-valued one alongside the new
// value in one setProperties call, so all custom values coexist. Variable-bound props
// (Style objects, not strings) are left out — the API keeps those across the write.
// Returns null (use the plain single-prop setter) only when neither the new value nor
// any existing declaration is a custom-bucket value, i.e. nothing needs protecting.
async function customPropertyPayload(
  style: StyleHandle,
  prop: string,
  value: string,
  options?: NativeStyleOptions,
): Promise<Record<string, string> | null> {
  if (!style.getProperties || !style.setProperties) return null
  // Wrapped variable expressions are property values, not variable definitions. Send
  // them through the single-property string setter so Webflow stores the authored calc()
  // directly on the style instead of rebuilding its custom-property bucket.
  if (isWrappedVariableFunctionValue(value)) return null
  const current = await readOptional(() => style.getProperties!(options))
  const merged: Record<string, string> = {}
  let needsPreserve = isCustomPropertyValue(prop, value)
  if (current && typeof current === 'object') {
    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() !== '') {
        // Webflow's variable-mode bindings (`--…collection-<id>: mode-<id>`) surface
        // as string declarations, but setProperties rejects them as invalid style
        // properties — they're managed via setVariableMode, not this bucket. Re-sending
        // one fails the whole native write, so leave it out (Webflow preserves it).
        // Match by NAME — the value can read back in forms parseModeProp doesn't catch.
        if (isVariableModeProp(k)) continue
        // A multi-layer image prop reads back with `@img_<ref>` tokens, which are NOT a
        // valid WRITE value — re-sending one empties the layer. Resolve to `url(...)` (the
        // documented setProperties format) so the round-trip preserves the image.
        merged[k] = IMAGE_PROPS.has(k) ? await resolveAssetRefs(v) : v
        if (k !== prop && isCustomPropertyValue(k, v)) needsPreserve = true
      }
    }
  }
  if (!needsPreserve) return null
  merged[prop] = value
  return merged
}

// Live (preview) native write that STILL preserves the custom-property bucket and the
// overflow pair. A plain setProperty rebuilds the bucket from that one write, so a
// class's custom values (e.g. `border-radius: 11cqw`) would flicker away on every
// keystroke while typing a normal value — and that thrash can send Webflow's own style
// panel into a re-render loop. Unlike the commit path there's no read-back / setStyles:
// it's a fast throttled preview; the blur commit is authoritative.
export async function liveSetNativeProperty(
  handle: unknown,
  prop: string,
  value: string,
  options?: NativeStyleOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const style = handle as StyleHandle | null
  if (!style?.setProperty && !style?.setProperties) return { ok: false, error: 'This class style can’t be edited here.' }
  // Never live-write a CSS function WRAPPING content — calc()/clamp()/min()/max()/…
  // (e.g. `calc(var(--x) + 10px)`). While the token editor is being composed, Webflow
  // can coerce an intermediate/partially parsed value to `0`, and this preview path has
  // no read-back or rollback. Keep the previous value visible until blur; the authoritative
  // commit then writes the completed expression once and verifies the exact custom value.
  // A lone `var(--x)` reference is excluded because it stores and previews natively.
  if (isWrappedFunctionValue(value)) return { ok: true }
  try {
    const flexPayload = prop === 'flex' ? parseFlexShorthand(value) : null
    const overflowPayload = flexPayload ? null : await overflowAxisPayload(style, prop, value, options)
    const payload = flexPayload ?? overflowPayload ?? (await customPropertyPayload(style, prop, value, options))
    if (payload && style.setProperties) await style.setProperties(payload, options)
    else if (style.setProperty) await style.setProperty(prop, value, options)
    else if (style.setProperties) await style.setProperties({ [prop]: value }, options)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// A border / radius shorthand and the per-side (or per-corner) longhands it
// supersedes. Webflow stores borders as per-side longhands, so setting the
// shorthand and then removing the longhands in SEPARATE writes makes its panel
// flash the border to "none" between the two commits. We instead remove them in
// the same commit as the shorthand set (see applyNativePropertyAt).
const BORDER_SHORTHAND_LONGHANDS: Record<string, readonly string[]> = {
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
}

const isFlexNumber = (token: string) => /^-?(?:\d+\.?\d*|\.\d+)$/.test(token)

// Webflow stores flex-child sizing as the `flex-grow` / `flex-shrink` / `flex-basis`
// longhands and silently drops the `flex` shorthand. So when a `flex` write comes in
// we expand it per the CSS shorthand grammar and write the three longhands in ONE
// setProperties commit. Returns null for values we can't safely expand (CSS-wide
// keywords, malformed input) — those fall through to the plain setter (and its
// verify/embed fallback).
export function parseFlexShorthand(value: string): Record<string, string> | null {
  const v = value.trim().toLowerCase()
  if (v === 'none') return { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' }
  if (v === 'auto') return { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': 'auto' }
  if (v === 'initial') return { 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto' }
  if (v === '' || /^(inherit|unset|revert|revert-layer)$/.test(v)) return null
  // A CSS function (var()/calc()/env()/clamp()/…) can span the whole shorthand; don't
  // try to split it into longhands — write it as the raw `flex` value (→ embed).
  if (/[a-z-]+\(/i.test(v)) return null
  const tokens = v.split(/\s+/)
  if (tokens.length > 3) return null
  let grow: string, shrink: string, basis: string
  if (tokens.length === 1) {
    if (isFlexNumber(tokens[0])) { grow = tokens[0]; shrink = '1'; basis = '0' }
    else { grow = '1'; shrink = '1'; basis = tokens[0] }
  } else if (tokens.length === 2) {
    grow = tokens[0]
    if (isFlexNumber(tokens[1])) { shrink = tokens[1]; basis = '0' }
    else { shrink = '1'; basis = tokens[1] }
  } else {
    grow = tokens[0]; shrink = tokens[1]; basis = tokens[2]
  }
  if (!isFlexNumber(grow) || !isFlexNumber(shrink)) return null
  return { 'flex-grow': grow, 'flex-shrink': shrink, 'flex-basis': basis }
}

export async function applyNativePropertyAt(
  el: unknown,
  target: NativeWriteTarget,
  prop: string,
  value: string,
  options?: NativeStyleOptions,
): Promise<{ ok: true; applied: boolean; error?: string }> {
  const element = el as AnyEl | null
  const { style, list } = await writableStyleFor(element, target)
  if (!style) return { ok: true, applied: false, error: 'Couldn’t find the class style on this element.' }
  const fail = (error: string): { ok: true; applied: false; error: string } => ({ ok: true, applied: false, error })
  // `flex` expands to its longhands (Webflow drops the shorthand — see parseFlexShorthand);
  // hoisted so the post-commit verification can skip reading the shorthand back.
  const flexPayload = prop === 'flex' ? parseFlexShorthand(value) : null
  try {
    // Webflow normalizes overflow-x / overflow-y together: setting one axis on its
    // own drops the other (unlike independent longhands such as padding-*). So when
    // writing either axis, read the sibling axis's current value and write BOTH in a
    // single setProperties call — the only way to keep both. `setProperty` is used
    // for every other property (it sets one value additively).
    // A custom-property value must be written alongside the class's existing custom
    // properties (else it clobbers them); overflow axes are written as a pair. Both are
    // setProperties payloads; every other property uses the plain single-value setter.
    const overflowPayload = flexPayload ? null : await overflowAxisPayload(style, prop, value, options)
    const payload = flexPayload ?? overflowPayload ?? (await customPropertyPayload(style, prop, value, options))
    const write = payload && style.setProperties
      ? () => style.setProperties!(payload, options)
      : style.setProperty
        ? () => style.setProperty!(prop, value, options)
        : style.setProperties
          ? () => style.setProperties!({ [prop]: value }, options)
          : null
    if (!write) return fail('This class style isn’t writable.')
    const result = await timeBox(write)
    if (result === TIMED_OUT) return fail('Native write timed out.')
    rememberAuthoredFunction(style, prop, value, options)
  } catch (error) {
    // Only an actual rejection (e.g. InvalidStyleProperty) sends it to an embed.
    return fail(error instanceof Error ? error.message : String(error))
  }
  // Drop the per-side/per-corner longhands this shorthand supersedes IN THIS COMMIT,
  // so Webflow's panel never flashes the border to "none" between two writes.
  const superseded = BORDER_SHORTHAND_LONGHANDS[prop]
  if (superseded && style.removeProperty) {
    await Promise.all(superseded.map((p) => timeBox(() => style.removeProperty!(p, options)).then(() => {}, () => {})))
  }
  if (element) await commitStyles(element, list)
  // An expanded `flex` write stored the longhands, never the `flex` shorthand — so a
  // read-back of `flex` is meaningless here (always empty). Trust the longhand commit.
  if (flexPayload) return { ok: true, applied: true }
  // For a plain font NAME, confirm Webflow actually stored it — an empty read-back means
  // it dropped an unknown font, so fall back to an embed. SKIP this for custom-property
  // values (`unset`/`var()`/`cqw`…): Webflow keeps those in its Custom properties section
  // but getProperty can read them back resolved/empty, which would falsely fail the check
  // and spill a value that DID apply natively into an embed.
  if (VERIFY_PRESENCE_PROPS.has(prop) && !isCustomPropertyValue(prop, value) && style.getProperty) {
    const readBack = await timeBox(() => style.getProperty!(prop, options))
    if (readBack !== TIMED_OUT && !nativeValueApplied(readBack)) {
      return fail(`Webflow doesn’t have “${value}” as a project font`)
    }
  } else if (isUnverifiableNativeValue(value) && !isCustomPropertyValue(prop, value) && style.getProperty) {
    // A plain calc()/… call with NO custom unit/var (e.g. `calc(100% - 10px)`): Webflow
    // stores it as a regular value, so a single getProperty read-back is meaningful.
    // Confirm it round-tripped; if not, fall back to an embed (where the raw declaration
    // renders) instead of letting the edit vanish. Values that ARE custom-property values
    // (cqw / var() / keywords — even when also wrapped in a function like
    // `shape(… calc(… 100cqw …) …)`) live in the Custom-properties bucket and are verified
    // via getProperties below, since a single getProperty reads those back empty.
    const readBack = await timeBox(() => style.getProperty!(prop, options))
    if (readBack !== TIMED_OUT && !nativeValueMatches(readBack, value)) {
      return fail(`Webflow wouldn’t store “${value}” natively`)
    }
  } else if (isCustomPropertyValue(prop, value) && style.getProperties) {
    // A custom-unit / keyword / var() value is valid, but the bulk setProperties write
    // DROPS it for some known properties (e.g. `border-radius: 5cqw`) even though a
    // plain setProperty would keep it in the Custom-properties bucket. Verify via
    // getProperties — the same bulk read our model uses, so it reports the custom
    // bucket faithfully (single getProperty can read these back empty). If it didn't
    // land, fall back to an embed so the value isn't silently lost on commit.
    const readBack = await timeBox(() => style.getProperties!(options))
    const stored = readBack !== TIMED_OUT && readBack && typeof readBack === 'object'
      ? (readBack as Record<string, unknown>)[prop] : undefined
    // A wrapped expression must remain the exact authored string; accepting a Variable
    // object here would hide an accidental variable binding. A lone var() only needs
    // presence because Webflow may read that binding back as a Variable object.
    const ok = isWrappedFunctionValue(value) ? nativeValueMatches(stored, value) : nativeValueApplied(stored)
    if (readBack !== TIMED_OUT && !ok) {
      return fail(`Webflow wouldn’t store “${value}” natively`)
    }
  }
  return { ok: true, applied: true }
}

/**
 * Create (or reuse) the BASE class style for `className` and set one property on it.
 * Used when a class exists only as a combo (e.g. `.test.is-2`) so it has no base
 * `.is-2` block yet — the user asked to style it as a base, which means creating it.
 * The element already carries the class, so the new base style applies to it.
 */
export async function applyNativeToNewBaseClass(
  el: unknown,
  className: string,
  prop: string,
  value: string,
  options?: NativeStyleOptions,
): Promise<{ ok: true; applied: boolean; error?: string }> {
  const api = webflowApi()
  if (!api?.createStyle) return { ok: true, applied: false, error: 'Class creation isn’t available in this Designer.' }
  const element = el as AnyEl | null

  // Create a fresh base class. Do NOT fall back to getStyleByName for a combo-only
  // class — it returns a `.x.is-2` combo from ANOTHER element, which we'd then
  // wrongly write to / attach.
  let style: StyleHandle | null = null
  let createErr = ''
  try {
    style = (await api.createStyle(className)) as StyleHandle | null
  } catch (e) { createErr = e instanceof Error ? e.message : String(e) }
  if (!isWritableStyle(style)) return { ok: true, applied: false, error: createErr || 'Couldn’t create the Webflow class style.' }

  const fail = (error: string): { ok: true; applied: false; error: string } => ({ ok: true, applied: false, error })

  // `flex` is stored as its longhands (Webflow drops the shorthand — see parseFlexShorthand).
  const flexPayload = prop === 'flex' ? parseFlexShorthand(value) : null
  try {
    const write = flexPayload && style!.setProperties
      ? () => style!.setProperties!(flexPayload, options)
      : style!.setProperty
        ? () => style!.setProperty!(prop, value, options)
        : style!.setProperties
          ? () => style!.setProperties!({ [prop]: value }, options)
          : null
    if (!write) return fail('The new class style isn’t writable.')
    const result = await timeBox(write)
    if (result === TIMED_OUT) return fail('Native write timed out.')
    rememberAuthoredFunction(style!, prop, value, options)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  // NOTE: intentionally NOT calling element.setStyles — attaching a style handle to
  // the element can pull in an unrelated combo's classes and corrupt the element.
  void element
  // A calc()/var()/… value or CSS-wide keyword may have been silently dropped (see
  // applyNativeProperty); confirm it stuck, else fall back to an embed.
  if (!flexPayload && isUnverifiableNativeValue(value) && style!.getProperty) {
    const readBack = await timeBox(() => style!.getProperty!(prop, options))
    if (readBack !== TIMED_OUT && !nativeValueMatches(readBack, value)) {
      return fail(`Webflow wouldn’t store “${value}” natively`)
    }
  }
  return { ok: true, applied: true }
}

/** Remove properties from the class style at `index`, then commit via setStyles. */
export async function removeNativePropertyAt(
  el: unknown,
  target: NativeWriteTarget,
  props: string[],
  options?: NativeStyleOptions,
): Promise<{ ok: boolean; error?: string }> {
  const element = el as AnyEl | null
  const { style, list } = await writableStyleFor(element, target)
  if (!style?.removeProperty) return { ok: false, error: 'Couldn’t find the class style on this element.' }
  // Snapshot current values up front so an overflow-axis removal can restore its
  // sibling (removeProperty on one overflow axis wipes both — see overflowAxisPayload).
  const removing = new Set(props)
  const current = style.getProperties ? await readOptional(() => style.getProperties!(options)) : null
  const currentObj = current && typeof current === 'object' ? (current as Record<string, unknown>) : null
  // `removeProperty` is the ONLY deletion API — setProperties merges, so a property can't
  // be dropped by omitting it from a payload (it just persists). But each removeProperty
  // makes Webflow rebuild the class's whole Custom-properties bucket, so its own panel
  // visibly clears every custom prop and re-adds them (the "clear-all then reapply"
  // flash). We can't suppress that rebuild, but we CAN avoid triggering it more than
  // necessary: only remove properties actually set on this class at this breakpoint/state.
  // A grid-axis clear passes the shorthand + both longhands, yet usually only the
  // shorthand is set — skipping the two absent no-op removals turns three bucket rebuilds
  // into one. Fall back to all props when the read failed (currentObj null).
  const isSet = (p: string): boolean => {
    if (!currentObj) return true
    const v = currentObj[p]
    return typeof v === 'string' ? v.trim() !== '' : v != null
  }
  const toRemove = props.filter(isSet)
  let failed = 0
  for (const prop of toRemove) {
    try {
      const result = await timeBox(() => style.removeProperty!(prop, options))
      if (result === TIMED_OUT) { failed += 1; continue }
      rememberAuthoredFunction(style, prop, null, options)
      // removeProperty on one overflow axis also wipes the other. If the sibling
      // should stay (it's set and not being removed too), re-add it afterwards so
      // only the target axis is cleared.
      const sibling = OVERFLOW_SIBLING[prop]
      const siblingVal = currentObj && sibling ? currentObj[sibling] : undefined
      if (sibling && !removing.has(sibling) && typeof siblingVal === 'string' && siblingVal.trim() !== '' && style.setProperties) {
        const restored = await timeBox(() => style.setProperties!({ [sibling]: siblingVal }, options))
        if (restored === TIMED_OUT) failed += 1
      }
    } catch {
      failed += 1
    }
  }
  if (element) await commitStyles(element, list)
  return { ok: failed === 0, error: failed ? `${failed} removal${failed === 1 ? '' : 's'} failed.` : undefined }
}
