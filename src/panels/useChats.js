// src/panels/useChats.js
//
// Hook for the parallel-chats feature. Each chat owns:
//   - turns: Turn[]
//   - busy: boolean
//   - abort: AbortController | null
//   - model: 'anthropic' | 'openai' | 'gemini' | 'claudeCode'
//   - thinking: 'off' | 'low' | 'medium' | 'high'
//   - undoStack: Turn[][]
//   - redoStack: Turn[][]
//
// Returns `chats`, `activeIndex`, `newChat`, `closeChat`, `setActive`,
// `updateActive`, `commitTurns`, `undo`, `redo`, `recordBusy`.
//
// The hook isolates the per-chat state so the AgentPanel can be cloned
// per chat without re-rendering the whole app tree.

import { useCallback, useEffect, useRef, useState } from 'react';

let counter = 0;
function newChatId() {
  counter += 1;
  return `chat-${Date.now().toString(36)}-${counter}`;
}

function makeChat(initial = {}) {
  return {
    id: newChatId(),
    turns: [],
    busy: false,
    abort: null,
    model: 'anthropic',
    thinking: 'off',
    undoStack: [],
    redoStack: [],
    ...initial,
  };
}

export function useChats(initialChats = []) {
  const [chats, setChats] = useState(initialChats.length > 0 ? initialChats : [makeChat()]);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(activeIndex);
  activeRef.current = activeIndex;

  const newChat = useCallback(() => {
    setChats((prev) => [...prev, makeChat()]);
    setActiveIndex((cur) => Math.max(0, chats.length));
  }, [chats.length]);

  const closeChat = useCallback((idx) => {
    setChats((prev) => {
      const target = prev[idx];
      if (target?.busy) target.abort?.abort?.();
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        const fresh = makeChat();
        setActiveIndex(0);
        return [fresh];
      }
      setActiveIndex((cur) => Math.min(cur, next.length - 1));
      return next;
    });
  }, []);

  const setActive = useCallback((idx) => {
    setActiveIndex(Math.max(0, Math.min(chats.length - 1, idx)));
  }, [chats.length]);

  const updateActive = useCallback((updater) => {
    setChats((prev) => {
      const idx = activeRef.current;
      const next = prev.slice();
      next[idx] = { ...next[idx], ...updater(next[idx], idx) };
      return next;
    });
  }, []);

  const commitTurns = useCallback((nextTurns) => {
    setChats((prev) => {
      const idx = activeRef.current;
      const cur = prev[idx];
      const undoStack = [...cur.undoStack.slice(-49), cur.turns];
      const next = prev.slice();
      next[idx] = { ...cur, turns: nextTurns, undoStack, redoStack: [] };
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setChats((prev) => {
      const idx = activeRef.current;
      const cur = prev[idx];
      if (cur.undoStack.length === 0) return prev;
      const previous = cur.undoStack[cur.undoStack.length - 1];
      const undoStack = cur.undoStack.slice(0, -1);
      const redoStack = [...cur.redoStack, cur.turns];
      const next = prev.slice();
      next[idx] = { ...cur, turns: previous, undoStack, redoStack };
      return next;
    });
  }, []);

  const redo = useCallback(() => {
    setChats((prev) => {
      const idx = activeRef.current;
      const cur = prev[idx];
      if (cur.redoStack.length === 0) return prev;
      const next_ = cur.redoStack[cur.redoStack.length - 1];
      const redoStack = cur.redoStack.slice(0, -1);
      const undoStack = [...cur.undoStack, cur.turns];
      const next = prev.slice();
      next[idx] = { ...cur, turns: next_, undoStack, redoStack };
      return next;
    });
  }, []);

  const recordBusy = useCallback((busy, abort = null) => {
    setChats((prev) => {
      const idx = activeRef.current;
      const cur = prev[idx];
      const next = prev.slice();
      next[idx] = { ...cur, busy, abort };
      return next;
    });
  }, []);

  // ⌘1-⌘9 — jump to chat index n. Bound at the App level.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10) - 1;
        if (n < chats.length) {
          setActiveIndex(n);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chats.length]);

  return {
    chats,
    activeIndex,
    newChat,
    closeChat,
    setActive,
    updateActive,
    commitTurns,
    undo,
    redo,
    recordBusy,
  };
}
