import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { buildRegistry, filter, COMMAND_GROUPS } from './command-registry.js';
import {
  CommandIcon,
  CloseIconSm,
  iconForGroup,
} from './icons/cmdk-icons.jsx';

// Maximum rendered rows per group. The registry can be unbounded (hundreds of
// .astro files in a real project), so we keep the DOM bounded with a small
// overscan and a scrollable list. cmdk doesn't virtualize natively — its docs
// recommend `shouldFilter={false}` + a manual windowed render, which is what
// this does.
const MAX_ROWS_PER_GROUP = 50;

// Modal ⌘K palette. Renders nothing when closed. Controlled externally by
// nothing — it owns its own open/close state and listens for ⌘K / Ctrl+K.
//
// Props mirror the registry context the App orchestrator already manages:
// pass the project, page model, selection id, settings, recents, and the
// callbacks the registry needs to actually execute commands.
export default function CommandPalette({
  project,
  page,
  model,
  selection,
  settings,
  recents,
  actions,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  // Build the registry only when the context that drives its entries changes.
  // Inside that registry, `isAvailable` reads the pinned `_ctx`, so per-keystroke
  // filtering never needs to rebuild the array.
  const registry = useMemo(
    () =>
      buildRegistry({
        project,
        page,
        model,
        selection,
        settings,
        recents,
        actions,
      }),
    // We intentionally exclude `actions` — those are passed by reference and
    // change every render; rebuilding on every keystroke would tank perf.
    // Re-build when any of the data the registry enumerates changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, page, model, selection, settings?.device, settings?.inPreview, recents]
  );

  // Apply our own filtering (cheap, deterministic, group-aware) and then
  // window each group so very large projects stay snappy.
  const grouped = useMemo(() => {
    const matched = filter(registry, query);
    const buckets = {};
    for (const entry of matched) {
      (buckets[entry.group] ||= []).push(entry);
    }
    const out = [];
    for (const group of COMMAND_GROUPS) {
      const items = buckets[group];
      if (!items || items.length === 0) continue;
      out.push({ group, items: items.slice(0, MAX_ROWS_PER_GROUP) });
    }
    return out;
  }, [registry, query]);

  const totalMatches = useMemo(
    () => grouped.reduce((n, g) => n + g.items.length, 0),
    [grouped]
  );

  // Global ⌘K / Ctrl+K listener. preventDefault so the OS / Electron menu
  // accelerator doesn't also fire. stopPropagation so other listeners in the
  // app — including the ⌘F / ⌘E insert palette — don't react.
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key !== 'k' && e.key !== 'K') return;
      // Don't fight CodeMirror's own ⌘K (it binds it for clear-line in
      // editors on macOS). If focus is inside the editor, leave it alone.
      const t = e.target;
      if (t instanceof HTMLElement && t.closest('.cm-editor')) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((o) => !o);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Reset state every time we open, focus the input on the next tick so the
  // dialog has mounted.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const runEntry = useCallback(
    (entry) => {
      try {
        entry.perform();
      } catch (err) {
        // Perform errors shouldn't break the palette — log and close anyway.
        console.warn('Command palette entry failed:', entry.id, err);
      }
      setOpen(false);
    },
    []
  );

  if (!open) return null;

  return (
    <div
      className="cmdk-overlay"
      onMouseDown={(e) => {
        // Click on the dim overlay closes; clicks inside the modal don't
        // bubble up here.
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Command palette"
        shouldFilter={false}
        className="cmdk-modal"
      >
        <div className="cmdk-input-row">
          <CommandIcon size={14} style={{ color: 'var(--color-text-tertiary, #888)', marginRight: 8 }} />
          <Command.Input
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command, file, or node name…"
            className="cmdk-input"
            spellCheck={false}
          />
          <button
            type="button"
            className="cmdk-close"
            aria-label="Close"
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen(false);
            }}
          >
            <CloseIconSm size={12} />
          </button>
        </div>
        <Command.List className="cmdk-list">
          {totalMatches === 0 && (
            <Command.Empty className="cmdk-empty">
              {query ? `No matches for “${query}”.` : 'Nothing here yet — open a project to start.'}
            </Command.Empty>
          )}
          {grouped.map(({ group, items }) => {
            const GroupIcon = iconForGroup(group);
            return (
              <Command.Group key={group} heading={group} className="cmdk-group">
                <div className="cmdk-group-label">
                  <GroupIcon size={11} style={{ marginRight: 6, verticalAlign: -2 }} />
                  {group}
                </div>
                {items.map((entry) => (
                  <Command.Item
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => runEntry(entry)}
                    className="cmdk-item"
                  >
                    <span className="cmdk-item-label">{entry.label}</span>
                    {entry.hint && <span className="cmdk-item-hint">{entry.hint}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>
        <div className="cmdk-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="cmdk-footer-spacer" />
          <span>{totalMatches} {totalMatches === 1 ? 'result' : 'results'}</span>
        </div>
      </Command.Dialog>
    </div>
  );
}
