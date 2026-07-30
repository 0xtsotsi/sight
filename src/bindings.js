// Whether a node renders data rather than fixed markup — an expression prop
// (`href={service.link}`), an `{expr}` child, or text with an interpolation
// in it. Only the node's own props and its direct children count: a section
// isn't "bound" just because something deep inside it is.
export function isDataBound(node) {
  if (!node) return false;
  for (const v of Object.values(node.props || {})) {
    if (v?.type === 'expr') return true;
  }
  for (const c of node.children || []) {
    if (c.kind === 'expr') return true;
    if (c.kind === 'text' && /\{[^{}]*\}/.test(c.value || '')) return true;
  }
  return false;
}
