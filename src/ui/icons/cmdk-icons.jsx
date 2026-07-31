// Small inline SVG icons used only by the ⌘K command palette. currentColor
// only — colors come from the palette's own CSS so dark/light passes stay in
// sync with the existing design tokens. Matching the stroke-based look of
// `src/ui/Icons.jsx` without touching it.

import React from 'react';

const Wrap = ({ children, size = 14, strokeWidth = 1.4, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    {children}
  </svg>
);

// ⌘K — the command key glyph itself.
export const CommandIcon = (p) => (
  <Wrap {...p}>
    <path d="M5.5 2.5a2 2 0 1 1 0 4h5a2 2 0 1 0 0-4h-5z" />
    <path d="M5.5 6.5v5a2 2 0 1 1-4 0v-5a2 2 0 1 1 4 0z" />
    <path d="M10.5 6.5v5a2 2 0 1 0 4 0v-5a2 2 0 1 0-4 0z" />
    <path d="M5.5 11.5h5a2 2 0 1 1 0 4h-5a2 2 0 1 1 0-4z" />
  </Wrap>
);

export const ActionIcon = (p) => (
  <Wrap {...p}>
    <path d="m12.5 3.5-9 9M11 3.5h1.5V5" />
    <path d="M8.5 7.5l-1-1" />
  </Wrap>
);

export const FileIconSm = (p) => (
  <Wrap {...p}>
    <path d="M4.5 1.75h4.4l3.1 3.1v9.15a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V2.25a.5.5 0 0 1 .5-.5Z" />
    <path d="M8.9 1.9v3h3" />
  </Wrap>
);

export const ComponentIconSm = (p) => (
  <Wrap {...p}>
    <rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.8" transform="rotate(45 8 8)" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
  </Wrap>
);

export const SparklesIcon = (p) => (
  <Wrap {...p}>
    <path d="M5.5 2.5l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8z" />
    <path d="M11 8l.5 1.5 1.5.5-1.5.5L11 12l-.5-1.5L9 10l1.5-.5z" />
  </Wrap>
);

export const RocketIcon = (p) => (
  <Wrap {...p}>
    <path d="M10.5 2.5c2 0 3 1 3 3-.5 3-2.5 5.5-5 7l-1.5-1.5c1.5-2.5 4-4.5 7-5z" />
    <path d="M6 10l-2.5 2.5L2 11l2.5-2.5" />
    <path d="M9 5.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0z" fill="currentColor" stroke="none" />
  </Wrap>
);

export const CloseIconSm = (p) => (
  <Wrap {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Wrap>
);

// Returns the right icon for a group label, with a sensible default. Pure
// helper so the palette can be tested without rendering.
export const iconForGroup = (group) => {
  switch (group) {
    case 'Actions':
      return ActionIcon;
    case 'Files':
      return FileIconSm;
    case 'Nodes':
      return ComponentIconSm;
    case 'AI':
      return SparklesIcon;
    case 'Deploy':
      return RocketIcon;
    default:
      return CommandIcon;
  }
};
