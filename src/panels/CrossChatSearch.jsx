// src/panels/CrossChatSearch.jsx
//
// ⌘⇧I — search across all chats. Renders a popover with a query input
// and the matching turns in chat order. Selecting an entry jumps to
// the chat and shows the matched turn.

import React, { useEffect, useMemo, useRef, useState } from 'react';

export default function CrossChatSearch({ chats, onPickChat, onClose }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    chats.forEach((chat, chatIdx) => {
      (chat.turns || []).forEach((t, turnIdx) => {
        const text = (t.content || '').toLowerCase();
        const idx = text.indexOf(q);
        if (idx >= 0) {
          out.push({
            chatIdx,
            turnIdx,
            content: t.content,
            role: t.role,
            preview: t.content.slice(Math.max(0, idx - 30), idx + 60),
          });
        }
      });
    });
    return out;
  }, [chats, query]);

  return (
    <div className="cross-chat-search" data-testid="cross-chat-search">
      <div className="cross-chat-search-row">
        <span className="cross-chat-search-tag">⌘⇧I</span>
        <input
          ref={inputRef}
          className="cross-chat-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose?.();
            }
          }}
          placeholder="search across all chats"
        />
      </div>
      {matches.length > 0 && (
        <ul className="cross-chat-search-list">
          {matches.slice(0, 50).map((m, i) => (
            <li key={`${m.chatIdx}-${m.turnIdx}-${i}`}>
              <button
                type="button"
                className="cross-chat-search-item"
                onClick={() => onPickChat?.(m.chatIdx)}
                data-testid={`cross-chat-match-${m.chatIdx}-${m.turnIdx}`}
              >
                <span className="cross-chat-search-chat">{m.chatIdx + 1}</span>
                <span className="cross-chat-search-role">{m.role}</span>
                <span className="cross-chat-search-preview">{m.preview}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
