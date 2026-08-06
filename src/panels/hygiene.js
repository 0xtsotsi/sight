// src/panels/hygiene.js
//
// Pure transform over the turn list. The chat transcript grows unbounded
// during long sessions — image attachments pile up, large tool results
// stay in the rendered DOM, and adjacent tool updates create noise.
//
// `pruneTurns(turns, opts)` returns a new turn list with the following
// rules applied in order:
//
//  1. Image attachments: keep the first N (default 5) tool results with
//     `kind === 'image'`; replace the rest with a placeholder noting
//     the image was cleared. Image attachments are stored as media
//     events with provider === 'image' on the assistant turn.
//  2. Tool result compaction: any tool result whose JSON size exceeds
//     `maxToolResultBytes` (default 5 KB) is collapsed to a placeholder
//     of the form `[Tool result cleared: 12.3 KB]`. The original size
//     is preserved on the event as `originalBytes`.
//  3. Adjacent tool updates: two consecutive `tool` events with the
//     same `name` and `status: 'update'` collapse into the most recent
//     one (it's a streaming progress for the same tool call).
//
// The function is pure — it does not mutate the input. The caller
// passes the result back to `setTurns` and React re-renders.

const DEFAULTS = {
  keepImageAttachments: 5,
  maxToolResultBytes: 5 * 1024,
};

function eventSize(e) {
  if (!e) return 0;
  let n = 0;
  if (typeof e.result === 'string') n += e.result.length;
  if (e.result && typeof e.result === 'object') n += JSON.stringify(e.result).length;
  if (typeof e.delta === 'string') n += e.delta.length;
  if (typeof e.svg === 'string') n += e.svg.length;
  if (e.assets && Array.isArray(e.assets)) {
    for (const a of e.assets) n += (a?.bytes || 0) + (a?.path?.length || 0);
  }
  return n;
}

function isImageAttachment(e) {
  if (!e) return false;
  if (e.type === 'media' && e.kind === 'image') return true;
  if (e.type === 'tool' && e.kind === 'image') return true;
  if (e.type === 'tool' && e.result && typeof e.result === 'object' && e.result.kind === 'image') return true;
  return false;
}

function clearImageAttachment(e) {
  if (!e) return e;
  return {
    ...e,
    cleared: true,
    result: '[Image cleared]',
    delta: undefined,
    svg: undefined,
    assets: [],
  };
}

function clearToolResult(e, originalBytes) {
  if (!e) return e;
  const kb = (originalBytes / 1024).toFixed(1);
  return {
    ...e,
    truncated: true,
    originalBytes,
    result: `[Tool result cleared: ${kb} KB]`,
  };
}

export function pruneTurns(turns, opts = {}) {
  if (!Array.isArray(turns)) return [];
  const cfg = { ...DEFAULTS, ...opts };
  let imageCount = 0;
  const out = turns.map((turn) => {
    if (!turn || typeof turn !== 'object') return turn;
    const events = Array.isArray(turn.events) ? turn.events : [];
    const newEvents = [];
    let lastToolUpdate = null;
    for (const e of events) {
      // (3) Adjacent tool updates collapse.
      if (e && e.type === 'tool' && e.status === 'update' && lastToolUpdate
          && lastToolUpdate.type === 'tool' && lastToolUpdate.status === 'update'
          && lastToolUpdate.name === e.name) {
        // Replace the previous update with the new one.
        newEvents[newEvents.length - 1] = e;
        lastToolUpdate = e;
        continue;
      }
      // (1) Image attachments: drop after N.
      if (isImageAttachment(e)) {
        if (imageCount < cfg.keepImageAttachments) {
          newEvents.push(e);
          imageCount += 1;
        } else {
          newEvents.push(clearImageAttachment(e));
        }
        lastToolUpdate = null;
        continue;
      }
      // (2) Tool result compaction.
      const size = eventSize(e);
      if (e && e.type === 'tool' && size > cfg.maxToolResultBytes) {
        newEvents.push(clearToolResult(e, size));
        lastToolUpdate = null;
        continue;
      }
      newEvents.push(e);
      lastToolUpdate = (e && e.type === 'tool') ? e : null;
    }
    return { ...turn, events: newEvents };
  });
  return out;
}
