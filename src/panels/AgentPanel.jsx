// src/panels/AgentPanel.jsx
//
// Right-rail panel — chat-style interface to the gg-coder agent.
//
// Wires the panel-facing event stream from src/agent/client.js into a
// virtualized chat UI. The hard design rule (enforced by tools.js + diff.js,
// NOT by this file) is that the agent can never write the user's project
// directly — every edit surfaces as a Diff card with Apply/Reject.
//
// Apply dispatches through the App.jsx mutateModel path; Reject discards.
// The message list is virtualized via @tanstack/react-virtual — only the
// mounted rows see React's render cost, so a 1000-turn transcript scrolls
// smoothly. Consecutive assistant text chunks are grouped into a single
// turn bubble so the streaming experience reads as one continuous answer.
//
// Event-type enum is duplicated locally with a pointer to the canonical
// src/agent/types.js. Dedupe at integration time.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { runAgentStream } from '../agent/client.js';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import { getAgentSlashCommands } from '../ui/command-registry.js';
import { recordPrompt, searchPrompts, reverseSearchStep } from './PromptHistory.jsx';
import { turnsToMarkdown } from './transcript-md.js';
import RegionHandle from './RegionHandle.jsx';
import styles from './AgentPanel.module.css';

// Mirror of src/agent/types.js EVENT enum. Kept inline so this file can
// render before the types module loads. Update both in lockstep.
const EVENT = Object.freeze({
  TEXT: 'text',
  THINKING: 'thinking',
  TOOL: 'tool',
  DIFF: 'diff',
  RETRY: 'retry',
  TRUNCATED: 'truncated',
  CHECKPOINT: 'checkpoint',
  TURN_END: 'turn_end',
  DONE: 'done',
  MAX_TURNS: 'max_turns',
  ERROR: 'error',
  VISUAL_DIRECTION: 'visual_direction',
  MEDIA: 'media',
  WORKFLOW: 'workflow',
});

// Stick-to-bottom threshold (px). If the user is within this many pixels of
// the bottom when new content arrives, auto-scroll; otherwise leave them
// alone so reading earlier turns isn't disrupted.
const STICK_TO_BOTTOM_PX = 32;
const ROW_OVERSCAN = 6;

// ---------------------------------------------------------------------------
// Turn model
// ---------------------------------------------------------------------------
//
// A Turn is either a user message or an assistant message. Assistant turns
// carry the rich event list (text deltas, tool traces, diff cards, etc.) so
// the virtualizer can render a complete bubble per turn without re-deriving
// streams from a global event log on every keystroke.
//
// id: stable string used as the React key and DOM data-testid suffix.
// role: 'user' | 'assistant'
// content: aggregated text (assistant: concatenation of TEXT deltas).
// ts: epoch ms; used for the hover-reveal timestamp in M4.
// events: only set for the in-flight assistant turn.
// status: 'pending' (streaming) | 'done' (committed).

let turnCounter = 0;
function newTurnId(role) {
  turnCounter += 1;
  return `${role}-${Date.now().toString(36)}-${turnCounter}`;
}

function emptyTurn(role, content, ts = Date.now()) {
  return { id: newTurnId(role), role, content, ts, events: [], status: 'done' };
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Hook: read agent credential once per panel mount.
// ---------------------------------------------------------------------------

function useCredential() {
  const [state, setState] = useState({ status: 'loading', credential: [REDACTED] });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await window.avb.getAgentCredential();
        if (!alive) return;
        if (r?.ok) setState({ status: 'ready', credential: [REDACTED] });
        else setState({ status: 'missing', credential: [REDACTED] });
      } catch {
        if (alive) setState({ status: 'missing', credential: [REDACTED] });
      }
    })();
    return () => { alive = false; };
  }, []);
  return state;
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function ToolTrace({ name, status, args, result, error, durationMs, children }) {
  const [open, setOpen] = useState(false);
  const label = status === 'started' ? 'running…' : status === 'done' ? `${durationMs ?? 0}ms` : status === 'error' ? 'error' : 'update';
  return (
    <div className={styles.toolTrace}>
      <button className={styles.toolTraceToggle} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`${styles.toolStatus} ${styles[`toolStatus_${status}`] || ''}`}>{label}</span>
        <span className={styles.toolName}>{name ?? '(tool)'}</span>
      </button>
      {open && (
        <div className={styles.toolTraceBody}>
          {args !== undefined && (
            <pre className={styles.toolArgs}><code>{JSON.stringify(args, null, 2)}</code></pre>
          )}
          {result !== undefined && (
            <pre className={styles.toolResult}><code>{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</code></pre>
          )}
          {error && <pre className={styles.toolError}><code>{error}</code></pre>}
          {children}
        </div>
      )}
    </div>
  );
}

function DiffCard({ diff, onApply, onReject, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.diffCard}>
      <div className={styles.diffHeader}>
        <strong>Proposed change</strong>
        <span className={styles.diffSummary}>{diff.summary}</span>
      </div>
      {diff.unifiedDiff && (
        <button className={styles.diffToggle} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide diff' : 'Show diff'}
        </button>
      )}
      {open && diff.unifiedDiff && (
        <pre className={styles.diffBody}><code>{diff.unifiedDiff}</code></pre>
      )}
      <div className={styles.diffActions}>
        <button className={styles.diffApply} disabled={disabled} onClick={() => onApply(diff)}>Apply</button>
        <button className={styles.diffReject} disabled={disabled} onClick={() => onReject(diff)}>Reject</button>
      </div>
    </div>
  );
}

function MissingKeyBanner() {
  return (
    <div className={styles.banner}>
      <strong>No provider key configured.</strong>
      <p>
        Add one of these keys to <code>~/.gg/settings.json</code>:
        <br />
        <code>[REDACTED]</code>, <code>ANTHROPIC_API_KEY</code>,
        <code> OPENAI_API_KEY</code>, or <code>GEMINI_API_KEY</code>.
      </p>
      <p>
        Or run <code>ggcoder login</code> to write <code>~/.gg/auth.json</code> —
        the panel reads that file as a fallback. See{' '}
        <code>electron/agentCredential.js</code> for the lookup table.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Render one assistant turn. Includes the aggregated text + the rich event
// list (tool traces, diff cards, mediacards, etc.). When the turn is still
// in-flight, the rich events stream in; when committed, they stay frozen.
// ---------------------------------------------------------------------------

function TurnBubble({ turn, onApply, onReject, disabled, onVisualDirectionChoose, onVisualDirectionSkip, onMediaApprove, onMediaReject, onAbort, busy }) {
  const isUser = turn.role === 'user';
  const eventList = Array.isArray(turn.events) ? turn.events : [];
  return (
    <div data-testid="turn" data-role={turn.role} className={`${styles.message} ${styles[`message_${turn.role}`]}`}>
      <div className={styles.messageRole}>{turn.role}</div>
      <span className={styles.timestamp} data-testid="turn-timestamp">{formatTimestamp(turn.ts)}</span>
      <div className={styles.messageContent}>{turn.content}</div>
      {!isUser && eventList.length > 0 && (
        <div className={styles.live}>
          {eventList.map((e, i) => {
            if (!e || typeof e !== 'object') return null;
            switch (e.type) {
              case EVENT.TEXT:
                return <span key={i} className={styles.liveText}>{e.delta}</span>;
              case EVENT.THINKING:
                return <ThinkingBlock key={i} delta={e.delta} startedAt={e.ts || Date.now()} />;
              case EVENT.TOOL:
                return (
                  <ToolTrace
                    key={i}
                    name={e.name}
                    status={e.status}
                    args={e.args}
                    result={e.result}
                    error={e.error}
                    durationMs={e.durationMs}
                  />
                );
              case EVENT.DIFF:
                return (
                  <DiffCard
                    key={i}
                    diff={e}
                    onApply={onApply}
                    onReject={onReject}
                    disabled={disabled}
                  />
                );
              case EVENT.RETRY:
                return <div key={i} className={styles.liveMeta}>retry: {e.reason} ({e.attempt}/{e.maxAttempts})</div>;
              case EVENT.TRUNCATED:
                return <div key={i} className={styles.liveMeta}>truncated: {e.reason}</div>;
              case EVENT.ERROR:
                return <div key={i} className={styles.liveError}>{e.message}</div>;
              case EVENT.MAX_TURNS:
                return <div key={i} className={styles.liveMeta}>max turns reached ({e.maxTurns})</div>;
              default:
                return null;
            }
          })}
          {busy && turn.status === 'pending' && (
            <TypingDots />
          )}
          {busy && turn.status === 'pending' && (
            <button className={styles.abort} onClick={onAbort} aria-label="Stop generating">Stop</button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThinkingBlock — collapsible; the header shows a live `mm:ss` timer while
// the thinking chunk is still streaming. Collapses when the user clicks the
// caret.
// ---------------------------------------------------------------------------

function ThinkingBlock({ delta, startedAt }) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - (startedAt || now));
  const seconds = Math.floor(elapsed / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <div className={styles.thinkingBlock}>
      <button
        type="button"
        className={styles.thinkingHeader}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={styles.thinkingCaret}>{open ? '▾' : '▸'}</span>
        <span className={styles.thinkingLabel}>thinking</span>
        <span className={styles.thinkingTimer} data-testid="thinking-timer">{mm}:{ss}</span>
      </button>
      {open && (
        <div className={styles.thinkingBody}>{delta}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TypingDots — three pulsing dots shown while the agent is generating.
// ---------------------------------------------------------------------------

function TypingDots() {
  return (
    <span className={styles.typingDots} aria-label="Generating" data-testid="typing-dots">
      <span className={styles.typingDot} />
      <span className={styles.typingDot} />
      <span className={styles.typingDot} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AgentPanel({
  project,
  pageModel,
  selectedNodeId,
  activePagePath,
  onApplyDiff,
  onRejectDiff,
  showToast,
  initialTurns,
  turns: turnsProp,
  // Region controls the snap mode: 'full' | 'bottom' | 'left' | 'right'.
  region,
  onRegionChange,
  width,
  onWidthChange,
  // Test-only hook: lets the test environment inject a fixed viewport
  // height so the virtualizer renders its visible window in jsdom. Never
  // set in production.
  viewportHeight,
  // Test-only hook: bypass the virtualizer and render rows directly. Useful
  // when the test environment cannot perform layout (e.g. jsdom). Never
  // set in production.
  disableVirtualizer,
  // Test-only hook: controlled input value. Lets the test drive the
  // composer without going through React's synthetic event system.
  inputValue,
  onInputChange,
}) {
  const credential = useCredential();
  const [turns, setTurns] = useState(() => {
    if (Array.isArray(turnsProp)) return turnsProp;
    if (Array.isArray(initialTurns)) return initialTurns;
    return [];
  }); // ordered Turn[]
  const [input, setInput] = useState(typeof inputValue === 'string' ? inputValue : '');
  const [includePage, setIncludePage] = useState(true);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [model, setModel] = useState('anthropic');
  const [thinking, setThinking] = useState('off');
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // True when the user has manually scrolled away from the bottom. Suppresses
  // auto-scroll-on-new-turn so reading earlier turns isn't disrupted.
  const stickToBottomRef = useRef(true);

  // ─── Composer overlays (slash menu, @-mention picker, ⌃R history) ───
  const slashCommands = useMemo(() => getAgentSlashCommands(), []);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState('');
  const slashMenu = useMemo(() => {
    const q = slashQuery.toLowerCase();
    if (!q) return slashCommands;
    return slashCommands.filter((c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
  }, [slashCommands, slashQuery]);

  const mentionList = useMemo(() => {
    if (!pageModel || !pageModel.nodes || !Array.isArray(pageModel.nodes)) return [];
    const out = [];
    function walk(ns, depth) {
      if (!Array.isArray(ns)) return;
      for (const n of ns) {
        if (!n) continue;
        out.push({
          id: n.id || `${depth}-${out.length}`,
          label: n.name || n.tag || n.kind || n.id,
          hint: n.kind || (n.tag ? `<${n.tag}>` : 'node'),
        });
        if (n.children) walk(n.children, depth + 1);
      }
    }
    walk(pageModel.nodes, 0);
    return out;
  }, [pageModel]);

  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionQuery, setMentionQuery] = useState('');
  const filteredMentions = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    if (!q) return mentionList;
    return mentionList.filter((n) => (n.label || '').toLowerCase().includes(q) || (n.hint || '').toLowerCase().includes(q));
  }, [mentionList, mentionQuery]);

  const [reverseSearchOpen, setReverseSearchOpen] = useState(false);
  const [reverseSearchQuery, setReverseSearchQuery] = useState('');
  const [reverseSearchIndex, setReverseSearchIndex] = useState(-1);
  const reverseSearchMatches = useMemo(() => searchPrompts(reverseSearchQuery), [reverseSearchQuery]);

  function applySlash(cmd) {
    const el = composerRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const before = input.slice(0, start);
    const after = input.slice(start);
    const slashAt = before.lastIndexOf('/');
    const newStart = slashAt >= 0 ? slashAt : start;
    const newText = input.slice(0, newStart) + cmd.insert + after;
    setInput(newText);
    setShowSlashMenu(false);
    setSlashQuery('');
    setSlashMenuIndex(0);
    // Restore caret to the end of the inserted command.
    requestAnimationFrame(() => {
      const cursor = newStart + cmd.insert.length;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }

  function applyMention(node) {
    const el = composerRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const before = input.slice(0, start);
    const after = input.slice(start);
    const atAt = before.lastIndexOf('@');
    const newStart = atAt >= 0 ? atAt : start;
    const chip = '@' + node.label + ' ';
    const newText = input.slice(0, newStart) + chip + after;
    setInput(newText);
    setShowMentionMenu(false);
    setMentionQuery('');
    setMentionIndex(0);
    requestAnimationFrame(() => {
      const cursor = newStart + chip.length;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }

  const onPaste = useCallback(async (e) => {
    if (!e.clipboardData) return;
    const items = Array.from(e.clipboardData.items || []);
    const files = items
      .map((it) => it.getAsFile && it.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return;
    e.preventDefault();
    const newAtts = files.map((f) => ({
      id: 'att-' + Math.random().toString(36).slice(2, 10),
      name: f.name || 'pasted-file',
      size: f.size || 0,
      type: f.type || 'application/octet-stream',
      blob: f,
    }));
    setAttachments((prev) => [...prev, ...newAtts]);
  }, []);

  // Virtualizer — measured rows; only the visible window is mounted.
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: ROW_OVERSCAN,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 96,
  });

  // Track whether the user is at the bottom of the scroller. When a new turn
  // arrives, we only scroll-to-bottom if the user was already there.
  const recomputeStickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= STICK_TO_BOTTOM_PX;
  }, []);

  const handleScroll = useCallback(() => {
    recomputeStickToBottom();
  }, [recomputeStickToBottom]);

  // Each time the list of turns changes, decide whether to scroll to the new
  // last row. Virtualizer measure is async, so we run after layout.
  const lastTurnCountRef = useRef(turns.length);
  useLayoutEffect(() => {
    if (scrollRef.current && turns.length > lastTurnCountRef.current && stickToBottomRef.current) {
      virtualizer.scrollToIndex(turns.length - 1, { align: 'end' });
    }
    lastTurnCountRef.current = turns.length;
  }, [turns, virtualizer]);

  // DEV-mode test hook: lets the visual-verification script seed N turns
  // without actually calling the agent. Guarded on import.meta.env.DEV so
  // it never lands in production builds.
  if (import.meta.env && import.meta.env.DEV && typeof window !== 'undefined') {
    window.__seedTurns = (n) => {
      const seeded = [];
      for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        const content = role === 'user'
          ? `Seeded user prompt #${i + 1}`
          : `Seeded assistant response #${i + 1} — ${'padding '.repeat(40).trim()}`;
        seeded.push({ ...emptyTurn(role, content), ts: Date.now() + i });
      }
      setTurns(seeded);
    };
  }

  const updateTurn = useCallback((id, updater) => {
    setTurns((prev) => {
      const next = prev.map((t) => (t.id === id ? updater(t) : t));
      return next;
    });
  }, []);

  const appendEventToTurn = useCallback((id, event) => {
    setTurns((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      const events = [...(t.events || []), event];
      // Aggregate text deltas into the turn's content for chat-history
      // readability even when the bubble is rendered separately.
      const content = event.type === EVENT.TEXT
        ? t.content + event.delta
        : t.content;
      return { ...t, events, content };
    }));
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    const text = input.trim();
    if (!text) return;
    if (credential.status !== 'ready') {
      showToast?.('Configure a provider key first', 'error');
      return;
    }
    // Record the prompt in local history before sending.
    try { recordPrompt(text); } catch {}
    // Close any open overlays.
    setShowSlashMenu(false);
    setShowMentionMenu(false);
    setReverseSearchOpen(false);
    setAttachments([]);
    const snapshot = {
      projectPath: project?.path,
      selectedNodeId: includeSelection ? selectedNodeId : null,
      activePagePath: includePage ? activePagePath : null,
      pageModel: includePage ? pageModel : null,
    };
    const userTurn = emptyTurn('user', text);
    setTurns((prev) => [...prev, userTurn]);
    setInput('');
    setBusy(true);
    // Pin to the bottom so the user's new message (and the streaming answer)
    // appear in view.
    stickToBottomRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    // Create the pending assistant turn up-front so the virtualizer can
    // size a row for it. Group consecutive assistant chunks into a single
    // bubble; the panel mutates this turn in place as events arrive.
    const assistantTurn = { ...emptyTurn('assistant', ''), status: 'pending', events: [] };
    setTurns((prev) => [...prev, assistantTurn]);

    try {
      const stream = runAgentStream({
        messages: [...turnsRef.current.filter((t) => t.role !== 'pending'), userTurn].map((t) => ({ role: t.role, content: t.content })),
        snapshot,
        systemPrompt: buildSystemPrompt(snapshot),
        credential: [REDACTED],
        signal: controller.signal,
      });
      for await (const ev of stream) {
        appendEventToTurn(assistantTurn.id, ev);
      }
    } catch (err) {
      appendEventToTurn(assistantTurn.id, { type: EVENT.ERROR, message: err?.message ?? String(err) });
    } finally {
      setBusy(false);
      abortRef.current = null;
      // Mark the assistant turn as committed so the bubble freezes.
      setTurns((prev) => prev.map((t) => (t.id === assistantTurn.id ? { ...t, status: 'done' } : t)));
    }
  }, [
    busy,
    input,
    credential.status,
    project,
    selectedNodeId,
    activePagePath,
    includePage,
    includeSelection,
    pageModel,
    showToast,
    appendEventToTurn,
  ]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort?.();
  }, []);

  const handleApply = useCallback(async (diff) => {
    try {
      onApplyDiff?.(diff);
      setTurns((prev) => prev.map((t) => {
        if (!t.events) return t;
        return { ...t, events: t.events.filter((e) => !(e && e.type === EVENT.DIFF && e.path === diff.path && e.summary === diff.summary)) };
      }));
    } catch (err) {
      showToast?.(String(err?.message ?? err), 'error');
    }
  }, [onApplyDiff, showToast]);

  const handleReject = useCallback((diff) => {
    onRejectDiff?.(diff);
    setTurns((prev) => prev.map((t) => {
      if (!t.events) return t;
      return { ...t, events: t.events.filter((e) => !(e && e.type === EVENT.DIFF && e.path === diff.path && e.summary === diff.summary)) };
    }));
  }, [onRejectDiff]);

  const handleVisualDirectionChoose = useCallback((directionId, variant) => {
    showToast?.(`Visual direction pinned: ${directionId}${variant ? ' (asking for variants)' : ''}`);
    setTurns((prev) => prev.map((t) => {
      if (!t.events) return t;
      return { ...t, events: t.events.map((e) => (
        e && e.type === EVENT.VISUAL_DIRECTION && e.status === 'proposed'
          ? { ...e, status: variant ? 'variants' : 'chosen', directionId }
          : e
      )) };
    }));
  }, [showToast]);

  const handleVisualDirectionSkip = useCallback(() => {
    showToast?.('Visual direction skipped');
    setTurns((prev) => prev.map((t) => {
      if (!t.events) return t;
      return { ...t, events: t.events.map((e) => (
        e && e.type === EVENT.VISUAL_DIRECTION && e.status === 'proposed'
          ? { ...e, status: 'skipped' }
          : e
      )) };
    }));
  }, [showToast]);

  const handleMediaApprove = useCallback((event) => {
    showToast?.(`Media approved: ${event.tool} (one-shot)`);
    setTurns((prev) => prev.map((t) => {
      if (!t.events) return t;
      return { ...t, events: t.events.map((e) => (
        e === event ? { ...e, status: 'ok', result: { ...e.result, _approved: true } } : e
      )) };
    }));
  }, [showToast]);

  const handleMediaReject = useCallback((event) => {
    showToast?.(`Media rejected: ${event.tool}`);
    setTurns((prev) => prev.map((t) => {
      if (!t.events) return t;
      return { ...t, events: t.events.map((e) => (e === event ? { ...e, status: 'cancelled' } : e)) };
    }));
  }, [showToast]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const onKeyDown = (e) => {
    // ⌃R / Ctrl+R — reverse-search prompt history.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      setReverseSearchOpen(true);
      setReverseSearchIndex(-1);
      return;
    }
    // Slash menu / mention picker navigation.
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashMenuIndex((i) => Math.min(slashMenu.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashMenuIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' && slashMenu[slashMenuIndex]) {
        e.preventDefault();
        applySlash(slashMenu[slashMenuIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }
    if (showMentionMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => Math.min(filteredMentions.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' && filteredMentions[mentionIndex]) {
        e.preventDefault();
        applyMention(filteredMentions[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionMenu(false);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  const panelStyle = (region === 'left' || region === 'right' || !region)
    ? { width: width || 360, height: '100%', position: 'relative' }
    : region === 'bottom'
      ? { height: width || 360, width: '100%', position: 'relative' }
      : { position: 'relative' };

  return (
    <div className={styles.panel} style={panelStyle} data-region={region || 'right'}>
      {region !== 'full' && (region === 'left' || region === 'right' || !region) && (
        <RegionHandle
          edge={region === 'left' ? 'right' : 'left'}
          value={width || 360}
          onResize={(v) => onWidthChange?.(v)}
          onCommit={(v) => onWidthChange?.(v)}
        />
      )}
      {region === 'bottom' && (
        <RegionHandle
          edge="top"
          value={width || 360}
          onResize={(v) => onWidthChange?.(v)}
          onCommit={(v) => onWidthChange?.(v)}
        />
      )}
      <div className={styles.header}>
        <strong>Agent</strong>
        <span className={styles.subtitle}>gg-coder</span>
        <div className={styles.headerActions}>
          <select
            className={styles.regionSelect}
            value={region || 'right'}
            onChange={(e) => onRegionChange?.(e.target.value)}
            data-testid="region-select"
            aria-label="Snap region"
          >
            <option value="right">Right</option>
            <option value="left">Left</option>
            <option value="bottom">Bottom</option>
            <option value="full">Full</option>
          </select>
          <button
            type="button"
            className={styles.copyBtn}
            onClick={async () => {
              const md = turnsToMarkdown(turns);
              try {
                if (navigator?.clipboard?.writeText) {
                  await navigator.clipboard.writeText(md);
                  showToast?.('Transcript copied', 'success');
                } else {
                  showToast?.('Clipboard not available', 'error');
                }
              } catch (err) {
                showToast?.('Copy failed', 'error');
              }
            }}
            data-testid="copy-transcript"
            aria-label="Copy transcript as Markdown"
          >
            Copy MD
          </button>
        </div>
      </div>

      {credential.status === 'loading' && (
        <div className={styles.banner}>Loading credential…</div>
      )}
      {credential.status === 'missing' && <MissingKeyBanner />}

      <div
        ref={scrollRef}
        className={styles.scroll}
        data-testid="agent-scroll"
        onScroll={handleScroll}
        style={{ position: 'relative' }}
      >
        <div style={{ height: disableVirtualizer ? 'auto' : totalHeight, position: disableVirtualizer ? 'static' : 'relative' }}>
          {(disableVirtualizer ? turns : virtualItems.map((vi) => turns[vi.index]).filter(Boolean)).map((turn) => {
            if (!turn) return null;
            if (disableVirtualizer) {
              return (
                <div key={turn.id} data-index={turn.id}>
                  <TurnBubble
                    turn={turn}
                    onApply={handleApply}
                    onReject={handleReject}
                    disabled={credential.status !== 'ready'}
                    onVisualDirectionChoose={handleVisualDirectionChoose}
                    onVisualDirectionSkip={handleVisualDirectionSkip}
                    onMediaApprove={handleMediaApprove}
                    onMediaReject={handleMediaReject}
                    onAbort={handleAbort}
                    busy={busy}
                  />
                </div>
              );
            }
            const vi = virtualItems.find((v) => v.index === turns.indexOf(turn));
            return (
              <div
                key={turn.id}
                data-index={vi ? vi.index : 0}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vi ? vi.start : 0}px)`,
                }}
              >
                <TurnBubble
                  turn={turn}
                  onApply={handleApply}
                  onReject={handleReject}
                  disabled={credential.status !== 'ready'}
                  onVisualDirectionChoose={handleVisualDirectionChoose}
                  onVisualDirectionSkip={handleVisualDirectionSkip}
                  onMediaApprove={handleMediaApprove}
                  onMediaReject={handleMediaReject}
                  onAbort={handleAbort}
                  busy={busy}
                />
              </div>
            );
          })}
        </div>
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        <div className={styles.toggles}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={includePage}
              onChange={(e) => setIncludePage(e.target.checked)}
            />
            <span>Include current page</span>
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={includeSelection}
              onChange={(e) => setIncludeSelection(e.target.checked)}
            />
            <span>Include selection</span>
          </label>
          <label className={styles.toggle}>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={styles.modelPicker}
              data-testid="model-picker"
              aria-label="Model provider"
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="claudeCode">Claude Code</option>
            </select>
          </label>
          <label className={styles.toggle}>
            <select
              value={thinking}
              onChange={(e) => setThinking(e.target.value)}
              className={styles.thinkingPicker}
              data-testid="thinking-picker"
              aria-label="Thinking depth"
            >
              <option value="off">No thinking</option>
              <option value="low">Light</option>
              <option value="medium">Medium</option>
              <option value="high">Deep</option>
            </select>
          </label>
        </div>
        <div className={styles.composerRow}>
          <textarea
            ref={composerRef}
            className={styles.input}
            placeholder={credential.status === 'ready' ? 'Ask the agent… (/ commands, @ nodes, Enter to send, Shift+Enter newline)' : 'Configure a provider key to begin'}
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              onInputChange?.(v);
              // Detect slash-trigger at the start of a token. Use the end
              // of the value when no selection is set (jsdom + simulate cases).
              const caret = (typeof e.target.selectionStart === 'number' && e.target.selectionStart > 0)
                ? e.target.selectionStart
                : v.length;
              const before = v.slice(0, caret);
              const slashMatch = before.match(/(^|\s)\/([^\s]*)$/);
              if (slashMatch) {
                setShowSlashMenu(true);
                setSlashQuery(slashMatch[2]);
                setSlashMenuIndex(0);
              } else {
                setShowSlashMenu(false);
              }
              const mentionMatch = before.match(/(^|\s)@([^\s]*)$/);
              if (mentionMatch) {
                setShowMentionMenu(true);
                setMentionQuery(mentionMatch[2]);
                setMentionIndex(0);
              } else {
                setShowMentionMenu(false);
              }
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={busy || credential.status !== 'ready'}
            rows={3}
            data-testid="composer-input"
          />
          {showSlashMenu && slashMenu.length > 0 && (
            <div className={styles.popover} data-testid="slash-menu" role="listbox">
              {slashMenu.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={i === slashMenuIndex}
                  className={`${styles.popoverItem} ${i === slashMenuIndex ? styles.popoverItemActive : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); applySlash(c); }}
                  data-testid={`slash-cmd-${c.id}`}
                >
                  <span className={styles.popoverCmd}>{c.label}</span>
                  <span className={styles.popoverHint}>{c.hint}</span>
                </button>
              ))}
            </div>
          )}
          {showMentionMenu && filteredMentions.length > 0 && (
            <div className={styles.popover} data-testid="mention-menu" role="listbox">
              {filteredMentions.map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  role="option"
                  aria-selected={i === mentionIndex}
                  className={`${styles.popoverItem} ${i === mentionIndex ? styles.popoverItemActive : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); applyMention(n); }}
                  data-testid={`mention-${n.id}`}
                >
                  <span className={styles.popoverCmd}>{n.label}</span>
                  <span className={styles.popoverHint}>{n.hint}</span>
                </button>
              ))}
            </div>
          )}
          {reverseSearchOpen && (
            <div className={styles.reverseSearch} data-testid="reverse-search">
              <span className={styles.reverseSearchLabel}>⌃R</span>
              <input
                className={styles.reverseSearchInput}
                value={reverseSearchQuery}
                onChange={(e) => {
                  setReverseSearchQuery(e.target.value);
                  setReverseSearchIndex(-1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const next = reverseSearchStep(reverseSearchMatches, input, reverseSearchIndex);
                    if (next.matched) {
                      setInput(next.value);
                      setReverseSearchIndex(next.index);
                    }
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setReverseSearchOpen(false);
                  }
                }}
                placeholder="search prompt history"
                autoFocus
              />
            </div>
          )}
        </div>
        {attachments.length > 0 && (
          <div className={styles.attachments} data-testid="attachments">
            {attachments.map((a) => (
              <span key={a.id} className={styles.attachmentChip} data-testid={`attachment-${a.id}`}>
                <span className={styles.attachmentName}>{a.name}</span>
                <button
                  type="button"
                  className={styles.attachmentRemove}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className={styles.composerActions}>
          <span className={styles.hint}>Enter to send · Shift+Enter newline · / commands · @ nodes · ⌃R history</span>
          <button type="submit" className={styles.send} disabled={busy || !input.trim() || credential.status !== 'ready'}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
