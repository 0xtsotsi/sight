// src/panels/ChatList.jsx
//
// Renders the chat list with ⌘1-⌘9 jump happening at the hook level.
// Each entry is a button that sets the active chat.
//
// The list is intentionally un-virtualized (per the plan: only the
// message list uses TanStack). Even at 100 chats the list is a few
// hundred pixels tall and React's reconciler handles it cheaply.

import React from 'react';

export default function ChatList({ chats, activeIndex, onSelect, onClose, onNew }) {
  if (!chats || chats.length === 0) return null;
  return (
    <div className="chat-list" data-testid="chat-list">
      {chats.map((c, i) => (
        <div
          key={c.id}
          className={`chat-list-item ${i === activeIndex ? 'active' : ''}`}
          data-testid={`chat-list-${i}`}
          data-active={i === activeIndex}
        >
          <button
            type="button"
            className="chat-list-select"
            onClick={() => onSelect(i)}
            aria-label={`Select chat ${i + 1}`}
          >
            <span className="chat-list-num">{i + 1}</span>
            <span className="chat-list-preview">
              {c.turns && c.turns.length > 0
                ? (c.turns[c.turns.length - 1].content || '').slice(0, 60)
                : 'New chat'}
            </span>
          </button>
          {chats.length > 1 && (
            <button
              type="button"
              className="chat-list-close"
              onClick={() => onClose(i)}
              aria-label={`Close chat ${i + 1}`}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="chat-list-new"
        onClick={onNew}
        data-testid="chat-list-new"
        aria-label="New chat"
      >
        + New
      </button>
    </div>
  );
}
