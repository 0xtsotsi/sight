/*
 * Local UI preferences — kept separate from `storage.ts` (which owns the auth
 * session). Independent prefs:
 *   - toolOrder:   the user's drag-reordered order of tool ids
 *   - lastTool:    the tool that was open when the app last closed (view state)
 *   - embedSource: the embed the Style Editor last targeted for new styles
 * All best-effort: any read/parse failure falls back to a sensible default rather
 * than throwing, so a corrupt value never blocks the app from loading.
 */

const ORDER_KEY = 'moden.toolOrder'
const LAST_TOOL_KEY = 'moden.lastTool'
// The embed the Style Editor last targeted for new custom styles — restored as the
// default so a chosen embed (e.g. a global-CSS embed) sticks across reloads.
const EMBED_SOURCE_KEY = 'moden.embedEditor.source'

export function loadToolOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

export function saveToolOrder(ids: string[]) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
  } catch {
    /* noop */
  }
}

export function loadLastTool(): string | null {
  try {
    const raw = localStorage.getItem(LAST_TOOL_KEY)
    return raw && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

export function saveLastTool(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_TOOL_KEY, id)
    else localStorage.removeItem(LAST_TOOL_KEY)
  } catch {
    /* noop */
  }
}

export function loadEmbedSource(): string | null {
  try {
    const raw = localStorage.getItem(EMBED_SOURCE_KEY)
    return raw && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

export function saveEmbedSource(key: string | null) {
  try {
    if (key) localStorage.setItem(EMBED_SOURCE_KEY, key)
    else localStorage.removeItem(EMBED_SOURCE_KEY)
  } catch {
    /* noop */
  }
}

/**
 * Apply a saved id order to the current registry: known ids keep the saved
 * order, ids that no longer exist are dropped, and any tools missing from the
 * saved order (newly added) are appended in their registry order. This keeps a
 * stale localStorage value from ever hiding a tool.
 */
export function orderTools<T extends { id: string }>(tools: T[], savedOrder: string[]): T[] {
  const remaining = new Map(tools.map((tool) => [tool.id, tool]))
  const result: T[] = []
  for (const id of savedOrder) {
    const tool = remaining.get(id)
    if (tool) {
      result.push(tool)
      remaining.delete(id)
    }
  }
  for (const tool of tools) {
    if (remaining.has(tool.id)) result.push(tool)
  }
  return result
}
