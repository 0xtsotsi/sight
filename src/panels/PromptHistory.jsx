// src/panels/PromptHistory.jsx
//
// Local-only prompt history for the agent composer.
//
// Stores the last N prompts in localStorage. The composer calls
// `record()` on submit; the ⌃R reverse-search overlay reads from
// `list()` and `search()`. We never persist anything else — no analytics,
// no remote storage, no encryption secrets. The user keeps control of
// their data via the standard "Clear site data" mechanism.

const LS_KEY = 'sight:agent:prompt-history';
const MAX_ENTRIES = 50;

function safeRead() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

function safeWrite(entries) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // best-effort; quota exhaustion is non-fatal
  }
}

export function recordPrompt(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) return;
  const existing = safeRead();
  // Move-to-front (most recent first).
  const next = [text, ...existing.filter((e) => e !== text)].slice(0, MAX_ENTRIES);
  safeWrite(next);
}

export function listPrompts() {
  return safeRead();
}

export function clearPrompts() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

// Substring search by case-insensitive inclusion. Returns the most recent
// matches first.
export function searchPrompts(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return listPrompts();
  return listPrompts().filter((p) => p.toLowerCase().includes(q));
}

// ⌃R overlay — bound to a single input value. Cycles through history
// matches. Returns the next candidate prompt after the current cursor
// position in the history list.
//
// `current` is the user's current composer input (so the first step off
// "no match" returns the most recent prompt, not `current` itself).
export function reverseSearchStep(history, current, currentIndex = -1) {
  if (!history || history.length === 0) return { value: current, index: -1, matched: false };
  const next = currentIndex + 1;
  const idx = next >= history.length ? 0 : next;
  const value = history[idx];
  return { value, index: idx, matched: true };
}
