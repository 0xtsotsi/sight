import React from 'react';
import { buildTransitionGraph, layoutGraph, pickLastTransition } from '../transitions/graph.js';

// Studio panel: shows every transition:name, transition:animate, and
// view-transition-name in the project as a graph, plus a list of all
// transitions and a "Play last" button that asks the live preview iframe
// to replay its most recent transition at 0.25x speed.
//
// The panel re-renders on every scan (cheap: a flat list and a small SVG)
// and on every event the preview iframe posts. Events are kept in a
// ring buffer so the log doesn't grow without bound.
const EVENT_BUFFER = 50;

// Locate the live preview iframe in the studio mode. There's exactly one
// `.preview-mode iframe` in the DOM when the user has hit the "Preview"
// button, so a direct query is enough — no prop drilling, no context.
function findPreviewIframe() {
  const el = document.querySelector('.preview-mode iframe');
  return el && el.contentWindow ? el : null;
}

export default function TransitionsPanel({ project }) {
  const [scan, setScan] = React.useState({ transitions: [], pages: [] });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [logActive, setLogActive] = React.useState(false);
  const [events, setEvents] = React.useState([]);
  const [selectedNode, setSelectedNode] = React.useState(null);

  const projectPath = project?.path || null;

  // Pull the scan whenever the project path changes. The watcher in
  // main.js triggers the renderer to re-scan on every file change, but
  // for now we re-fetch on mount and on path change — a future commit
  // can wire the scan into the existing fs:changed broadcast.
  React.useEffect(() => {
    if (!projectPath || !window.avb?.listTransitions) {
      setScan({ transitions: [], pages: [] });
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.avb
      .listTransitions(projectPath)
      .then((r) => {
        if (cancelled) return;
        setScan(r || { transitions: [], pages: [] });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err?.message || err));
        setScan({ transitions: [], pages: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Subscribe to the broadcasted event stream whenever the panel mounts
  // in a project. The forwarder in PreviewPane / App.jsx calls
  // postTransitionEvent, main re-broadcasts it as `transition:event`,
  // and the listener below appends to the in-memory log.
  React.useEffect(() => {
    if (!window.avb?.onTransition) return undefined;
    const off = window.avb.onTransition((evt) => {
      setEvents((prev) => {
        const next = [...prev, evt];
        return next.length > EVENT_BUFFER ? next.slice(-EVENT_BUFFER) : next;
      });
    });
    return off;
  }, []);

  // Toggle the log on/off — the renderer keeps the onTransition listener
  // alive regardless (cheap), but the IPC handler in main.js only
  // re-broadcasts while `transitionLogActive` is true. This keeps the
  // noise out of the panel when the user is editing, not watching.
  const toggleLog = React.useCallback(async () => {
    if (!window.avb) return;
    if (logActive) {
      const r = await window.avb.stopTransitionLog();
      if (r?.ok) setLogActive(false);
    } else {
      const r = await window.avb.startTransitionLog();
      if (r?.ok) setLogActive(true);
    }
  }, [logActive]);

  const graph = React.useMemo(
    () => buildTransitionGraph(scan.pages, scan.transitions),
    [scan]
  );
  const laid = React.useMemo(() => layoutGraph(graph, { width: 720, height: 360 }), [graph]);

  const last = React.useMemo(() => pickLastTransition(scan.transitions), [scan]);

  const playLast = React.useCallback(() => {
    const iframe = findPreviewIframe();
    if (!iframe) return;
    iframe.contentWindow.postMessage({ type: 'sight:replay', speed: 0.25 }, '*');
  }, []);

  return (
    <div className="transitions-panel">
      <div className="transitions-header">
        <div className="transitions-title">Transitions</div>
        <div className="transitions-counts">
          <span>{graph.nodes.length} page{graph.nodes.length === 1 ? '' : 's'}</span>
          <span className="dot">·</span>
          <span>{graph.edges.length} shared name{graph.edges.length === 1 ? '' : 's'}</span>
          <span className="dot">·</span>
          <span>{scan.transitions.length} directive{scan.transitions.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="transitions-toolbar">
        <button
          className={`transitions-log-toggle ${logActive ? 'on' : ''}`}
          onClick={toggleLog}
          title="When on, the live preview forwards every astro:transitions event to this panel."
        >
          {logActive ? 'Stop event log' : 'Watch live events'}
        </button>
        <button
          className="transitions-play-last"
          onClick={playLast}
          disabled={!last || !findPreviewIframe()}
          title={
            !last
              ? 'No transitions found in this project.'
              : !findPreviewIframe()
                ? 'Open the interactive preview to replay.'
                : `Replay "${last.value}" at 0.25x speed.`
          }
        >
          {last ? `Play "${last.value}" at 0.25x` : 'Play last'}
        </button>
      </div>

      {error && <div className="transitions-error">{error}</div>}

      <div className="transitions-graph-wrap">
        <GraphSvg graph={graph} laid={laid} selected={selectedNode} onSelect={setSelectedNode} />
      </div>

      <div className="transitions-section">
        <div className="transitions-section-title">Shared names</div>
        {graph.edges.length === 0 ? (
          <div className="transitions-empty">No pages share a transition:name yet.</div>
        ) : (
          <ul className="transitions-edge-list">
            {graph.edges.map((e, i) => (
              <li key={`${e.from}-${e.to}-${e.name}-${i}`} className="transitions-edge-row">
                <span className="transitions-edge-name">{e.name}</span>
                <span className="transitions-edge-sides">
                  {e.from.replace(/^src\/pages\//, '')} ⇄ {e.to.replace(/^src\/pages\//, '')}
                </span>
                {e.occurrences && (
                  <span className="transitions-edge-count">
                    {e.occurrences.a || 0}× / {e.occurrences.b || 0}×
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="transitions-section">
        <div className="transitions-section-title">All transitions</div>
        {loading ? (
          <div className="transitions-empty">Scanning…</div>
        ) : scan.transitions.length === 0 ? (
          <div className="transitions-empty">
            No transitions found. Add <code>transition:name="hero"</code> to a page to get started.
          </div>
        ) : (
          <ul className="transitions-list">
            {scan.transitions.map((t, i) => (
              <li key={i} className="transitions-row">
                <span className={`transitions-kind kind-${t.kind}`}>
                  {t.kind === 'vt-name' ? 'vt-name' : t.kind}
                </span>
                <span className="transitions-value">{t.value}</span>
                <span className="transitions-page">{t.page?.rel || ''}</span>
                <span className="transitions-loc">L{t.line || 0}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="transitions-section">
        <div className="transitions-section-title">
          Live event log
          <span className="transitions-section-hint">
            {logActive ? 'listening' : 'paused'}
          </span>
        </div>
        {events.length === 0 ? (
          <div className="transitions-empty">
            {logActive
              ? 'Navigate the preview to see astro:transitions events stream in.'
              : 'Click "Watch live events" to start capturing transitions.'}
          </div>
        ) : (
          <ul className="transitions-event-list">
            {events
              .slice()
              .reverse()
              .map((e, i) => (
                <li key={i} className="transitions-event-row">
                  <span className="transitions-event-name">{e.name || 'event'}</span>
                  {e.from && e.to && (
                    <span className="transitions-event-route">
                      {e.from} → {e.to}
                    </span>
                  )}
                  {e.path && <span className="transitions-event-route">{e.path}</span>}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GraphSvg({ graph, laid, selected, onSelect }) {
  const { width, height, positions } = laid;

  // A small inset for the SVG so edge labels don't clip on the viewBox.
  return (
    <svg
      className="transitions-graph"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Page transition graph"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker
          id="transitions-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-faint)" />
        </marker>
      </defs>

      {/* Edges first so node circles draw on top of their labels. */}
      {graph.edges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const highlight = selected && (e.from === selected || e.to === selected);
        return (
          <g key={`e-${i}`} className={`transitions-edge ${highlight ? 'highlight' : ''}`}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              markerEnd="url(#transitions-arrow)"
            />
            <text x={mid.x} y={mid.y - 4} textAnchor="middle" className="transitions-edge-label">
              {e.name}
            </text>
          </g>
        );
      })}

      {graph.nodes.map((n) => {
        const p = positions.get(n.id);
        if (!p) return null;
        const isSelected = selected === n.id;
        const hasName = n.transitionCount > 0;
        return (
          <g
            key={n.id}
            className={`transitions-node ${isSelected ? 'selected' : ''} ${
              hasName ? 'has-name' : 'isolated'
            }`}
            transform={`translate(${p.x}, ${p.y})`}
            onClick={() => onSelect(isSelected ? null : n.id)}
          >
            <circle r={hasName ? 10 : 6} />
            <text y={hasName ? 24 : 20} textAnchor="middle" className="transitions-node-label">
              {n.name || n.rel}
            </text>
            {n.route && (
              <text y={hasName ? 38 : 34} textAnchor="middle" className="transitions-node-route">
                {n.route}
              </text>
            )}
            <title>{`${n.rel}${n.route ? ` (${n.route})` : ''}`}</title>
          </g>
        );
      })}

      {graph.nodes.length === 0 && (
        <text x={width / 2} y={height / 2} textAnchor="middle" className="transitions-empty-label">
          No pages yet
        </text>
      )}
    </svg>
  );
}
