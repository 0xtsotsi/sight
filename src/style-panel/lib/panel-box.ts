// Where the panel ends.
//
// Popovers in this panel are absolutely positioned and right-anchored to their
// label, so a field in the left column pushes the menu's left edge past the
// panel edge. Every one of them clamps itself back inside — but they were
// written against moden, where `.app_body` is both the visible panel and the
// scroll container, and this app has neither: the panel is `.style-panel-host`
// wrapping `.embed-editor_root`, and that root is the scroller (overflow-y:
// auto, overflow-x: clip — see styles.css).
//
// Falling back to `document.documentElement` there was the bug: the menus were
// clamped to the WINDOW, so no shift was ever applied, and the panel's
// overflow-x clipped whatever hung past its edge.

/** The panel's visible box — what a popover must stay inside. */
export function panelBox(anchor: Element): HTMLElement | null {
  // `.app_body` first (moden), where `.embed-editor_root` is an inner box and
  // the wrong answer; `closest` on both at once would pick the nearer root.
  return (
    anchor.closest<HTMLElement>('.app_body') ??
    anchor.closest<HTMLElement>('.embed-editor_root') ??
    null
  )
}

/** That box's rect, or the window when the panel isn't found. */
export function panelBounds(anchor: Element): DOMRect {
  const el = panelBox(anchor)
  return (el ?? document.documentElement).getBoundingClientRect()
}
