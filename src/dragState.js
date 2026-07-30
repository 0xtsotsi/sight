// What's currently being dragged, shared across panels.
//
// dragover can't read dataTransfer payloads (only their type names), so the
// drop targets have no way to ask "is this a <p>?" while the pointer is
// moving — which is exactly when an invalid drop needs to be refused. Drags
// never leave this window, so a module-level record is enough.
//
// { kind: 'node' | 'component', tag?: string, nodeKind?: string, id?: string }
let current = null;

export function setDrag(info) {
  current = info || null;
}

export function clearDrag() {
  current = null;
}

export function getDrag() {
  return current;
}
