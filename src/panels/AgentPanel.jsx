// src/panels/AgentPanel.jsx
//
// Right-rail panel — chat-style interface to the gg-coder agent.
//
// Wires the panel-facing event stream from src/agent/client.js into a
// minimal chat UI. The hard design rule (enforced by tools.js + diff.js,
// NOT by this file) is that the agent can never write the user's
// project directly — every edit surfaces as a Diff card with Apply/Reject.
//
// Apply dispatches through the window.avb.writePage IPC; Reject discards.
// Selection + undo/redo integration lands in task 5; this task is the UI
// shell + streaming plumbing.
//
// Event-type enum is duplicated locally with a pointer to the canonical
// src/agent/types.js. Dedupe at integration time (task 5 / task 8).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { runAgentStream } from '../agent/client.js';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import styles from './AgentPanel.module.css';

// Mirror of src/agent/types.js EVENT enum. Kept inline so this file can
// render before the types module loads (and to keep the test snapshot
// stable). Update both in lockstep.
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
});

// ---------------------------------------------------------------------------
// Hook: read agent credential once per panel mount.
// ---------------------------------------------------------------------------

function useCredential() {
  const [state, setState] = useState({ status: 'loading', credential: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await window.avb.getAgentCredential();
        if (!alive) return;
        if (r?.ok) setState({ status: 'ready', credential: r.credential });
        else setState({ status: 'missing', credential: null });
      } catch {
        if (alive) setState({ status: 'missing', credential: null });
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
}) {
  const credential = useCredential();
  const [messages, setMessages] = useState([]); // [{role, content, id}]
  const [events, setEvents] = useState([]); // accumulated panel events for the in-flight turn
  const [input, setInput] = useState('');
  const [includePage, setIncludePage] = useState(true);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const eventsRef = useRef([]);

  // Auto-scroll on new events / messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, messages]);

  const updateEvents = useCallback((updater) => {
    setEvents((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      eventsRef.current = next;
      return next;
    });
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
    const userMsg = { role: 'user', content: text, id: `u-${Date.now()}` };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setBusy(true);
    updateEvents(() => []);

    const controller = new AbortController();
    abortRef.current = controller;
    const collected = [];
    try {
      const stream = runAgentStream({
        messages: [...messages, userMsg],
        snapshot,
        systemPrompt: buildSystemPrompt(snapshot),
        credential: credential.credential,
        signal: controller.signal,
      });
      for await (const ev of stream) {
        collected.push(ev);
        // Live-update: append the latest event so the user sees streaming
        // text / tool trace / diff cards in real time.
        updateEvents((prev) => [...prev, ev]);
        // When the diff event arrives, the user can interact even though
        // busy is still true — the turn may continue with follow-up edits.
      }
    } catch (err) {
      updateEvents((prev) => [
        ...prev,
        { type: EVENT.ERROR, message: err?.message ?? String(err) },
      ]);
    } finally {
      setBusy(false);
      abortRef.current = null;
      // Once the stream finishes, fold collected events into the message
      // list as a single assistant turn so the chat history reads cleanly.
      const assistantContent = collected
        .filter((e) => e?.type === EVENT.TEXT)
        .map((e) => e.delta)
        .join('');
      if (assistantContent) {
        setMessages((m) => [...m, { role: 'assistant', content: assistantContent, id: `a-${Date.now()}` }]);
      }
    }
  }, [
    busy,
    input,
    credential,
    project,
    selectedNodeId,
    activePagePath,
    includePage,
    includeSelection,
    pageModel,
    messages,
    updateEvents,
    showToast,
  ]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort?.();
  }, []);

  const handleApply = useCallback(async (diff) => {
    try {
      // Task 5: dispatch through the App.jsx reducer path so the edit
      // gets undo/redo + dirty tracking + the same save/markSelfWrite
      // flow human edits use. We do NOT call window.avb.writePage here.
      onApplyDiff?.(diff);
      updateEvents((prev) => prev.filter((e) => !(e.type === EVENT.DIFF && e.path === diff.path && e.summary === diff.summary)));
    } catch (err) {
      showToast?.(String(err?.message ?? err), 'error');
    }
  }, [onApplyDiff, showToast, updateEvents]);

  const handleReject = useCallback((diff) => {
    onRejectDiff?.(diff);
    updateEvents((prev) => prev.filter((e) => !(e.type === EVENT.DIFF && e.path === diff.path && e.summary === diff.summary)));
  }, [onRejectDiff, updateEvents]);

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

      <div ref={scrollRef} className={styles.scroll}>
        {messages.map((m) => (
          <div key={m.id} className={`${styles.message} ${styles[`message_${m.role}`]}`}>
            <div className={styles.messageRole}>{m.role}</div>
            <div className={styles.messageContent}>{m.content}</div>
          </div>
        ))}

        {/* In-flight turn: live events stream below the user message */}
        {busy && events.length > 0 && (
          <div className={styles.live}>
            {events.map((e, i) => {
              if (!e || typeof e !== 'object') return null;
              switch (e.type) {
                case EVENT.TEXT:
                  return <div key={i} className={styles.liveText}>{e.delta}</div>;
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
                      onApply={handleApply}
                      onReject={handleReject}
                      disabled={credential.status !== 'ready'}
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
            {busy && (
              <button className={styles.abort} onClick={handleAbort}>Stop</button>
            )}
          </div>
        )}
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
