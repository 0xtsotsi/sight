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
      <div className={styles.messageContent}>{turn.content}</div>
      {!isUser && eventList.length > 0 && (
        <div className={styles.live}>
          {eventList.map((e, i) => {
            if (!e || typeof e !== 'object') return null;
            switch (e.type) {
              case EVENT.TEXT:
                return <span key={i} className={styles.liveText}>{e.delta}</span>;
              case EVENT.THINKING:
                return <div key={i} className={styles.liveThinking}>{e.delta}</div>;
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
            <button className={styles.abort} onClick={onAbort}>Stop</button>
          )}
        </div>
      )}
    </div>
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
  // Test-only hook: lets the test environment inject a fixed viewport
  // height so the virtualizer renders its visible window in jsdom. Never
  // set in production.
  viewportHeight,
  // Test-only hook: bypass the virtualizer and render rows directly. Useful
  // when the test environment cannot perform layout (e.g. jsdom). Never
  // set in production.
  disableVirtualizer,
}) {
  const credential = useCredential();
  const [turns, setTurns] = useState(() => {
    if (Array.isArray(turnsProp)) return turnsProp;
    if (Array.isArray(initialTurns)) return initialTurns;
    return [];
  }); // ordered Turn[]
  const [input, setInput] = useState('');
  const [includePage, setIncludePage] = useState(true);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // True when the user has manually scrolled away from the bottom. Suppresses
  // auto-scroll-on-new-turn so reading earlier turns isn't disrupted.
  const stickToBottomRef = useRef(true);

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

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <strong>Agent</strong>
        <span className={styles.subtitle}>gg-coder</span>
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
        </div>
        <textarea
          className={styles.input}
          placeholder={credential.status === 'ready' ? 'Ask the agent… (Enter to send, Shift+Enter for newline)' : 'Configure a provider key to begin'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || credential.status !== 'ready'}
          rows={3}
        />
        <div className={styles.composerActions}>
          <span className={styles.hint}>Enter to send · Shift+Enter newline</span>
          <button type="submit" className={styles.send} disabled={busy || !input.trim() || credential.status !== 'ready'}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
